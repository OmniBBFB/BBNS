import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { businessDay, validateDay } from './daily-store.mjs';
import { validateEditionDocument } from './edition-document.mjs';
import { summaryText } from './summary-text.mjs';
import { validateSourceMessage } from './source-message.mjs';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ReadError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function validId(id) {
  if (!idPattern.test(id)) throw new ReadError('INVALID_ID', 400);
  return id;
}
function validDate(day) {
  try { return validateDay(day); } catch { throw new ReadError('INVALID_DATE', 400); }
}
function project(document, day, id) {
  if (document?.schema_version === 2) {
    try { validateEditionDocument(document); } catch { throw new ReadError('INVALID_ARCHIVE', 422); }
  }
  if (![1, 2].includes(document?.schema_version) || document.id !== id || (typeof document.title !== 'string' || !document.title.trim()) ||
      !Number.isFinite(Date.parse(document.created_at)) || !Array.isArray(document.items))
    throw new ReadError('INVALID_ARCHIVE', 422);
  const items = document.items.map((item, index) => {
    if (!item || item.input_index !== index || typeof item.summary !== 'string' || !item.summary.trim())
      throw new ReadError('INVALID_ARCHIVE', 422);
    try { validateSourceMessage(item.source); } catch { throw new ReadError('INVALID_ARCHIVE', 422); }
    const source = item.source;
    return { input_index: item.input_index, summary: summaryText(item.summary, source.content.completeness), source: {
      source_id: source.source_id, title: source.title, url: source.url, kind: source.kind,
      published_at: source.published_at, observed_at: source.observed_at,
      source_signals: source.source_signals, completeness: source.content.completeness,
      source_updated_at: source.data.source_updated_at ?? null
    }, ...(document.schema_version === 2 ? { material: item.material, facts: item.facts, tracking: item.tracking, extraction_issues: item.extraction_issues } : {}) };
  });
  return { schema_version: document.schema_version, id, business_date: day,
    title: document.title, created_at: document.created_at, ...(document.schema_version === 2 ? { edition: document.edition } : {}), items, source_reports: document.source_reports ?? [] };
}

/** Query-only port: no saves, no catalog database, no collection or inference dependencies. */
export class SummaryReader {
  constructor(directory, { timezone = 'Asia/Shanghai', contentReader = null } = {}) { this.directory = resolve(directory); this.timezone = timezone; this.contentReader = contentReader; }
  async story(id) { return this.contentReader?.story(id) ?? null; }
  async read(path, day, id) {
    const root = await realpath(this.directory), actual = await realpath(path);
    const fromRoot = relative(root, actual);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || (await lstat(path)).isSymbolicLink())
      throw new ReadError('NOT_FOUND', 404);
    let document;
    try { document = JSON.parse(await readFile(actual, 'utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new ReadError('INVALID_ARCHIVE', 422); throw error; }
    if (typeof document?.created_at !== 'string' || !Number.isFinite(Date.parse(document.created_at)))
      throw new ReadError('INVALID_ARCHIVE', 422);
    return project(document, day ?? businessDay(document.created_at, this.timezone), id);
  }
  async catalog() {
    let roots;
    try { roots = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return { documents: [], dates: [], unavailable: 0 }; throw error; }
    const documents = [];
    let unavailable = 0;
    const readOne = async (path, day, id) => {
      try {
        const doc = await this.read(path, day, id);
        const sourceCounts = Object.create(null);
        for (const item of doc.items) sourceCounts[item.source.source_id] = (sourceCounts[item.source.source_id] ?? 0) + 1;
        documents.push({ id: doc.id, business_date: doc.business_date, title: doc.title,
          created_at: doc.created_at, item_count: doc.items.length, source_counts: sourceCounts });
      } catch (error) {
        if (error.status === 422 || error.status === 404 || error.code === 'ENOENT') unavailable++;
        else throw error;
      }
    };
    for (const entry of roots) {
      if (entry.isFile() && idPattern.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
        await readOne(join(this.directory, entry.name), null, entry.name.slice(0, -5));
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      try { validDate(entry.name); } catch { continue; }
      for (const file of await readdir(join(this.directory, entry.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.json') && idPattern.test(file.name.slice(0, -5)))
          await readOne(join(this.directory, entry.name, file.name), entry.name, file.name.slice(0, -5));
      }
    }
    documents.sort((a, b) => b.business_date.localeCompare(a.business_date) || (Date.parse(b.created_at) - Date.parse(a.created_at)) || a.id.localeCompare(b.id));
    const dates = [...new Set(documents.map(doc => doc.business_date))].map(date =>
      ({ date, documents: documents.filter(doc => doc.business_date === date).length }));
    return { documents, dates, unavailable };
  }
  async get(day, id) {
    validDate(day); validId(id);
    try { return await this.read(join(this.directory, day, id + '.json'), day, id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        const doc = await this.read(join(this.directory, id + '.json'), null, id);
        if (doc.business_date !== day) throw new ReadError('NOT_FOUND', 404);
        return doc;
      } catch (legacy) { if (legacy.code === 'ENOENT') throw new ReadError('NOT_FOUND', 404); throw legacy; }
    }
  }
}
