import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { Scheduler, scheduledInstant } from '../src/scheduler.mjs';
import { dailyPlans } from '../src/scheduling.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { collectionHandler, summaryHandler, pushHandler, renderSummary } from '../src/task-handlers.mjs';

const day = '2026-10-24';
const at = time => Date.parse(scheduledInstant(day, time, 'Asia/Shanghai'));
const plans = sources => dailyPlans(sources).map(plan => ({ ...plan, max_attempts: 3,
  timeout_ms: 30000, recovery: plan.handler === 'push' ? 'unknown' : 'retry',
  ...(plan.handler === 'push' ? { lateness_ms: 3600000 } : {}) }));
const source = (id = 'feed') => ({ id, adapter: 'fake', enabled: true, limit: 3 });
const data = (id = 'feed') => sourceMessage(id, { title: '新闻🙂', url: 'https://example.com', content: { text: '素材', format: 'text', completeness: 'summary' } }, '2026-10-24T00:00:00Z');
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'bbns-scheduler-'));
  const ledger = new SchedulerLedger(join(directory, 'state.sqlite'));
  try { await action({ directory, ledger }); } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}

test('daily real adapters pipeline persists artifacts and gates push until 09:15 without duplicate execution', async () => fixture(async ({ directory, ledger }) => {
  let now = at('07:59'), collections = 0, inferences = 0, sends = 0;
  const subscriptions = new Subscriptions([source()]);
  const collectionDirectory = join(directory, 'collection'), summaryDirectory = join(directory, 'summary');
  const handlers = {
    collect: collectionHandler({ subscriptions, directory: collectionDirectory, adapters: {
      fake: { collect: async request => { collections++; return { messages: [data(request.source_id)] }; } }
    } }),
    summarize: summaryHandler({ directory: summaryDirectory, collectionDirectory, client: {
      complete: async messages => {
        inferences++; const inputs = JSON.parse(messages[1].content).messages;
        return { content: JSON.stringify({ title: '日报', items: inputs.map((_, input_index) => ({ input_index, summary: '摘要' })) }),
          provider: 'fake', model: 'test', usage: { total_tokens: 5 } };
      }
    } }),
    push: pushHandler({ summaryDirectory, deliveryDirectory: join(directory, 'delivery'), target: 'personal',
      intervalMs: 0, connect: () => ({ connect: async () => {}, close() {}, messaging: {
        push: async () => { sends++; return { status: 'accepted', request_id: 'fake' }; }
      } }) })
  };
  const scheduler = new Scheduler({ ledger, plans: plans(subscriptions.list()), handlers, clock: () => now });
  scheduler.on('state', () => { throw new Error('observer must not break workflow'); });
  await scheduler.tick();
  assert.equal(collections, 0);
  now = at('08:00'); await scheduler.tick();
  assert.deepEqual(ledger.rows(day).map(row => row.status), ['succeeded', 'succeeded', 'pending']);
  assert.equal(sends, 0);
  now = at('09:15'); await scheduler.tick(); await scheduler.tick();
  assert.equal(collections, 1); assert.equal(inferences, 1); assert.equal(sends, 1);
  assert.ok(ledger.rows(day).every(row => row.status === 'succeeded'));
  const archived = ledger.rows(day)[1].output_refs[0];
  assert.match(archived.path, /2026-10-24/);
  assert.equal(JSON.parse(await readFile(archived.path, 'utf8')).items[0].source.title, '新闻🙂');
  assert.ok(ledger.db.prepare('SELECT count(*) n FROM events').get().n >= 6);
}));

test('two ledger connections cannot overlap a running handler', async () => fixture(async ({ directory, ledger }) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const p = [plans([source()])[0]];
  const handlers = { collect: { execute: async () => { started(); await gate; return { status: 'succeeded', output_refs: [] }; } } };
  const other = new SchedulerLedger(join(directory, 'state.sqlite'));
  try {
    const one = new Scheduler({ ledger, plans: p, handlers, clock: () => at('08:00') });
    const two = new Scheduler({ ledger: other, plans: p, handlers, clock: () => at('08:00') });
    const first = one.tick(); await entered;
    assert.equal((await two.tick()).locked, true);
    release(); await first;
    assert.equal(ledger.rows(day)[0].attempt, 1);
  } finally { other.close(); }
}));

