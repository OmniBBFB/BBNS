import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateSourceMessage } from './source-message.mjs';
import { summaryText } from './summary-text.mjs';
import { assembleSummaryPrompt, PROMPT_VERSION } from './summary-prompt.mjs';
import { boundary, invalid } from './errors.mjs';
import { businessDay, validateDay, publish } from './daily-store.mjs';

export async function readSourceFile(path) {
  return boundary('summary.input.read', async () => {
    const bytes = await readFile(resolve(path));
    const messages = bytes.toString('utf8').split(/\r?\n/).flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [validateSourceMessage(JSON.parse(line))]; }
      catch { throw invalid('Invalid SourceMessage at line ' + (index + 1), 'summary.input.validate'); }
    });
    if (!messages.length) throw invalid('No source messages', 'summary.input.validate');
    return { messages, input: { path: resolve(path), sha256: createHash('sha256').update(bytes).digest('hex') } };
  });
}

export class SummaryGenerator {
  constructor(client, { clock = () => new Date().toISOString() } = {}) { this.client = client; this.clock = clock; }
  async generate(messages, input = null, { signal } = {}) {
    return boundary('summary.generate', async () => {
      const sources = structuredClone(messages);
      let prompt;
      try { prompt = assembleSummaryPrompt(sources); }
      catch (error) { throw invalid(error.message, 'summary.input.validate'); }
      const result = await boundary('summary.inference', () => this.client.complete(prompt, { signal }), { kind: 'dependency', signal });
      signal?.throwIfAborted();
      let output;
      try { output = JSON.parse(result.content); } catch { throw invalid('Invalid summary JSON', 'summary.output.validate'); }
      const text = value => typeof value === 'string' && value.trim().length > 0;
      if (!text(output?.title) || !Array.isArray(output.items) || output.items.length !== sources.length ||
          output.items.some((item, index) => item?.input_index !== index || !text(item.summary))) {
        throw invalid('Invalid summary structure or source coverage', 'summary.output.validate');
      }
      return { schema_version: 1, id: randomUUID(), created_at: this.clock(), title: output.title,
        prompt_version: PROMPT_VERSION, input,
        inference: { provider: result.provider, model: result.model, request_id: result.request_id, usage: result.usage },
        items: output.items.map((item, index) => ({ input_index: index, summary: summaryText(item.summary, sources[index].content.completeness), source: sources[index] })) };
    }, { signal });
  }
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw invalid('Invalid document id', 'summary.store.validate');
}

/** Immutable daily documents. Legacy flat files remain readable. */
export class LocalSummaryStore {
  constructor(directory, { businessDate, timezone = 'Asia/Shanghai' } = {}) {
    this.directory = resolve(directory); this.businessDate = businessDate; this.timezone = timezone;
  }
  async save(document) {
    return boundary('summary.store.save', async () => {
      validateId(document.id);
      const day = validateDay(this.businessDate ?? businessDay(document.created_at, this.timezone));
      const directory = join(this.directory, day);
      await mkdir(directory, { recursive: true });
      const path = join(directory, document.id + '.json');
      await publish(path, JSON.stringify(document, null, 2) + '\n');
      return { id: document.id, path };
    }, { kind: 'storage' });
  }
  async load(id, { businessDate = this.businessDate } = {}) {
    return boundary('summary.store.load', async () => {
      validateId(id);
      if (businessDate !== undefined) {
        return JSON.parse(await readFile(join(this.directory, validateDay(businessDate), id + '.json'), 'utf8'));
      }
      const entries = await readdir(this.directory, { withFileTypes: true });
      const paths = [join(this.directory, id + '.json'),
        ...entries.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
          .map(entry => join(this.directory, entry.name, id + '.json'))];
      const found = [];
      for (const path of paths) {
        try { found.push(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!found.length) throw Object.assign(new Error('Summary document not found'), { code: 'ENOENT' });
      if (found.length > 1) throw invalid('Ambiguous summary id; specify businessDate', 'summary.store.load');
      try { return JSON.parse(found[0]); }
      catch { throw invalid('Invalid archived summary JSON', 'summary.store.load'); }
    }, { kind: 'storage' });
  }
}

export async function summarizeFile({ inputPath, client, store, signal }) {
  return boundary('summary.pipeline', async () => {
    const { messages, input } = await readSourceFile(inputPath);
    const document = await new SummaryGenerator(client).generate(messages, input, { signal });
    signal?.throwIfAborted();
    return boundary('summary.store.save', () => store.save(document), { kind: 'storage' });
  }, { signal });
}
