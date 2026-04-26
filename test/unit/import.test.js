import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllSections, validateFrontmatter } from '../../src/import.js';

// ─── parseAllSections ────────────────────────────────────────────────────────

describe('parseAllSections', () => {
  const singleSection = `---
key: test-section
parent: Test Topic
title: Test Section
tags: [test, demo]
---
This is the section body.

---

`;

  const multiSection = `---
key: section-one
parent: Topic A
title: Section One
---
Body one.
---
key: section-two
parent: Topic B
title: Section Two
---
Body two.
`;

  const wikiIdOverride = `---
key: test-override
parent: Topic
title: Test Override
wiki_id: custom-wiki
---
Override body.
`;

  it('parses a single section with frontmatter and body', () => {
    const result = parseAllSections(singleSection);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].frontmatter.key, 'test-section');
    assert.equal(result[0].frontmatter.parent, 'Test Topic');
    assert.equal(result[0].frontmatter.title, 'Test Section');
    assert.deepEqual(result[0].frontmatter.tags, ['test', 'demo']);
    assert.equal(result[0].body, 'This is the section body.');
  });

  it('parses multiple sections in a single file', () => {
    const result = parseAllSections(multiSection);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].frontmatter.key, 'section-one');
    assert.equal(result[0].body, 'Body one.');
    assert.equal(result[1].frontmatter.key, 'section-two');
    assert.equal(result[1].body, 'Body two.');
  });

  it('preserves wiki_id field in frontmatter', () => {
    const result = parseAllSections(wikiIdOverride);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0].frontmatter.wiki_id, 'custom-wiki');
  });

  it('handles quoted values in frontmatter', () => {
    const content = `---
key: quoted-key
parent: "My Topic"
title: "My Title"
---
Body.
`;
    const result = parseAllSections(content);
    assert.ok(result);
    assert.equal(result[0].frontmatter.parent, 'My Topic');
    assert.equal(result[0].frontmatter.title, 'My Title');
  });

  it('handles empty tags array', () => {
    const content = `---
key: no-tags
parent: Topic
title: No Tags
tags: []
---
Body.
`;
    const result = parseAllSections(content);
    assert.ok(result);
    assert.deepEqual(result[0].frontmatter.tags, []);
  });

  it('returns null for content with no valid frontmatter', () => {
    const result = parseAllSections('Just some text without frontmatter.');
    assert.equal(result, null);
  });

  it('returns null for content with frontmatter missing key field', () => {
    const content = `---
title: No Key
parent: Topic
---
Body.
`;
    const result = parseAllSections(content);
    assert.equal(result, null);
  });

  it('handles consecutive sections without extra separators', () => {
    const content = `---
key: trailing
parent: Topic
title: Trailing Sep
---
Body content.
---
key: next
parent: Topic
title: Next
---
Next body.
`;
    const result = parseAllSections(content);
    assert.ok(result);
    assert.equal(result.length, 2);
    assert.equal(result[0].body, 'Body content.');
    assert.equal(result[1].body, 'Next body.');
  });
});

// ─── validateFrontmatter ─────────────────────────────────────────────────────

describe('validateFrontmatter', () => {
  it('returns null for valid frontmatter', () => {
    assert.equal(validateFrontmatter({ key: 'my-key', parent: 'Topic', title: 'Title' }), null);
  });

  it('returns error for missing key', () => {
    assert.match(validateFrontmatter({ parent: 'Topic', title: 'Title' }), /Missing.*key/i);
  });

  it('returns error for missing parent', () => {
    assert.match(validateFrontmatter({ key: 'my-key', title: 'Title' }), /Missing.*parent/i);
  });

  it('returns error for missing title', () => {
    assert.match(validateFrontmatter({ key: 'my-key', parent: 'Topic' }), /Missing.*title/i);
  });

  it('returns error for invalid key format', () => {
    assert.match(validateFrontmatter({ key: 'Invalid Key!', parent: 'Topic', title: 'Title' }), /invalid key format/i);
  });

  it('accepts keys with proper lowercase-hyphen format', () => {
    assert.equal(validateFrontmatter({ key: 'valid-key-123', parent: 'Topic', title: 'Title' }), null);
  });
});
