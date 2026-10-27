import { randomUUID } from 'node:crypto';

export function sourceMessage(sourceId, fields, fetchedAt) {
  const message = {
    schema_version: 1, id: randomUUID(), source_id: sourceId,
    source_item_id: null, kind: 'article', title: '', url: null,
    published_at: null, observed_at: null, fetched_at: fetchedAt,
    content: { text: '', format: 'text', completeness: 'summary' },
    source_signals: {}, data: {}, ...fields
  };
  validateSourceMessage(message);
  return message;
}

export function validateSourceMessage(m) {
  const string = v => typeof v === 'string';
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const date = v => v === null || (string(v) && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)));
  if (m?.schema_version !== 1 || !string(m.id) || !m.id || !string(m.source_id) || !m.source_id ||
      !(m.source_item_id === null || string(m.source_item_id)) ||
      !['article', 'ranking_entry', 'observation', 'alert'].includes(m.kind) || !string(m.title) || !m.title.trim() ||
      !(m.url === null || (string(m.url) && /^https?:\/\//.test(m.url))) ||
      !m.fetched_at || !date(m.fetched_at) || !date(m.published_at) || !date(m.observed_at) ||
      !object(m.content) || !string(m.content.text) || !['text', 'html', 'markdown'].includes(m.content.format) ||
      !['summary', 'full'].includes(m.content.completeness) || !object(m.source_signals) || !object(m.data)) {
    throw new Error('Invalid SourceMessage');
  }
  return m;
}
