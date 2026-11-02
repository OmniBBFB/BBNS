import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from '../src/scheduler.mjs';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { dailyPlans, sourceFailurePlans } from '../src/scheduling.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { todayCollectionHandler } from '../src/today-collection.mjs';
import { summaryHandler, pushHandler, sourceFailureHandler, renderSummary } from '../src/task-handlers.mjs';
import { SummaryReader } from '../src/summary-reader.mjs';
import { deriveView, renderArticles } from '../web/view.mjs';
import { recoverSourceFailurePolicy } from '../tools/recover-source-failure-policy.mjs';

const day = '2026-11-02';
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'bbns-source-failures-'));
  const ledger = new SchedulerLedger(join(directory, 'state.sqlite'));
  try { await action({ directory, ledger }); }
  finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
}
function pipeline({ directory, ledger, allFail = false, withNotices = false, noticeOutcome = 'accepted' }) {
  const subscriptions = new Subscriptions(['bad', 'good'].map(id => ({ id, adapter: id, enabled: true, limit: 5 })));
  const collectionDirectory = join(directory, 'collection'), summaryDirectory = join(directory, 'summary');
  const calls = { bad: 0, good: 0, model: 0, messages: [] };
  const adapters = Object.fromEntries(['bad', 'good'].map(id => [id, { collect: async () => {
    calls[id]++;
    if (id === 'bad' || allFail) throw new DOMException('request timed out', 'TimeoutError');
    return { messages: [sourceMessage(id, { title: '正常来源新闻', published_at: day + 'T00:00:00Z',
      content: { text: '原始材料', format: 'text', completeness: 'summary' } }, day + 'T00:00:00Z')] };
  } }]));
  const connect = () => ({ connect: async () => {}, close() {}, messaging: {
    push: async request => { calls.messages.push(request.content.text); return { status: 'accepted' }; }
  } });
  const handlers = {
    collect: todayCollectionHandler({ directory: collectionDirectory, subscriptions, adapters }),
    summarize: summaryHandler({ directory: summaryDirectory, collectionDirectory, client: { complete: async messages => {
      calls.model++;
      const inputs = JSON.parse(messages[1].content).messages;
      assert.ok(inputs.every(input => input.source_id === 'good'));
      return { content: JSON.stringify({ title: '日报', items: inputs.map((_, input_index) => ({ input_index, summary: '新闻摘要' })) }),
        provider: 'fake', model: 'test' };
    } } }),
    push: pushHandler({ summaryDirectory, deliveryDirectory: join(directory, 'delivery'), connect, target: 'personal', intervalMs: 0 })
  };
  handlers.notify_source_failure = sourceFailureHandler({ directory: join(directory, 'notices'),
    deliveryDirectory: join(directory, 'notice-receipts'), target: 'personal', intervalMs: 0,
    connect: () => ({ connect: async () => {}, close() {}, messaging: { push: async request => {
      calls.messages.push(request.content.text);
      return noticeOutcome === 'accepted' ? { status: 'accepted' } : {
        status: 'unknown', error: { code: 'OUTCOME_UNKNOWN', outcome: 'unknown', retryable: false }
      };
    } } }) });
  let now = Date.parse(day + 'T01:15:00Z');
  const daily = dailyPlans(subscriptions.list());
  const plans = [...daily, ...(withNotices ? sourceFailurePlans(daily) : [])].map(plan => ({ ...plan, max_attempts: 3, timeout_ms: 30000,
    recovery: ['push', 'notify_source_failure'].includes(plan.handler) ? 'unknown' : 'retry' }));
  const scheduler = new Scheduler({ ledger, plans, handlers, clock: () => now, random: () => 0 });
  return { scheduler, calls, handlers, plans, connect, summaryDirectory, advance: () => { now += 2000; } };
}

