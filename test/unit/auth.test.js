import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Import the module fresh for each test suite
let flushAuthCache;
let authenticateToken;

before(async () => {
  const mod = await import('../../src/auth.js');
  flushAuthCache = mod.flushAuthCache;
  authenticateToken = mod.authenticateToken;
});

describe('flushAuthCache', () => {
  it('is a function that can be called without errors', () => {
    assert.equal(typeof flushAuthCache, 'function');
    // Multiple calls should be safe
    flushAuthCache();
    flushAuthCache();
    flushAuthCache();
  });
});

describe('authenticateToken', () => {
  it('returns null for non-wk_v2_ tokens', async () => {
    const result = await authenticateToken('invalid-token');
    assert.equal(result, null);
  });

  it('returns null for wk_v2_ tokens when admin module is unavailable', async () => {
    // The admin module (../admin/api-keys.js) won't be available in test,
    // so verifyKey will be null and auth should fail gracefully
    const result = await authenticateToken('wk_v2_test_token_12345');
    assert.equal(result, null);
  });

  it('handles null/undefined tokens gracefully', async () => {
    assert.equal(await authenticateToken(null), null);
    assert.equal(await authenticateToken(undefined), null);
  });
});
