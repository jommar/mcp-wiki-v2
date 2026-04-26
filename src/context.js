// src/context.js - Per-request async context (wiki_id from authenticated API key)
import { AsyncLocalStorage } from 'node:async_hooks';
export const requestContext = new AsyncLocalStorage();
