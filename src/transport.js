// src/transport.js - Production-grade transport layer
// Handles stdio (local) and HTTP (remote) with auth, health checks, CORS,
// graceful shutdown, structured error responses, and request logging.

import { logger } from '../logger.js';
import { authenticateToken, touchKey } from './auth.js';
import { requestContext } from './context.js';
import { getClientPool } from './client-pool.js';

const STARTED_AT = Date.now();

// ─── Constants ──────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

const DEFAULT_PORT = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// When TRUST_PROXY=true, read the real client IP from X-Forwarded-For.
// Only enable when running behind a known proxy; the header is trivially spoofable otherwise.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

export function resolveClientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute rolling window
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const rateLimitMap = new Map(); // ip → { count, windowStart }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 0, windowStart: now });
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 300_000).unref();

// ─── Helpers ────────────────────────────────────────────────────────────────────

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── HTTP Transport ─────────────────────────────────────────────────────────────

async function startHttp(server) {
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const PORT = parseInt(process.env.PORT, 10) || DEFAULT_PORT;

  const httpServer = http.createServer((req, res) => {
    const start = Date.now();
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    const clientIp = resolveClientIp(req);

    // Per-request timeout
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
    });

    // CORS headers on every response
    setCors(res);
    res.setHeader('X-Request-Id', requestId);

    // Log non-200 responses on finish
    res.on('finish', () => {
      logger.info('http request', {
        requestId,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: `${Date.now() - start}ms`,
        ip: clientIp,
      });
    });

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check — no auth required
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
        auth: 'api-key',
      });
      return;
    }

    // Rate limiting: check before auth
    if (isRateLimited(clientIp)) {
      logger.warn('Rate limit exceeded', { requestId, ip: clientIp });
      json(res, 429, {
        error: 'Too Many Requests',
        message: 'Too many failed auth attempts. Try again later.',
      });
      return;
    }

    // Auth: verify bearer token against admin DB, get client wiki_id from key name
    const rawAuth = req.headers['authorization'];
    const token = rawAuth?.startsWith('Bearer ') ? rawAuth.slice(7) : null;

    authenticateToken(token)
      .then(async (auth) => {
        if (!auth) {
          recordAuthFailure(clientIp);
          json(res, 401, { error: 'Unauthorized', message: 'Invalid or missing API key' });
          return;
        }

        if (req.method !== 'POST') {
          json(res, 405, { error: 'Method Not Allowed' });
          return;
        }

        // Get (or create) the client's isolated DB pool, running migrations on first use
        let clientPool;
        try {
          clientPool = await getClientPool(auth.name);
        } catch {
          json(res, 503, { error: 'Service Unavailable', message: 'Client database unavailable' });
          return;
        }

        touchKey(auth.name).catch(() => {});

        // Thread the client pool and wiki_id through async request handling
        requestContext.run({ wikiId: auth.name, pool: clientPool, readonly: auth.readonly }, () => {
          readBody(req)
            .then((raw) => {
              let parsed;
              try {
                parsed = raw ? JSON.parse(raw) : {};
              } catch {
                json(res, 400, { error: 'Bad Request', message: 'Invalid JSON body' });
                return;
              }
              return transport.handleRequest(req, res, parsed);
            })
            .catch((err) => {
              if (!res.headersSent) {
                json(res, 500, { error: 'Internal Server Error', message: err.message });
              }
            });
        });
      })
      .catch((err) => {
        if (!res.headersSent) {
          json(res, 500, { error: 'Internal Server Error', message: err.message });
        }
      });
  });

  // Server-level settings
  httpServer.keepAliveTimeout = 5000;
  httpServer.headersTimeout = 6000;

  await new Promise((resolve, reject) => {
    httpServer.listen(PORT, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  logger.warn(
    'HTTP mode: TLS is not configured. Bearer tokens (wk_v2_*) are transmitted in plaintext. Run behind a TLS-terminating reverse proxy (nginx, Caddy) for production.',
  );

  logger.info('MCP server listening', { transport: 'http', port: PORT, auth: 'api-key' });

  return httpServer;
}

// ─── Stdio Transport ────────────────────────────────────────────────────────────

async function startStdio(server) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected', { transport: 'stdio' });
  return null; // No server to shut down
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/** Connect the MCP server using the transport specified by TRANSPORT env var.
 *  Returns the HTTP server instance (for graceful shutdown) or null for stdio. */
export function connect(server) {
  const mode = process.env.TRANSPORT || 'stdio';

  if (mode === 'http') {
    return startHttp(server);
  }
  return startStdio(server);
}
