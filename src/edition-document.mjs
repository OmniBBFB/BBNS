import { invalid } from './errors.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const quote = value => object(value) && typeof value.text === 'string' && Number.isInteger(value.start) && Number.isInteger(value.end) && value.start >= 0 && value.end > value.start;
/** Validation shared by archived v2 reading and publication; legacy documents keep their own contract. */
export function validateEditionDocument(document) {
  if (document?.schema_version !== 2 || !object(document.edition) || !instant(document.edition.window_start) ||
      !instant(document.edition.window_end) || Date.parse(document.edition.window_start) >= Date.parse(document.edition.window_end) ||
      !Array.isArray(document.items)) throw invalid('Invalid edition document', 'edition.document');
  for (const item of document.items) {
    if (!object(item.material) || typeof item.material.id !== 'string' || typeof item.material.revision_id !== 'string' ||
        !instant(item.material.first_discovered_at) || !instant(item.material.processed_at) || !Array.isArray(item.facts) ||
        !Array.isArray(item.tracking) || !Array.isArray(item.extraction_issues)) throw invalid('Invalid edition item', 'edition.document');
    for (const fact of item.facts) if (!object(fact) || typeof fact.title !== 'string' || !quote(fact.evidence) ||
        !Array.isArray(fact.conditions) || !fact.conditions.every(quote)) throw invalid('Invalid archived fact', 'edition.document');
    for (const entry of item.tracking) if (!object(entry) || !/^s_[a-f0-9]{32}$/.test(entry.story_id) ||
        !/^f_[a-f0-9]{32}$/.test(entry.fact_id) || typeof entry.relation !== 'string' ||
        !(entry.progress == null || typeof entry.progress === 'string')) throw invalid('Invalid archived relationship', 'edition.document');
  }
  return document;
}
