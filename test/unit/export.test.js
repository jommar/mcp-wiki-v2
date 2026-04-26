import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, PassThrough } from 'node:stream';
import { yamlValue, buildFrontmatter } from '../../src/export.js';

// ─── yamlValue ───────────────────────────────────────────────────────────────

describe('yamlValue', () => {
  it('returns plain strings as-is', () => {
    assert.equal(yamlValue('hello'), 'hello');
  });

  it('wraps strings containing colons in double quotes', () => {
    assert.equal(yamlValue('key: value'), '"key: value"');
  });

  it('wraps strings containing hash in double quotes', () => {
    assert.equal(yamlValue('tag #1'), '"tag #1"');
  });

  it('wraps strings containing double quotes and escapes them', () => {
    assert.equal(yamlValue('say "hi"'), '"say \\"hi\\""');
  });

  it('serializes empty array as []', () => {
    assert.equal(yamlValue([]), '[]');
  });

  it('serializes string array with quoted elements', () => {
    assert.equal(yamlValue(['a', 'b']), '["a", "b"]');
  });

  it('serializes numbers via String()', () => {
    assert.equal(yamlValue(42), '42');
  });
});

// ─── buildFrontmatter ────────────────────────────────────────────────────────

describe('buildFrontmatter', () => {
  it('outputs required fields', () => {
    const result = buildFrontmatter({ key: 'my-key', parent: 'My Topic', title: 'My Title', tags: [] });
    assert.ok(result.includes('key: my-key'));
    assert.ok(result.includes('parent: My Topic'));
    assert.ok(result.includes('title: My Title'));
  });

  it('wraps output in --- delimiters', () => {
    const result = buildFrontmatter({ key: 'k', parent: 'P', title: 'T', tags: [] });
    assert.ok(result.startsWith('---'));
    assert.ok(result.endsWith('---'));
  });

  it('includes tags when non-empty', () => {
    const result = buildFrontmatter({ key: 'k', parent: 'P', title: 'T', tags: ['alpha', 'beta'] });
    assert.ok(result.includes('tags: ["alpha", "beta"]'));
  });

  it('omits tags line when tags is empty', () => {
    const result = buildFrontmatter({ key: 'k', parent: 'P', title: 'T', tags: [] });
    assert.ok(!result.includes('tags:'));
  });

  it('omits tags line when tags is null/undefined', () => {
    const result = buildFrontmatter({ key: 'k', parent: 'P', title: 'T' });
    assert.ok(!result.includes('tags:'));
  });

  it('defaults parent to Root when null', () => {
    const result = buildFrontmatter({ key: 'k', parent: null, title: 'T' });
    assert.ok(result.includes('parent: Root'));
  });
});

// ─── writeWhenReady — backpressure handling ──────────────────────────────────
//
// writeWhenReady is not exported, but we test the same logic directly here
// to verify the contract: resolves immediately on a fast stream, waits for
// 'drain' when write() returns false.

function writeWhenReady(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}

describe('writeWhenReady backpressure', () => {
  it('resolves immediately when stream accepts data without backpressure', async () => {
    const chunks = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });

    await writeWhenReady(stream, 'hello\n');
    await writeWhenReady(stream, 'world\n');
    assert.deepEqual(chunks, ['hello\n', 'world\n']);
  });

  it('waits for drain event before resolving when write() returns false', async () => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const order = [];

    // Mock stream: always signals backpressure, delegates events to emitter
    const mockStream = {
      write() { return false; },
      once(event, cb) { emitter.once(event, cb); },
    };

    const writePromise = writeWhenReady(mockStream, 'data').then(() => {
      order.push('resolved');
    });

    order.push('before-drain');
    emitter.emit('drain');
    await writePromise;
    order.push('after-await');

    assert.deepEqual(order, ['before-drain', 'resolved', 'after-await']);
  });

  it('rejects on stream error', async () => {
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();

    const mockStream = {
      write() { return false; },
      once(event, cb) { emitter.once(event, cb); },
    };

    const writePromise = writeWhenReady(mockStream, 'data');
    emitter.emit('error', new Error('disk full'));

    await assert.rejects(writePromise, /disk full/);
  });
});
