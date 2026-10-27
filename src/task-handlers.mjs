import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import AiBot from '@wecom/aibot-node-sdk';
import { CollectionExecutor } from './collection.mjs';
import { defaultAdapters } from './source-adapters.mjs';
import { DailyMessageStore, publish } from './daily-store.mjs';
import { readSourceFile, SummaryGenerator, LocalSummaryStore } from './summary.mjs';
import { Messaging, WecomAdapter } from './messaging.mjs';
import { summaryText, materialLabel } from './summary-text.mjs';
import { boundary, fault, invalid } from './errors.mjs';

async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function json(path) {
  const text = await optional(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { throw invalid('Invalid task artifact JSON', 'task.artifact'); }
}
const succeeded = refs => ({ status: 'succeeded', output_refs: refs });
const failed = error => ({ status: 'failed', error });
const sha = text => createHash('sha256').update(text).digest('hex');

/** Task layer understands business contracts; engine does not. */
export function collectionHandler({ subscriptions, directory, adapters = defaultAdapters() }) {
  return { async execute(context) {
    const { business_date: day, run_id: id, signal } = context;
    return boundary('task.collect', async () => {
      const path = join(directory, day, id + '.jsonl');
      const existing = await optional(path);
      if (existing !== null) {
        // An empty batch is a valid successful collection, but cannot be summarized.
        if (existing.trim()) await readSourceFile(path);
        return succeeded([{ kind: 'collection', path, business_date: day }]);
      }
      const requests = subscriptions.requests([context.config_ref]);
      if (!requests.length) throw invalid('Scheduled source is disabled or missing', 'task.collect');
      const result = await new CollectionExecutor(adapters).execute(requests, { signal });
      const failure = result.results.find(item => item.status === 'failed');
      if (failure) {
        console.warn(JSON.stringify({ event: 'collection.failed', business_date: day,
          source_id: failure.source_id, code: failure.error.code, operation: failure.error.operation }));
        return failed(failure.error);
      }
      signal?.throwIfAborted();
      const saved = await new DailyMessageStore(directory, { businessDate: day }).save(result.messages, { runId: id });
      return succeeded([{ kind: 'collection', path: saved.path, business_date: day }]);
    }, { signal });
  } };
}

export function summaryHandler({ directory, collectionDirectory, client, batchSize = 20 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw invalid('Invalid summary batch size', 'task.summary.config');
  return { async execute(context) {
    const { business_date: day, run_id: id, signal } = context;
    return boundary('task.summary', async () => {
      const store = new LocalSummaryStore(directory, { businessDate: day });
      const finalPath = join(directory, day, id + '.json');
      if (await optional(finalPath) !== null) {
        const document = await store.load(id);
        if (document.id !== id || document.schema_version !== 1 || !Array.isArray(document.items))
          throw invalid('Invalid published summary', 'task.summary');
        return succeeded([{ kind: 'summary', id, path: finalPath, business_date: day }]);
      }
      const refs = context.input_refs.filter(ref => ref.kind === 'collection');
      if (!refs.length || refs.some(ref => ref.business_date !== day)) throw invalid('Missing same-day input batches', 'task.summary');
      const sourceReports = refs.filter(ref => ref.source_id).map(ref => ({
        source_id: ref.source_id, count: ref.counts?.selected ?? null,
        status: ref.counts?.selected === 0 ? 'empty' : 'succeeded', counts: ref.counts ?? null
      }));
      const inputPath = join(collectionDirectory, day, id + '-input.jsonl');
      if (await optional(inputPath) === null) {
        const inputs = [];
        for (const ref of refs) {
          signal?.throwIfAborted();
          const text = await readFile(ref.path, 'utf8');
          if (text.trim()) { await readSourceFile(ref.path); inputs.push(text.trimEnd() + '\n'); }
        }
        if (!inputs.length) {
          const saved = await store.save({ schema_version: 1, id, created_at: new Date().toISOString(),
            title: day + ' 日报：暂无当日资讯', items: [], source_reports: sourceReports });
          return succeeded([{ kind: 'summary', id, path: saved.path, business_date: day }]);
        }
        await mkdir(join(collectionDirectory, day), { recursive: true });
        await publish(inputPath, inputs.join(''));
      }
      const { messages, input } = await readSourceFile(inputPath);
      const batchDirectory = join(directory, day, '.batches', id);
      await mkdir(batchDirectory, { recursive: true });
      const batches = [];
      for (let offset = 0; offset < messages.length; offset += batchSize) {
        signal?.throwIfAborted();
        const path = join(batchDirectory, String(offset).padStart(6, '0') + '.json');
        let batch = await json(path);
        if (batch !== null && (batch.input?.sha256 !== input.sha256 || !Array.isArray(batch.items) ||
            batch.items.length !== Math.min(batchSize, messages.length - offset)))
          throw invalid('Summary batch checkpoint mismatch', 'task.summary');
        if (batch === null) {
          batch = await new SummaryGenerator(client).generate(messages.slice(offset, offset + batchSize), input, { signal });
          signal?.throwIfAborted();
          await publish(path, JSON.stringify(batch) + '\n');
        }
        batches.push({ offset, document: batch });
      }
      const document = { ...batches[0].document, id, input, source_reports: sourceReports,
        items: batches.flatMap(batch => batch.document.items.map(item => ({ ...item, input_index: batch.offset + item.input_index }))) };
      if (batches.length > 1) {
        const usage = {};
        for (const batch of batches) for (const [key, value] of Object.entries(batch.document.inference.usage ?? {}))
          if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
        document.inference = { ...document.inference, request_id: null, usage,
          batches: batches.map(batch => batch.document.inference) };
      }
      signal?.throwIfAborted();
      const saved = await store.save(document);
      return succeeded([{ kind: 'summary', id, path: saved.path, business_date: day }]);
    }, { signal });
  } };
}

export function renderSummary(document, maxBytes = 1500) {
  if (!Number.isInteger(maxBytes) || maxBytes < 32 || maxBytes > 2000) throw invalid('Invalid push part limit', 'task.push.config');
  if (!document?.title || !Array.isArray(document.items)) throw invalid('Invalid summary document', 'task.push.render');
  const editionNotice = document.edition ? '\n覆盖：' + document.edition.window_start + ' 至 ' + document.edition.window_end : '';
  const notices = (document.source_reports ?? []).filter(report => report.count === 0).map(report =>
    '[' + report.source_id + '] ' + (document.schema_version === 2 ? '本期无新增可用内容（已编入 ' + (report.counts?.already_issued ?? 0) + '，首次存量 ' + (report.counts?.initial_history ?? 0) + '）' : '无当日可用内容（历史 ' + (report.counts?.other_date ?? 0) +
    '，无日期 ' + (report.counts?.undated ?? 0) + '）')).join('\n');
  const text = document.title + editionNotice + (notices ? '\n' + notices : '') + '\n\n' + document.items.map((item, index) =>
    (index + 1) + '. [' + item.source.source_id + '] ' + item.source.title + (materialLabel(item.source.content?.completeness) ? '\n' + materialLabel(item.source.content.completeness) : '') + '\n' + summaryText(item.summary, item.source.content?.completeness) +
      (item.material?.inclusion === 'late' ? '\n补收：原发布于 ' + item.source.published_at : '') +
      (document.schema_version === 2 && !item.source.published_at && item.source.kind === 'article' ? '\n发布时间未知' : '') +
      [...new Set((item.tracking ?? []).map(entry => entry.progress).filter(Boolean))].map(progress => '\n' + progress).join('') +
      (item.source.url ? '\n' + item.source.url : '')).join('\n\n');
  const parts = [];
  let part = '', size = 0;
  // Split only on Unicode code points; adapter escaping can at most double bytes.
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > maxBytes) { parts.push(part); part = ''; size = 0; }
    part += point; size += bytes;
  }
  if (part) parts.push(part);
  return parts;
}