test('dead process lock is recovered; interrupted push is unknown and collection may retry', async () => fixture(async ({ directory, ledger }) => {
  const p = [plans([source()])[0], { ...plans([])[1], depends_on: [] }];
  const seed = p.map(plan => ({ ...plan, scheduled_at: scheduledInstant(day, plan.time, plan.timezone),
    deadline: scheduledInstant(day, '23:59', plan.timezone) }));
  const moduleUrl = new URL('../src/scheduler-ledger.mjs', import.meta.url).href;
  const script = 'import {SchedulerLedger} from ' + JSON.stringify(moduleUrl) + '; const db=new SchedulerLedger(' +
    JSON.stringify(join(directory, 'state.sqlite')) + '); db.acquire(); db.seed(' + JSON.stringify(day) + ',' +
    JSON.stringify(seed) + '); for(const row of db.rows(' + JSON.stringify(day) + ')) db.claim(row.run_id,new Date().toISOString()); db.close();';
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  let collect = 0, push = 0;
  const handlers = {
    collect: { execute: async () => { collect++; return { status: 'succeeded', output_refs: [] }; } },
    push: { execute: async () => { push++; return { status: 'succeeded', output_refs: [] }; } }
  };
  await new Scheduler({ ledger, plans: p, handlers, clock: () => at('09:15') }).tick();
  assert.equal(collect, 1); assert.equal(push, 0);
  assert.deepEqual(ledger.rows(day).map(row => row.status), ['succeeded', 'unknown']);
}));

test('retry timing is persisted and failed dependencies are blocked instead of consuming old outputs', async () => fixture(async ({ ledger }) => {
  let now = at('08:00'), calls = 0;
  const handlers = {
    collect: { execute: async () => { calls++; throw Object.assign(new Error('busy'), { http_status: 429, retry_after: '120' }); } },
    summarize: { execute: async () => { throw new Error('must not run'); } },
    push: { execute: async () => { throw new Error('must not run'); } }
  };
  const scheduler = new Scheduler({ ledger, plans: plans([source()]), handlers, clock: () => now, random: () => 0 });
  await scheduler.tick(); await scheduler.tick();
  assert.equal(calls, 1);
  assert.equal(Date.parse(ledger.rows(day)[0].next_attempt_at), now + 120000);
  now += 120000; await scheduler.tick();
  now += 120000; await scheduler.tick();
  assert.equal(calls, 3);
  assert.deepEqual(ledger.rows(day).map(row => row.status), ['failed', 'blocked', 'blocked']);
}));

test('expired push does not send and next day never consumes yesterday summary', async () => fixture(async ({ ledger }) => {
  const handlers = Object.fromEntries(['collect','summarize','push'].map(name => [name, {
    execute: async () => ({ status: 'succeeded', output_refs: [] })
  }]));
  await new Scheduler({ ledger, plans: plans([source()]), handlers, clock: () => at('10:16') }).tick();
  assert.equal(ledger.rows(day)[2].status, 'expired');
  const next = '2026-10-25';
  await new Scheduler({ ledger, plans: plans([source()]), handlers,
    clock: () => Date.parse(scheduledInstant(next, '07:00', 'Asia/Shanghai')) }).tick();
  assert.ok(ledger.rows(next).every(row => row.status === 'pending'));
}));

test('summary resumes completed inference batches without paying for them again', async () => fixture(async ({ directory }) => {
  const collectionDirectory = join(directory, 'collection'), summaryDirectory = join(directory, 'summary');
  const { DailyMessageStore } = await import('../src/daily-store.mjs');
  const saved = await new DailyMessageStore(collectionDirectory).save([data('a'), data('b'), data('c')], { businessDate: day });
  let calls = 0;
  const client = { complete: async messages => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('rate limit'), { http_status: 429 });
    const input = JSON.parse(messages[1].content).messages;
    return { content: JSON.stringify({ title: '日报', items: input.map((_, input_index) => ({ input_index, summary: '摘要' })) }),
      provider: 'fake', model: 'test', usage: { total_tokens: 5 } };
  } };
  const handler = summaryHandler({ directory: summaryDirectory, collectionDirectory, client, batchSize: 1 });
  const context = { run_id: '11111111-1111-1111-1111-111111111111', business_date: day,
    input_refs: [{ kind: 'collection', path: saved.path, business_date: day }] };
  await assert.rejects(handler.execute(context), error => error.fault.retryable);
  const result = await handler.execute(context);
  assert.equal(calls, 4); // 3 successful batches plus 1 failed call; first checkpoint is reused.
  const document = JSON.parse(await readFile(result.output_refs[0].path, 'utf8'));
  assert.deepEqual(document.items.map(item => item.input_index), [0,1,2]);
  assert.equal(document.inference.usage.total_tokens, 15);
  await handler.execute(context); assert.equal(calls, 4);
}));