test('exhausted source retries preserve successful content, publish and push with a failure notice', async () => fixture(async context => {
  const run = pipeline(context);
  await run.scheduler.tick();
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'summarize').status, 'pending');
  run.advance(); await run.scheduler.tick();
  run.advance(); await run.scheduler.tick();
  const rows = context.ledger.rows(day);
  assert.deepEqual(rows.map(row => row.status), ['failed', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(run.calls.good, 1);
  assert.equal(run.calls.bad, 3);
  assert.equal(run.calls.model, 1);
  const ref = rows.find(row => row.task_id === 'summarize').output_refs[0];
  const document = JSON.parse(await readFile(ref.path, 'utf8'));
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0].source.source_id, 'good');
  assert.deepEqual(document.source_reports.find(report => report.source_id === 'bad'), {
    source_id: 'bad', status: 'failed', count: null, error_code: 'TIMEOUT', attempt: 3
  });
  const text = renderSummary(document).join('');
  assert.match(text, /bad.*采集失败.*超时/);
  const view = await new SummaryReader(run.summaryDirectory).get(day, document.id);
  assert.match(renderArticles(deriveView(view)), /bad.*采集失败.*超时/);
  assert.match(run.calls.messages.join(''), /正常来源新闻/);
  assert.match(run.calls.messages.join(''), /bad.*采集失败/);
  const sends = run.calls.messages.length;
  await run.scheduler.tick();
  assert.equal(run.calls.messages.length, sends);
}));

test('all sources failing produces a readable failure report without inference', async () => fixture(async context => {
  const run = pipeline({ ...context, allFail: true });
  for (let i = 0; i < 3; i++) { await run.scheduler.tick(); run.advance(); }
  const summary = context.ledger.rows(day).find(row => row.task_id === 'summarize');
  assert.equal(summary.status, 'succeeded');
  const document = JSON.parse(await readFile(summary.output_refs[0].path, 'utf8'));
  assert.equal(document.items.length, 0);
  assert.equal(run.calls.model, 0);
  assert.match(document.title, /采集异常/);
  assert.ok(document.source_reports.every(report => report.status === 'failed'));
  assert.doesNotMatch(renderSummary(document).join(''), /无当日可用内容/);
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'push').status, 'succeeded');
}));

test('only exhausted sources trigger a durable Bot alert; successful sources stay quiet', async () => fixture(async context => {
  const run = pipeline({ ...context, withNotices: true });
  await run.scheduler.tick();
  assert.equal(run.calls.messages.length, 0);
  run.advance(); await run.scheduler.tick();
  assert.equal(run.calls.messages.length, 0);
  run.advance(); await run.scheduler.tick();
  const alerts = run.calls.messages.filter(text => text.includes('来源采集失败通知'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /bad.*采集失败.*超时.*3 次/);
  assert.doesNotMatch(alerts[0], /\[good\]/);
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'notify:collect:bad').status, 'succeeded');
  await run.scheduler.tick();
  assert.equal(run.calls.messages.filter(text => text.includes('来源采集失败通知')).length, 1);
  // Even a handler replay after restart reuses accepted per-part receipts.
  const row = context.ledger.rows(day).find(row => row.task_id === 'notify:collect:bad');
  await run.handlers.notify_source_failure.execute({ business_date: day, run_id: row.run_id,
    dependency_runs: [{ handler: 'collect', config_ref: 'bad', business_date: day, status: 'failed', attempt: 3, error_code: 'TIMEOUT' }] });
  assert.equal(run.calls.messages.filter(text => text.includes('来源采集失败通知')).length, 1);
}));

test('an ambiguous Bot alert does not block other content or automatically resend', async () => fixture(async context => {
  const run = pipeline({ ...context, withNotices: true, noticeOutcome: 'unknown' });
  for (let i = 0; i < 3; i++) { await run.scheduler.tick(); run.advance(); }
  const rows = context.ledger.rows(day);
  assert.equal(rows.find(row => row.task_id === 'notify:collect:bad').status, 'unknown');
  assert.equal(rows.find(row => row.task_id === 'summarize').status, 'succeeded');
  assert.equal(rows.find(row => row.task_id === 'push').status, 'succeeded');
  const count = run.calls.messages.length;
  await run.scheduler.tick();
  const alert = rows.find(row => row.task_id === 'notify:collect:bad');
  assert.equal((await run.handlers.notify_source_failure.execute({ business_date: day, run_id: alert.run_id,
    dependency_runs: [{ handler: 'collect', config_ref: 'bad', business_date: day, status: 'failed', attempt: 3, error_code: 'TIMEOUT' }] })).status, 'unknown');
  assert.equal(run.calls.messages.length, count);
}));