export function wecomConnection(config, env = process.env) {
  const { adapter, push, inbound } = config;
  if (adapter?.type !== 'wecom_aibot') throw invalid('Unsupported messaging adapter', 'task.push.config');
  const botId = env[adapter.credentials.bot_id_env], secret = env[adapter.credentials.secret_env];
  if (!botId?.trim() || !secret?.trim()) throw invalid('Missing messaging credentials', 'task.push.config');
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const client = new AiBot.WSClient({ botId, secret, logger: quiet, maxReconnectAttempts: 0 });
  const messaging = new Messaging(new WecomAdapter(client, adapter.id), push.targets,
    async () => inbound?.handler === 'static' ? { type: 'text', text: inbound.reply_text ?? 'todo' } : null);
  return { messaging,
    async connect({ signal, timeoutMs = 20000 } = {}) {
      const ready = new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); client.off('authenticated', authenticated); signal?.removeEventListener('abort', aborted); };
        const authenticated = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => {
          cleanup();
          const error = fault(new Error('Channel not ready'), { operation: 'task.push.connect', kind: 'dependency' });
          reject(Object.assign(new Error('Channel not ready'), { fault: { ...error, code: 'NOT_READY', retryable: true } }));
        }, timeoutMs);
        client.on('authenticated', authenticated);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        else {
          try { messaging.start(); } catch (error) { cleanup(); reject(error); }
        }
      });
      await ready;
    },
    close() { messaging.stop(); }
  };
}

