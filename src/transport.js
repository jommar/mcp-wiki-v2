// src/transport.js - Production-grade transport layer
// Handles stdio (local) and HTTP (remote) with auth, health checks, CORS,
// graceful shutdown, structured error responses, and request logging.

import { logger } from '../logger.js';
import { authenticateToken, touchKey } from './auth.js';
import { requestContext } from './context.js';
import { getClientPool } from './client-pool.js';

const STARTED_AT = Date.now();

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

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
// TODO(https): This server speaks plain HTTP. For production with real clients,
// run behind a TLS-terminating reverse proxy (nginx, Caddy) or switch the
// http.createServer call to https.createServer with a cert/key pair.
// Bearer tokens are exposed in plaintext without TLS.
//
// TODO(rate-limiting): No brute-force protection on auth failures. Before
// going public, add a per-IP failed-auth counter (e.g. in a Map with a
// rolling window) and return 429 after N failures within the window.

async function startHttp(server) {
  const {
    StreamableHTTPServerTransport,
  } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const PORT = parseInt(process.env.PORT, 10) || DEFAULT_PORT;

  const httpServer = http.createServer((req, res) => {
    const start = Date.now();

    // Per-request timeout
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
    });

    // CORS headers on every response
    setCors(res);

    // Log non-200 responses on finish
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        logger.warn('http request', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${Date.now() - start}ms`,
          ip: req.socket?.remoteAddress,
        });
      }
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

    // Auth: verify bearer token against admin DB, get client wiki_id from key name
    const rawAuth = req.headers['authorization'];
    const token = rawAuth?.startsWith('Bearer ') ? rawAuth.slice(7) : null;

    authenticateToken(token)
      .then(async (auth) => {
        if (!auth) {
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

  logger.info('MCP server listening', { transport: 'http', port: PORT, auth: 'api-key' });

  return httpServer;
}

// ─── Stdio Transport ────────────────────────────────────────────────────────────

async function startStdio(server) {
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected', { transport: 'stdio' });
  return null; // No server to shut down
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/** Connect the MCP server using the transport specified by TRANSPORT env var.
 *  Returns the HTTP server instance (for graceful shutdown) or null for stdio. */
export async function connect(server) {
  const mode = process.env.TRANSPORT || 'stdio';

  if (mode === 'http') {
    return startHttp(server);
  }
  return startStdio(server);
}
