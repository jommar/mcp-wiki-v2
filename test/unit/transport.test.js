import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// resolveClientIp reads TRUST_PROXY at module load time, so we test it by
// controlling the env var before importing and using the helper directly.

function makeReq({ socket, headers = {} } = {}) {
  return { socket: socket ?? { remoteAddress: '1.2.3.4' }, headers };
}

describe('resolveClientIp — TRUST_PROXY disabled (default)', () => {
  let resolveClientIp;

  beforeEach(async () => {
    delete process.env.TRUST_PROXY;
    // Re-import with a cache-busting query string so we always get a fresh module
    const mod = await import(`../../src/transport.js?trust=off&t=${Date.now()}`);
    resolveClientIp = mod.resolveClientIp;
  });

  it('returns socket remoteAddress', () => {
    const req = makeReq({ socket: { remoteAddress: '10.0.0.1' } });
    assert.equal(resolveClientIp(req), '10.0.0.1');
  });

  it('ignores X-Forwarded-For header', () => {
    const req = makeReq({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    assert.equal(resolveClientIp(req), '10.0.0.1');
  });

  it('returns "unknown" when socket is absent', () => {
    const req = { socket: null, headers: {} };
    assert.equal(resolveClientIp(req), 'unknown');
  });
});

describe('resolveClientIp — TRUST_PROXY enabled', () => {
  let resolveClientIp;

  beforeEach(async () => {
    process.env.TRUST_PROXY = 'true';
    const mod = await import(`../../src/transport.js?trust=on&t=${Date.now()}`);
    resolveClientIp = mod.resolveClientIp;
  });

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('returns first IP from X-Forwarded-For', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
    });
    assert.equal(resolveClientIp(req), '203.0.113.5');
  });

  it('strips whitespace from X-Forwarded-For value', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '  203.0.113.7  , 10.0.0.2' },
    });
    assert.equal(resolveClientIp(req), '203.0.113.7');
  });

  it('falls back to socket when X-Forwarded-For is absent', () => {
    const req = makeReq({ socket: { remoteAddress: '192.168.1.1' } });
    assert.equal(resolveClientIp(req), '192.168.1.1');
  });

  it('handles a single IP without comma', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    assert.equal(resolveClientIp(req), '1.1.1.1');
  });
});
