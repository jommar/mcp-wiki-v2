import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateKey, validateField, Semaphore } from '../../src/service.js';

// ─── validateKey ─────────────────────────────────────────────────────────────

describe('validateKey', () => {
  it('accepts a valid lowercase-alphanumeric-hyphen key', () => {
    assert.equal(validateKey('portage-backend-architecture'), null);
  });

  it('rejects an empty key', () => {
    assert.match(validateKey(''), /cannot be empty/i);
  });

  it('rejects a whitespace-only key', () => {
    assert.match(validateKey('   '), /cannot be empty/i);
  });

  it('rejects a null/undefined key', () => {
    assert.match(validateKey(null), /cannot be empty/i);
    assert.match(validateKey(undefined), /cannot be empty/i);
  });

  it('rejects a key with uppercase letters', () => {
    assert.match(validateKey('MyKey'), /invalid key format/i);
  });

  it('rejects a key with special characters', () => {
    assert.match(validateKey('my key!'), /invalid key format/i);
    assert.match(validateKey('my_key'), /invalid key format/i);
    assert.match(validateKey('my.key'), /invalid key format/i);
  });

  it('rejects a key exceeding 255 characters', () => {
    const longKey = 'a'.repeat(256);
    assert.match(validateKey(longKey), /too long/i);
  });

  it('accepts a key at exactly 255 characters', () => {
    const exactKey = 'a'.repeat(255);
    assert.equal(validateKey(exactKey), null);
  });

  it('accepts single-character keys', () => {
    assert.equal(validateKey('a'), null);
    assert.equal(validateKey('0'), null);
  });

  it('accepts keys with multiple hyphens', () => {
    assert.equal(validateKey('a-b-c-d-e'), null);
  });
});

// ─── validateField ───────────────────────────────────────────────────────────

describe('validateField', () => {
  it('returns null for a field within length limits', () => {
    assert.equal(validateField('title', 'My Section Title', 500), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(validateField('title', '', 500), null);
  });

  it('returns null for undefined value', () => {
    assert.equal(validateField('title', undefined, 500), null);
  });

  it('returns null for null value', () => {
    assert.equal(validateField('title', null, 500), null);
  });

  it('rejects a field exceeding max length', () => {
    const err = validateField('title', 'x'.repeat(501), 500);
    assert.ok(err.includes('title too long'));
    assert.ok(err.includes('501'));
    assert.ok(err.includes('500'));
  });

  it('accepts a field at exactly max length', () => {
    assert.equal(validateField('parent', 'x'.repeat(255), 255), null);
  });

  it('uses the field name in the error message', () => {
    const err = validateField('reason', 'x'.repeat(101), 100);
    assert.ok(err.includes('reason too long'));
  });

  it('handles non-string values gracefully', () => {
    assert.equal(validateField('tags', ['a', 'b'], 500), null);
    assert.equal(validateField('count', 42, 500), null);
    assert.equal(validateField('flag', true, 500), null);
  });
});

// ─── Semaphore ───────────────────────────────────────────────────────────────

describe('Semaphore', () => {
  it('allows up to max concurrency', async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, () =>
      sem.run(() => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        return new Promise((r) => setTimeout(r, 10)).then(() => {
          concurrent--;
        });
      }),
    );
    await Promise.all(tasks);

    assert.equal(peak, 3, 'should never exceed 3 concurrent executions');
  });

  it('runs a single task when max = 1', async () => {
    const sem = new Semaphore(1);
    const order = [];

    const tasks = Array.from({ length: 3 }, (_, i) =>
      sem.run(() => {
        order.push(i);
        return new Promise((r) => setTimeout(r, 5));
      }),
    );
    await Promise.all(tasks);

    assert.deepEqual(order, [0, 1, 2]);
  });

  it('immediately runs tasks when below max concurrency', () => {
    const sem = new Semaphore(5);
    let ran = false;

    return sem
      .run(() => {
        ran = true;
      })
      .then(() => {
        assert.equal(ran, true);
      });
  });

  it('handles errors without breaking the semaphore', async () => {
    const sem = new Semaphore(2);

    await assert.rejects(
      sem.run(() => Promise.reject(new Error('task error'))),
      /task error/,
    );

    // Semaphore should still work after error
    const ok = await sem.run(() => Promise.resolve(true));
    assert.equal(ok, true);
  });

  it('can acquire and release directly', async () => {
    const sem = new Semaphore(1);

    await sem.acquire();
    assert.equal(sem.current, 1);

    sem.release();
    assert.equal(sem.current, 0);
  });
});