test('unacknowledged push intent is never replayed, even when task handler is called again', async () => fixture(async ({ directory }) => {
  const { LocalSummaryStore } = await import('../src/summary.mjs');
  const summaryDirectory = join(directory, 'summary');
  const document = { schema_version: 1, id: '11111111-1111-1111-1111-111111111111', title: '日报',
    created_at: '2026-10-24T00:00:00Z', items: [{ source: data(), summary: '摘要' }] };
  await new LocalSummaryStore(summaryDirectory, { businessDate: day }).save(document);
  let sends = 0;
  const handler = pushHandler({ summaryDirectory, deliveryDirectory: join(directory, 'delivery'), target: 'personal',
    connect: () => ({ connect: async () => {}, close() {}, messaging: {
      push: async () => { sends++; throw new Error('connection lost after send'); }
    } }) });
  const context = { run_id: '22222222-2222-2222-2222-222222222222', business_date: day,
    input_refs: [{ kind: 'summary', id: document.id, business_date: day }] };
  assert.equal((await handler.execute(context)).status, 'unknown');
  assert.equal((await handler.execute(context)).status, 'unknown');
  assert.equal(sends, 1);
  const chunks = renderSummary({ ...document, items: Array(20).fill(document.items[0]) }, 32);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 32 && !chunk.includes('�')));
}));

test('timezones, start date and invalid dependency graphs are checked before execution', async () => fixture(async ({ ledger }) => {
  assert.equal(scheduledInstant(day, '08:00', 'Asia/Shanghai'), '2026-10-24T00:00:00.000Z');
  const p = plans([source()]);
  const handlers = Object.fromEntries(['collect','summarize','push'].map(name => [name, { execute: async () => { throw new Error('must not run'); } }]));
  const scheduler = new Scheduler({ ledger, plans: p, handlers, startDate: '2026-10-25', clock: () => at('12:00') });
  assert.deepEqual((await scheduler.tick()).runs, []);
  assert.equal(ledger.rows(day).length, 0);
  assert.throws(() => new Scheduler({ ledger, plans: [{ ...p[0], depends_on: ['missing'] }], handlers }), /Unknown dependency/);
}));

test('SDK rejection frame is a definite failure rather than an ambiguous transport outcome', async () => {
  const { Messaging } = await import('../src/messaging.mjs');
  const adapter = { id: 'bot', ready: true, send: async () => { throw { errcode: 40001, errmsg: 'rejected' }; } };
  const messaging = new Messaging(adapter, { personal: { adapter_id: 'bot', recipient_id: 'user' } }, async () => null);
  const result = await messaging.push({ request_id: 'r', target: 'personal', content: { type: 'text', text: 'hello' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'PROVIDER_REJECTED');
  assert.equal(result.error.outcome, 'not_completed');
  assert.equal(result.error.retryable, false);
});

test('service shutdown persists a resumable attempt after cooperative cancellation', async () => fixture(async ({ ledger }) => {
  const controller = new AbortController();
  let calls = 0, now = at('08:00');
  const handlers = { collect: { execute: async ({ signal }) => {
    calls++;
    if (calls === 1) {
      controller.abort();
      signal.throwIfAborted();
    }
    return { status: 'succeeded', output_refs: [] };
  } } };
  const scheduler = new Scheduler({ ledger, plans: [plans([source()])[0]], handlers, clock: () => now });
  await scheduler.tick({ signal: controller.signal });
  assert.equal(ledger.rows(day)[0].status, 'retry_wait');
  now += 1000;
  await scheduler.tick();
  assert.equal(ledger.rows(day)[0].status, 'succeeded');
  assert.equal(calls, 2);
}));
