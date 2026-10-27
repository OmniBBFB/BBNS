import { fault, invalid } from './errors.mjs';
import { randomUUID } from 'node:crypto';
import { validateSourceMessage } from './source-message.mjs';

/** Executes once. Adapters and clock are injected; never imports storage or a scheduler. */
export class CollectionExecutor {
  constructor(adapters, { clock = () => new Date().toISOString() } = {}) {
    this.adapters = adapters;
    this.clock = clock;
  }
  async execute(requests, { signal } = {}) {
    const run = { run_id: randomUUID(), started_at: this.clock(), finished_at: null, results: [], messages: [] };
    for (const request of requests) {
      const startedAt = this.clock();
      try {
        signal?.throwIfAborted();
        if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) throw invalid('limit must be 1..1000', 'collection.request');
        const adapter = this.adapters[request.adapter];
        if (!adapter) throw invalid(`Unknown adapter: ${request.adapter}`, 'collection.request');
        const result = await adapter.collect(request, { fetched_at: startedAt, signal });
        signal?.throwIfAborted();
        if (!Array.isArray(result.messages)) throw invalid('Adapter must return messages', 'collection.output');
        for (const message of result.messages) {
          try { validateSourceMessage(message); } catch (error) { throw invalid(error.message, 'collection.output'); }
          if (message.source_id !== request.source_id) throw invalid('Adapter source mismatch', 'collection.output');
        }
        run.messages.push(...result.messages);
        run.results.push({ source_id: request.source_id, status: 'succeeded', count: result.messages.length,
          truncated: result.truncated ?? false, metadata: result.metadata ?? {}, started_at: startedAt, finished_at: this.clock() });
      } catch (error) {
        run.results.push({ source_id: request.source_id, status: 'failed', count: 0,
          error: { ...fault(error, { operation: 'collection.execute', ...(signal?.aborted ? { kind: 'cancelled' } : {}) }), retry_after: error?.retry_after ?? null },
          started_at: startedAt, finished_at: this.clock() });
      }
    }
    run.finished_at = this.clock();
    return run;
  }
}
