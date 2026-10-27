/** Subscription policy only: no networking, timers or persistence. */
export class Subscriptions {
  constructor(sources) {
    if (!Array.isArray(sources)) throw new Error('sources must be an array');
    const ids = new Set();
    for (const source of sources) {
      if (!source.id || ids.has(source.id)) throw new Error('Source IDs must be nonempty and unique');
      if (!source.adapter || typeof source.enabled !== 'boolean') throw new Error(`Invalid source: ${source.id}`);
      if (!Number.isInteger(source.limit) || source.limit < 1 || source.limit > 1000) throw new Error('limit must be 1..1000');
      ids.add(source.id);
    }
    this.sources = structuredClone(sources);
  }
  list() { return structuredClone(this.sources); }
  requests(sourceIds) {
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some(id => !this.sources.some(s => s.id === id)))) {
      throw new Error('Unknown source ID');
    }
    return this.sources.filter(s => s.enabled && (!sourceIds || sourceIds.includes(s.id)))
      .map(s => ({ source_id: s.id, adapter: s.adapter, limit: s.limit, options: structuredClone(s.options ?? {}) }));
  }
}
