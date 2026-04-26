import { pipeline } from '@xenova/transformers';
import { logger } from '../logger.js';

let extractor = null;
let loadingPromise = null;

/**
 * Lazily initialize the embedding pipeline.
 * The model is downloaded once and cached locally.
 * Handles concurrent calls by sharing the loading promise.
 */
function getExtractor() {
  if (extractor) {
    return extractor;
  }
  if (loadingPromise) {
    return loadingPromise;
  }
  loadingPromise = (async () => {
    logger.info('Loading embedding model (all-MiniLM-L6-v2)...');
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
    logger.info('Embedding model loaded');
    return extractor;
  })();
  return loadingPromise;
}

const MAX_EMBEDDING_INPUT = 2000;

/**
 * Generate a 384-dimensional embedding vector for the given text.
 * Input is truncated to MAX_EMBEDDING_INPUT chars to bound inference cost.
 * @param {string} text - The text to embed (title + content)
 * @returns {Promise<number[]>} 384-dim embedding vector
 */
export async function getEmbedding(text) {
  const truncated = text.length > MAX_EMBEDDING_INPUT ? text.slice(0, MAX_EMBEDDING_INPUT) : text;
  const ext = await getExtractor();
  const output = await ext(truncated, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}
