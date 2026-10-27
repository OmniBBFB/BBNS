import { boundary } from './errors.mjs';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateSourceMessage } from './source-message.mjs';

/** Temporary backend implementation. Append-only; intentionally no deduplication. */
export class JsonlMessageStore {
  constructor(path) { this.path = resolve(path); this.pending = Promise.resolve(); }
  async save(messages) {
    return boundary('collection.legacy-store.save', async () => {
    messages.forEach(validateSourceMessage);
    const text = messages.map(m => JSON.stringify(m) + '\n').join('');
    const operation = this.pending.then(async () => {
      if (text) { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, text, 'utf8'); }
      return { count: messages.length, path: this.path };
    });
    this.pending = operation.catch(() => {});
    return operation;
    }, { kind: 'storage', outcome: 'unknown' });
  }
}
