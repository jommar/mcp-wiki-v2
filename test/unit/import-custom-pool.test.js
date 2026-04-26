// test/unit/import-custom-pool.test.js — Tests for import/export functions with custom pool
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('importFile and processStaging — custom pool parameter', () => {
  it('export importFile and processStaging as functions', async () => {
    const mod = await import('../../src/import.js');
    assert.equal(typeof mod.importFile, 'function');
    assert.equal(typeof mod.processStaging, 'function');
  });
});

describe('exportWiki and exportAllWikis — custom pool parameter', () => {
  it('export exportWiki and exportAllWikis as functions', async () => {
    const mod = await import('../../src/export.js');
    assert.equal(typeof mod.exportWiki, 'function');
    assert.equal(typeof mod.exportAllWikis, 'function');
  });
});