test('failure notices escape source names and never expose raw dependency error text', () => {
  const document = { title: '日报', items: [], source_reports: [{ source_id: '<script>alert(1)</script>',
    status: 'failed', count: null, error_code: 'PRIVATE_URL_WITH_TOKEN', attempt: 3, message: 'secret credential' }] };
  const html = renderArticles(deriveView(document));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|secret credential|PRIVATE_URL/);
  assert.doesNotMatch(renderSummary(document).join(''), /secret credential|PRIVATE_URL/);
});

test('explicit recovery reopens only today\'s unstarted blocked stages and preserves source attempts', async () => fixture(async context => {
  const run = pipeline(context);
  const oldPlans = run.plans.map(({ dependency_policy, ...plan }) => plan);
  let now = Date.parse(day + 'T01:15:00Z');
  const old = new Scheduler({ ledger: context.ledger, plans: oldPlans, handlers: run.handlers, clock: () => now, random: () => 0 });
  for (let i = 0; i < 3; i++) { await old.tick(); now += 2000; }
  const before = context.ledger.rows(day);
  assert.equal(before.find(row => row.task_id === 'summarize').status, 'blocked');
  assert.deepEqual(recoverSourceFailurePolicy({ ledger: context.ledger, now }).tasks, ['summarize', 'push']);
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'summarize').status, 'blocked');
  recoverSourceFailurePolicy({ ledger: context.ledger, now, apply: true });
  await new Scheduler({ ledger: context.ledger, plans: run.plans, handlers: run.handlers, clock: () => now }).tick();
  const after = context.ledger.rows(day);
  assert.deepEqual(after.filter(row => row.plan.handler === 'collect'), before.filter(row => row.plan.handler === 'collect'));
  assert.equal(after.find(row => row.task_id === 'summarize').run_id, before.find(row => row.task_id === 'summarize').run_id);
  assert.equal(after.find(row => row.task_id === 'summarize').status, 'succeeded');
  assert.equal(after.find(row => row.task_id === 'push').status, 'succeeded');
  assert.deepEqual(recoverSourceFailurePolicy({ ledger: context.ledger, now, apply: true }).tasks, []);
}));

test('recovery respects an expired delivery deadline and never reopens an unknown send', async () => fixture(async context => {
  const run = pipeline(context);
  const oldPlans = run.plans.map(({ dependency_policy, ...plan }) => ({ ...plan,
    ...(plan.handler === 'push' ? { lateness_ms: 3600000 } : {}) }));
  let now = Date.parse(day + 'T01:15:00Z');
  const old = new Scheduler({ ledger: context.ledger, plans: oldPlans, handlers: run.handlers, clock: () => now, random: () => 0 });
  for (let i = 0; i < 3; i++) { await old.tick(); now += 2000; }
  now = Date.parse(day + 'T03:00:00Z');
  recoverSourceFailurePolicy({ ledger: context.ledger, now, apply: true });
  await new Scheduler({ ledger: context.ledger, plans: run.plans, handlers: run.handlers, clock: () => now }).tick();
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'summarize').status, 'succeeded');
  assert.equal(context.ledger.rows(day).find(row => row.task_id === 'push').status, 'expired');
  assert.equal(run.calls.messages.length, 0);
  const summary = context.ledger.rows(day).find(row => row.task_id === 'summarize');
  const push = context.ledger.rows(day).find(row => row.task_id === 'push');
  context.ledger.finish(summary.run_id, 'blocked', { at: new Date(now).toISOString(), error: { code: 'DEPENDENCY_FAILED' } });
  context.ledger.db.prepare('UPDATE runs SET attempt=0 WHERE run_id=?').run(summary.run_id);
  context.ledger.finish(push.run_id, 'unknown', { at: new Date(now).toISOString(), error: { code: 'OUTCOME_UNKNOWN' } });
  assert.deepEqual(recoverSourceFailurePolicy({ ledger: context.ledger, now, apply: true }).tasks, ['summarize']);
  assert.equal(context.ledger.get(push.run_id).status, 'unknown');
}));
