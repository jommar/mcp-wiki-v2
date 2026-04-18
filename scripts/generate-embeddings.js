import { Pool } from 'pg';
import { config } from 'dotenv';
import { logger } from '../logger.js';
import { getEmbedding } from '../src/embedding.js';

config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'wiki',
  password: process.env.DB_PASSWORD || 'wiki',
  database: process.env.DB_NAME || 'wiki',
});

async function generateEmbeddings(batchSize = 50) {
  let totalProcessed = 0;

  while (true) {
    const { rows } = await pool.query(
      `
      SELECT id, wiki_id, key, title, content
      FROM wiki_sections
      WHERE embedding IS NULL
      ORDER BY id
      LIMIT $1
    `,
      [batchSize],
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        // Truncate content to avoid token limits (first 2000 chars is usually enough)
        const text = `${row.title}\n${row.content.slice(0, 2000)}`;
        const embedding = await getEmbedding(text);

        await pool.query('UPDATE wiki_sections SET embedding = $1 WHERE id = $2', [
          JSON.stringify(embedding),
          row.id,
        ]);

        totalProcessed++;
        logger.info(`Embedded: ${row.wiki_id}/${row.key} (${totalProcessed} total)`);
      } catch (err) {
        logger.error(`Failed to embed ${row.wiki_id}/${row.key}`, { error: err.message });
      }
    }
  }

  return totalProcessed;
}

async function main() {
  console.log('\nWiki V2 Embedding Generator\n');

  const { rows: pending } = await pool.query(
    'SELECT COUNT(*) as count FROM wiki_sections WHERE embedding IS NULL',
  );
  console.log(`Sections without embeddings: ${pending[0].count}`);

  if (parseInt(pending[0].count) === 0) {
    console.log('All sections already have embeddings.\n');
    await pool.end();
    return;
  }

  const processed = await generateEmbeddings();
  console.log(`\nProcessed: ${processed} sections\n`);

  await pool.end();
}

main().catch((err) => {
  console.error('Embedding generation failed:', err);
  process.exit(1);
});
