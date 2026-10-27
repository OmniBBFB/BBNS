import { DatabaseSync } from 'node:sqlite';

/** Read-only projection of current event state. Never creates a database or invokes a model. */
export class ContentReader {
  constructor(path) { this.path = path; }
  story(id) {
    if (!/^s_[a-f0-9]{32}$/.test(id)) return null;
    let db;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      const story = db.prepare('SELECT id,title FROM stories WHERE id=?').get(id);
      if (!story) return null;
      const reports = db.prepare(`SELECT m.fact_id,m.fact_index,m.extraction_json,m.decision_json,r.id revision_id,
        r.version,r.message_json,r.created_at,a.current_revision FROM memberships m JOIN facts f ON f.id=m.fact_id
        JOIN revisions r ON r.id=m.revision_id JOIN materials a ON a.id=r.material_id WHERE f.story_id=? ORDER BY r.created_at,r.id,m.fact_index`).all(id);
      return { ...story, state: 'current', reports: reports.map(row => {
        const source = JSON.parse(row.message_json), fact = JSON.parse(row.extraction_json), decision = JSON.parse(row.decision_json);
        return { fact_id: row.fact_id, revision_id: row.revision_id, version: row.version, superseded: row.current_revision !== row.revision_id, fact,
          relation: decision.relation, progress: decision.progress, comparison: decision.comparison,
          source: { source_id: source.source_id, title: source.title, url: source.url, published_at: source.published_at,
            fetched_at: source.fetched_at } };
      }) };
    } finally { db?.close(); }
  }
}
