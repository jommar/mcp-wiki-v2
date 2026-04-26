// test/unit/client-pool.test.js — Tests for per-client DB pool management
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('client-pool — module exports', () => {
  let mod;

  before(async () => {
    mod = await import('../../src/client-pool.js');
  });

  it('loads and exports expected functions', () => {
    assert.equal(typeof mod.releaseClientPool, 'function');
    assert.equal(typeof mod.drainAllPools, 'function');
    assert.equal(typeof mod.getPoolCount, 'function');
  });

  it('releaseClientPool returns false for non-existent pool', async () => {
    const result = await mod.releaseClientPool('nonexistent-pool');
    assert.equal(result, false);
  });

  it('drainAllPools handles empty pool map without error', async () => {
    await mod.drainAllPools();
  });

  it('getPoolCount returns a non-negative number', () => {
    const count = mod.getPoolCount();
    assert.equal(typeof count, 'number');
    assert.ok(count >= 0);
  });
});
