import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateSourceMessage } from './source-message.mjs';
import { businessDay } from './daily-store.mjs';
import { invalid } from './errors.mjs';

export const stableJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const contentHash = value => createHash('sha256').update(stableJson(value)).digest('hex');
const parse = value => value == null ? null : JSON.parse(value);
const id = (kind, value) => kind + '_' + contentHash(value).slice(0, 32);

export function materialIdentity(message, timezone = 'Asia/Shanghai') {
  const native = message.source_item_id || message.url || message.id;
  const period = message.kind === 'article' ? null : businessDay(message.observed_at ?? message.fetched_at, timezone);
  return id(message.kind === 'article' ? 'a' : 'o', [message.source_id, message.kind, native, period]);
}

/** Owns durable records; semantic association decisions are supplied by the caller. */
export class ContentStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, first_ingested_at TEXT NOT NULL, generation TEXT NOT NULL, configuration_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baseline_revisions (source_id TEXT NOT NULL, generation TEXT NOT NULL, revision_id TEXT NOT NULL, window_start TEXT,
        PRIMARY KEY(source_id,generation,revision_id));
      CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL,
        current_revision TEXT NOT NULL, first_discovered_at TEXT NOT NULL, latest_position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, material_id TEXT NOT NULL REFERENCES materials(id),
        version INTEGER NOT NULL, content_hash TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(material_id, content_hash), UNIQUE(material_id, version));
      CREATE TABLE IF NOT EXISTS discoveries (revision_id TEXT NOT NULL REFERENCES revisions(id), message_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL, PRIMARY KEY(revision_id, message_id));
      CREATE TABLE IF NOT EXISTS editions (id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, prepared_json TEXT,
        document_id TEXT UNIQUE, document_path TEXT, document_hash TEXT);
      CREATE TABLE IF NOT EXISTS edition_inputs (edition_id TEXT NOT NULL REFERENCES editions(id), ordinal INTEGER NOT NULL,
        revision_id TEXT NOT NULL REFERENCES revisions(id), reason TEXT NOT NULL,
        PRIMARY KEY(edition_id, ordinal), UNIQUE(edition_id, revision_id));
      CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id), title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (revision_id TEXT NOT NULL REFERENCES revisions(id), fact_index INTEGER NOT NULL,
        fact_id TEXT NOT NULL REFERENCES facts(id), extraction_json TEXT NOT NULL, decision_json TEXT NOT NULL,
        PRIMARY KEY(revision_id, fact_index));
      CREATE INDEX IF NOT EXISTS revisions_material ON revisions(material_id, version);
      CREATE INDEX IF NOT EXISTS membership_fact ON memberships(fact_id);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  edition(spec) {
    this.db.prepare('INSERT OR IGNORE INTO editions(id,spec_json) VALUES(?,?)').run(spec.id, stableJson(spec));
    const row = this.db.prepare('SELECT * FROM editions WHERE id=?').get(spec.id);
    if (row.spec_json !== stableJson(spec)) throw invalid('Edition input changed', 'content.edition');
    return row;
  }
  ingest(messages, { timezone = 'Asia/Shanghai', sourceVersion = '', baselineBefore = null } = {}) {
    return this.transaction(() => messages.map((message, position) => {
      validateSourceMessage(message);
      const materialId = materialIdentity(message, timezone);
      const fingerprint = { title: message.title, url: message.url, published_at: message.published_at,
        source_updated_at: message.data.source_updated_at ?? null, content: message.content,
        ...(message.kind === 'article' ? {} : { signals: message.source_signals }) };
      const hash = contentHash(fingerprint), revisionId = id('r', [materialId, hash]);
      let source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(message.source_id);
      const firstSource = !source;
      if (!source || source.configuration_hash !== sourceVersion) {
        const generation = contentHash([sourceVersion, message.fetched_at]);
        this.db.prepare('INSERT INTO sources VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET first_ingested_at=excluded.first_ingested_at, generation=excluded.generation, configuration_hash=excluded.configuration_hash')
          .run(message.source_id, message.fetched_at, generation, sourceVersion);
        source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(message.source_id);
      }
      if (message.fetched_at === source.first_ingested_at) this.db.prepare('INSERT OR IGNORE INTO baseline_revisions VALUES(?,?,?,?)').run(message.source_id, source.generation, revisionId, baselineBefore);
      const before = this.db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
      if (!before) this.db.prepare('INSERT INTO materials VALUES(?,?,?,?,?,?)')
        .run(materialId, message.source_id, message.kind, revisionId, message.fetched_at, position);
      else this.db.prepare('UPDATE materials SET current_revision=?, latest_position=? WHERE id=?').run(revisionId, position, materialId);
      const known = this.db.prepare('SELECT id FROM revisions WHERE id=?').get(revisionId);
      if (!known) {
        const version = this.db.prepare('SELECT coalesce(max(version),0)+1 n FROM revisions WHERE material_id=?').get(materialId).n;
        this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?)')
          .run(revisionId, materialId, version, hash, JSON.stringify(message), message.fetched_at);
      }
      this.db.prepare('INSERT OR IGNORE INTO discoveries VALUES(?,?,?)').run(revisionId, message.id, message.fetched_at);
      return { material_id: materialId, revision_id: revisionId, changed: !known, first_source: firstSource };
    }));
  }
  prepare(spec, sourceIds, { includeInitialHistory = false, preparedAt = new Date().toISOString() } = {}) {
    return this.transaction(() => {
      const edition = this.edition(spec);
      if (edition.prepared_json) return parse(edition.prepared_json);
      const items = [], reports = [];
      const preparedTime = Date.parse(preparedAt);
      for (const sourceId of sourceIds) {
        const counts = { known: 0, selected: 0, future: 0, already_issued: 0, initial_history: 0, undated: 0, undated_unusable: 0, late: 0 };
        const source = this.db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
        if (source) this.db.prepare('UPDATE baseline_revisions SET window_start=? WHERE source_id=? AND generation=? AND window_start IS NULL').run(spec.window_start, sourceId, source.generation);
        const rows = this.db.prepare(`SELECT r.*,m.kind,m.first_discovered_at FROM materials m
          JOIN revisions r ON r.id=m.current_revision WHERE m.source_id=? ORDER BY m.latest_position,m.id`).all(sourceId);
        for (const row of rows) {
          counts.known++;
          const message = parse(row.message_json);
          const issued = this.db.prepare(`SELECT 1 FROM edition_inputs i JOIN editions e ON e.id=i.edition_id
            WHERE i.revision_id=? AND e.document_id IS NOT NULL LIMIT 1`).get(row.id);
          if (issued) { counts.already_issued++; continue; }
          const time = message.kind === 'article' ? message.published_at : (message.observed_at ?? message.fetched_at);
          if (message.kind !== 'article') {
            if (Date.parse(time) > preparedTime || businessDay(time, spec.timezone) !== spec.business_date) { counts.future++; continue; }
          }
          let reason = 'window';
          if (message.kind === 'article' && time && (Date.parse(time) >= Date.parse(spec.window_end) || Date.parse(time) > preparedTime)) { counts.future++; continue; }
          if (!time) {
            counts.undated++;
            if (!message.url || !message.content.text.trim()) { counts.undated_unusable++; continue; }
            reason = 'undated';
          }
          else if (message.kind === 'article' && Date.parse(time) < Date.parse(spec.window_start)) {
            // The first feed fetch is a baseline, not evidence of a delayed live update.
            if (!includeInitialHistory && this.db.prepare('SELECT window_start FROM baseline_revisions WHERE source_id=? AND revision_id=?').all(sourceId, row.id).some(baseline => Date.parse(time) < Date.parse(baseline.window_start))) { counts.initial_history++; continue; }
            counts.late++; reason = 'late';
          }
          if (message.kind !== 'article' && time && Date.parse(time) < Date.parse(spec.window_start)) continue;
          items.push({ revision_id: row.id, material_id: row.material_id, version: row.version,
            first_discovered_at: row.first_discovered_at, reason, source: message });
          counts.selected++;
        }
        reports.push({ source_id: sourceId, count: counts.selected, status: counts.selected ? 'succeeded' : 'empty', counts });
      }
      const result = { spec, prepared_at: preparedAt, items, source_reports: reports };
      for (const [ordinal, item] of items.entries()) this.db.prepare('INSERT INTO edition_inputs VALUES(?,?,?,?)')
        .run(spec.id, ordinal, item.revision_id, item.reason);
      this.db.prepare('UPDATE editions SET prepared_json=? WHERE id=?').run(JSON.stringify(result), spec.id);
      return result;
    });
  }
  getResult(key) { return parse(this.db.prepare('SELECT value_json FROM results WHERE key=?').get(key)?.value_json); }
  saveResult(key, result) {
    const value = stableJson(result);
    this.db.prepare('INSERT OR IGNORE INTO results VALUES(?,?)').run(key, value);
    if (this.db.prepare('SELECT value_json FROM results WHERE key=?').get(key).value_json !== value)
      throw invalid('Completed result changed', 'content.result');
    return result;
  }
  historicalCandidates() {
    return this.db.prepare(`SELECT m.revision_id,m.fact_index,m.fact_id,m.extraction_json,m.decision_json,
      f.story_id,f.title,s.title story_title,r.message_json,r.material_id,a.current_revision FROM memberships m JOIN facts f ON f.id=m.fact_id
      JOIN stories s ON s.id=f.story_id JOIN revisions r ON r.id=m.revision_id JOIN materials a ON a.id=r.material_id
      ORDER BY r.created_at,r.id,m.fact_index`).all().map(row => ({
        revision_id: row.revision_id, material_id: row.material_id, superseded: row.current_revision !== row.revision_id, fact_index: row.fact_index, fact_id: row.fact_id, story_id: row.story_id,
        title: row.title, story_title: row.story_title, fact: parse(row.extraction_json), source: parse(row.message_json), decision: parse(row.decision_json)
      }));
  }
  applyTracking(result) {
    return this.transaction(() => {
      for (const entry of result.entries) {
        const before = this.db.prepare('SELECT decision_json FROM memberships WHERE revision_id=? AND fact_index=?')
          .get(entry.revision_id, entry.fact_index);
        if (before) {
          if (before.decision_json !== stableJson(entry)) throw invalid('Conflicting tracking replay', 'content.tracking');
          continue;
        }
        this.db.prepare('INSERT OR IGNORE INTO stories VALUES(?,?)').run(entry.story_id, entry.story_title);
        const existing = this.db.prepare('SELECT story_id FROM facts WHERE id=?').get(entry.fact_id);
        if (existing && existing.story_id !== entry.story_id) throw invalid('Fact changed story', 'content.tracking');
        this.db.prepare('INSERT OR IGNORE INTO facts VALUES(?,?,?)').run(entry.fact_id, entry.story_id, entry.fact.title);
        this.db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
          .run(entry.revision_id, entry.fact_index, entry.fact_id, stableJson(entry.fact), stableJson(entry));
      }
      return result;
    });
  }
  registerDocument(spec, document, path) {
    return this.transaction(() => {
      const edition = this.edition(spec), hash = contentHash(document);
      if (edition.document_id && (edition.document_id !== document.id || edition.document_hash !== hash))
        throw invalid('Published edition changed', 'content.publish');
      this.db.prepare('UPDATE editions SET document_id=?, document_path=?, document_hash=? WHERE id=?')
        .run(document.id, path, hash, spec.id);
    });
  }
}