export function pushHandler({ summaryDirectory, deliveryDirectory, target, connect, partBytes = 1500, intervalMs = 3000 }) {
  return { async execute(context) {
    const { business_date: day, run_id: id, signal } = context;
    return boundary('task.push', async () => {
    const refs = context.input_refs.filter(ref => ref.kind === 'summary' && ref.business_date === day);
    if (refs.length !== 1) throw invalid('Missing same-day summary', 'task.push');
    const document = await new LocalSummaryStore(summaryDirectory, { businessDate: day }).load(refs[0].id);
    const parts = renderSummary(document, partBytes);
    const directory = join(deliveryDirectory, day, id);
    await mkdir(directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    const expected = { document_id: document.id, target, hashes: parts.map(sha) };
    const manifest = await json(manifestPath);
    if (manifest && JSON.stringify(manifest) !== JSON.stringify(expected)) throw invalid('Delivery manifest changed', 'task.push');
    if (!manifest) await publish(manifestPath, JSON.stringify(expected) + '\n');
    let connection;
    try {
      for (const [index, text] of parts.entries()) {
        const prefix = join(directory, String(index).padStart(6, '0'));
        const acknowledged = await json(prefix + '.result.json');
        if (acknowledged?.status === 'accepted') continue;
        if (acknowledged) return { status: acknowledged.status === 'unknown' ? 'unknown' : 'failed', error: acknowledged.error };
        if (await optional(prefix + '.sending.json') !== null) {
          const error = fault(new Error('Interrupted send has no receipt'), { operation: 'task.push', outcome: 'unknown' });
          return { status: 'unknown', error: { ...error, code: 'OUTCOME_UNKNOWN' } };
        }
        signal?.throwIfAborted();
        if (!connection) {
          connection = connect();
          try { await connection.connect({ signal }); }
          catch (error) { return failed(fault(error, { operation: 'task.push.connect' })); }
        }
        if (index) await delay(intervalMs, undefined, { signal });
        // Durable intent precedes external side effect. Missing ack never causes automatic replay.
        await publish(prefix + '.sending.json', JSON.stringify({ request_id: id + '/' + index }) + '\n');
        const result = await connection.messaging.push({
          request_id: id + '/' + index, target, content: { type: 'text', text }
        });
        if (result.status === 'failed' && result.error_code === 'NOT_READY') {
          // Intent exists but there was positively no send; retain a retryable negative receipt.
          await publish(prefix + '.result.json', JSON.stringify(result) + '\n');
          return { status: 'failed', error: { ...result.error, retryable: false } };
        }
        await publish(prefix + '.result.json', JSON.stringify(result) + '\n');
        if (result.status !== 'accepted') return { status: result.status === 'unknown' ? 'unknown' : 'failed', error: result.error };
      }
      return succeeded([{ kind: 'delivery', path: manifestPath, business_date: day }]);
    } catch (error) {
      return { status: 'unknown', error: { ...fault(error, { operation: 'task.push' }), outcome: 'unknown', retryable: false } };
    } finally { connection?.close(); }
    }, { signal });
  } };
}
