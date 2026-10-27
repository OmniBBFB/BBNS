import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fault, annotate, retryDecision } from '../src/errors.mjs';
import { DailyMessageStore, businessDay } from '../src/daily-store.mjs';
import { LocalSummaryStore } from '../src/summary.mjs';
import { CollectionExecutor } from '../src/collection.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { dailyPlans } from '../src/scheduling.mjs';
import { Messaging } from '../src/messaging.mjs';

test('retry policy respects classification, Retry-After, attempt budget and deadline', () => {
  const error = Object.assign(new Error('rate limited'), { http_status: 429, retry_after: '120' });
  assert.equal(retryDecision(error, { attempt: 1, now: 0, random: () => 0 }).delay_ms, 120000);
  assert.equal(retryDecision(error, { attempt: 3 }), null);
  assert.equal(retryDecision(error, { attempt: 1, now: 0, deadline: 119999 }), null);
  assert.equal(retryDecision(Object.assign(new Error('unauthorized'), { http_status: 401 }), { attempt: 1 }), null);
  assert.equal(fault(Object.assign(new Error(), { http_status: 503, retry_after: 'Thu, 01 Jan 1970 00:01:00 GMT' }), { now: 0 }).retry_after_ms, 60000);
  const timeout = annotate(new DOMException('timeout', 'TimeoutError'), { operation: 'send', outcome: 'unknown' });
  assert.equal(timeout.name, 'TimeoutError');
  assert.equal(retryDecision(timeout, { attempt: 1 }), null);
});

test('daily immutable collection and summary stores preserve the scheduled day across midnight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bbns-daily-'));
  try {
    assert.equal(businessDay('2026-10-23T16:05:00Z'), '2026-10-24');
    const message = sourceMessage('rss', { title: 'news' }, '2026-10-23T16:05:00Z');
    const store = new DailyMessageStore(join(directory, 'collection'), { businessDate: '2026-10-23' });
    const saved = await store.save([message], { runId: 'run-1' });
    assert.match(saved.path, /2026-10-23\/run-1.jsonl$/);
    await assert.rejects(store.save([message], { runId: 'run-1' }), error => error.fault.code === 'EEXIST' && !error.fault.retryable);
    assert.equal(JSON.parse((await readFile(saved.path, 'utf8')).trim()).title, 'news');
    await assert.rejects(store.save([message], { businessDate: '2026-02-30' }), error => error.fault.category === 'validation');
    const summaries = new LocalSummaryStore(join(directory, 'summaries'), { businessDate: '2026-10-23' });
    const document = { id: '11111111-1111-1111-1111-111111111111', created_at: '2026-10-23T16:05:00Z', items: [] };
    const result = await summaries.save(document);
    assert.match(result.path, /2026-10-23\/.*\.json$/);
    assert.deepEqual(await summaries.load(document.id), document);
    assert.deepEqual(await summaries.load(document.id, { businessDate: '2026-10-23' }), document);
    await assert.rejects(summaries.save(document), error => error.code === 'EEXIST');
    assert.equal((await readdir(join(summaries.directory, '2026-10-23'))).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('per-source errors preserve retry hints and do not discard successful sources', async () => {
  const run = await new CollectionExecutor({
    bad: { collect: async () => { throw Object.assign(new Error('busy'), { http_status: 503, retry_after: '5' }); } },
    good: { collect: async () => ({ messages: [sourceMessage('ok', { title: 'news' }, '2026-10-23T00:00:00Z')] }) }
  }).execute([{ source_id: 'bad', adapter: 'bad', limit: 1 }, { source_id: 'ok', adapter: 'good', limit: 1 }]);
  assert.equal(run.results[0].error.retryable, true);
  assert.equal(run.results[0].error.retry_after_ms, 5000);
  assert.equal(run.messages.length, 1);
});

test('schedule uses explicit recommendation, falls back to 08:00 and gates 09:15 push', () => {
  const plans = dailyPlans([{ id: 'a', enabled: true, recommended_collection: { time: '06:30' } }, { id: 'b', enabled: true }, { id: 'c', enabled: false }]);
  assert.deepEqual(plans.map(plan => plan.time), ['06:30', '08:00', '08:00', '09:15']);
  assert.deepEqual(plans[2].depends_on, ['collect:a', 'collect:b']);
  assert.throws(() => dailyPlans([{ id: 'bad', enabled: true, recommended_collection: { time: '25:00' } }]), /Invalid schedule/);
});

test('delivery exposes common errors and never recommends retrying ambiguous send', async () => {
  let calls = 0;
  const adapter = { id: 'bot', ready: false, send: async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); } };
  const messaging = new Messaging(adapter, { me: { adapter_id: 'bot', recipient_id: 'user' } }, async () => null);
  const request = { request_id: 'r', target: 'me', content: { type: 'text', text: 'hello' } };
  const pending = await messaging.push(request);
  assert.equal(pending.error.retryable, true);
  assert.equal(calls, 0);
  adapter.ready = true;
  const result = await messaging.push(request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.outcome, 'unknown');
  assert.equal(result.error.retryable, false);
  assert.equal(calls, 1);
});

test('cancellation reaches HTTP and inference without starting later collection sources or publishing summaries', async () => {
  const { HttpClient, RssAdapter } = await import('../src/source-adapters.mjs');
  const { DeepSeekClient } = await import('../src/deepseek-client.mjs');
  const { summarizeFile } = await import('../src/summary.mjs');
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort();
    });
  };
  const executor = new CollectionExecutor({ rss: new RssAdapter(new HttpClient({ fetchImpl })) });
  const req = { source_id: 'rss', adapter: 'rss', limit: 1, options: { url: 'https://example.com' } };
  const result = await executor.execute([req, req], { signal: controller.signal });
  assert.equal(calls, 1);
  assert.deepEqual(result.results.map(item => item.error.category), ['cancelled', 'cancelled']);
  const cancelled = new AbortController(); cancelled.abort();
  const client = new DeepSeekClient({ apiKey: 'fake', model: 'fake', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.complete([], { signal: cancelled.signal }), error => error.fault.category === 'cancelled');
  await assert.rejects(summarizeFile({ signal: cancelled.signal }), error => error.fault.category === 'cancelled');
  const directory = await mkdtemp(join(tmpdir(), 'bbns-cancel-'));
  try {
    const store = new DailyMessageStore(directory);
    const saved = await store.save([sourceMessage('rss', { title: 'news' }, '2026-10-23T00:00:00Z')]);
    const abort = new AbortController();
    let savedSummary = false;
    await assert.rejects(summarizeFile({ inputPath: saved.path, signal: abort.signal,
      client: { complete: async () => {
        abort.abort();
        return { content: JSON.stringify({ title: 'title', items: [{ input_index: 0, summary: 'text' }] }) };
      } },
      store: { save: async () => { savedSummary = true; } }
    }), error => error.fault.category === 'cancelled');
    assert.equal(savedSummary, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
