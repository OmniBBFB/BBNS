import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkflow } from '../src/workflow.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { SummaryReader } from '../src/summary-reader.mjs';
import { ContentReader } from '../src/content-reader.mjs';
import { contentHash } from '../src/content-store.mjs';
import { renderSummary } from '../src/task-handlers.mjs';
import { deriveView, renderArticles, renderStory } from '../web/view.mjs';

const subscriptions = new Subscriptions(['official','media','rank'].map(id => ({ id, adapter: 'fake', enabled: true, limit: 10 })));
function fakeClient({ failReview = false } = {}) {
  const calls = { edit: 0, judge: 0, review: 0 };
  return { model: 'test', baseUrl: 'https://fake.invalid', calls, async complete(messages) {
    const input = JSON.parse(messages[1].content), system = messages[0].content;
    if (system.startsWith('你是个人订阅')) {
      calls.edit++;
      return { provider: 'fake', model: 'test', usage: { total_tokens: 10 }, content: JSON.stringify({
        items: input.messages.map((source, input_index) => ({ input_index, summary: source.content.text, scope: 'single',
          facts: source.kind !== 'article' ? [] : [{ title: source.title, subject: '机构A', action: source.content.text.includes('下载') ? '开放下载' : '发布', object: '产品X',
            occurred_at: null, time_evidence: null, evidence: source.content.text, conditions: [] }] })) }) };
    }
    if (system.startsWith('复核')) {
      calls.review++;
      if (failReview && calls.review === 1) throw Object.assign(new Error('busy'), { http_status: 429 });
      return { content: JSON.stringify({ confirmed: true, relation: input.proposed.relation, reason: '原文明示的同次发生或直接进展' }) };
    }
    calls.judge++;
    const candidate = input.candidates[0];
    return { content: JSON.stringify({ relation: input.current.fact.action === candidate.fact.action ? 'SAME_OCCURRENCE' : 'SAME_STORY',
      target_id: candidate.fact_id, reason: '产品X的直接消息', comparison: 'complement',
      current_quote: input.current.article.material, historical_quote: candidate.article.material }) };
  } };
}
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'bbns-workflow-'));
  const config = { workflow_version: 2, timezone: 'Asia/Shanghai', content_database: join(root, 'content.sqlite'), stage_directory: join(root, 'stage'),
    collection_directory: join(root, 'raw'), summary_directory: join(root, 'summary'), delivery_directory: join(root, 'delivery'), target: 'personal', push_interval_ms: 0 };
  const ledger = new SchedulerLedger(join(root, 'scheduler.sqlite'));
  const resources = [];
  try { await action({ root, config, ledger, resources }); }
  finally { for (const resource of resources) resource.close();ledger.close();await rm(root, { recursive: true, force: true }); }
}
function adapters(clock) {
  return { fake: { collect: async request => {
    const second = clock().startsWith('2026-10-28');
    const article = request.source_id !== 'rank';
    const text = request.source_id === 'media' && second ? '产品X现在开放下载。' : '机构A发布了产品X。';
    return { messages: [sourceMessage(request.source_id, { title: text, source_item_id: 'stable', url: 'https://' + request.source_id + '.example.com/x',
      ...(article ? { published_at: second && request.source_id === 'media' ? '2026-10-27T14:00:00Z' : '2026-10-26T14:00:00Z' } :
        { kind: 'ranking_entry', observed_at: clock(), source_signals: { rank: 1 } }),
      content: { text, format: 'text', completeness: 'full' } }, clock())] };
  } } };
}

test('full v2 workflow keeps input order, tracks developments across editions and uses the same archived content for reading and pushing', async () => fixture(async ({ config, ledger, resources }) => {
  let now = '2026-10-27T00:02:00Z';const client = fakeClient();const pushed = [];
  const workflow = createWorkflow({ config, subscriptions, client, adapters: adapters(() => now), clock: () => now,
    connect: () => ({ connect: async () => {}, close() {}, messaging: { push: async request => { pushed.push(request.content.text); return { status: 'accepted' }; } } }) });
  resources.push(workflow);
  const scheduler = new Scheduler({ ledger, plans: workflow.plans, handlers: workflow.handlers, clock: () => Date.parse(now) });
  await scheduler.tick();
  assert.equal(ledger.rows('2026-10-27').at(-1).status, 'pending');
  const firstRef = ledger.rows('2026-10-27').find(row => row.task_id === 'compose').output_refs[0];
  const firstBytes = await readFile(firstRef.path, 'utf8'), first = JSON.parse(firstBytes);
  assert.equal(first.schema_version, 2);
  assert.deepEqual(first.items.map(item => item.source.source_id), ['official','media','rank']);
  assert.equal(first.items[0].tracking[0].fact_id, first.items[1].tracking[0].fact_id);
  assert.deepEqual(first.items[2].facts, []);
  assert.equal(first.items[2].source.source_signals.rank, 1);
  const reader = new SummaryReader(config.summary_directory, { contentReader: new ContentReader(config.content_database) });
  const projected = await reader.get('2026-10-27', first.id);
  assert.match(renderArticles(deriveView(projected)), /原文证据与时间/);
  assert.doesNotMatch(JSON.stringify(projected), /stage\//);
  now = '2026-10-27T01:15:00Z';await scheduler.tick();
  assert.equal(pushed.join(''), renderSummary(first).join(''));
  const before = { ...client.calls };await scheduler.tick();assert.deepEqual(client.calls, before);
  now = '2026-10-28T00:02:00Z';await scheduler.tick();
  const secondRef = ledger.rows('2026-10-28').find(row => row.task_id === 'compose').output_refs[0];
  const second = JSON.parse(await readFile(secondRef.path, 'utf8'));
  assert.deepEqual(second.items.map(item => item.source.source_id), ['media','rank']);
  assert.equal(second.items[0].tracking[0].relation, 'SAME_STORY');
  assert.equal(second.items[0].tracking[0].story_id, first.items[0].tracking[0].story_id);
  assert.notEqual(second.items[0].tracking[0].fact_id, first.items[0].tracking[0].fact_id);
  const story = await reader.story(first.items[0].tracking[0].story_id);
  assert.equal(story.reports.length, 3);assert.match(renderStory(story), /当前事件状态/);
  assert.equal(await readFile(firstRef.path, 'utf8'), firstBytes);
}));

test('tracking retry reuses completed extraction and judgement while preserving frozen edition inputs', async () => fixture(async ({ config, ledger, resources }) => {
  let now = '2026-10-27T00:02:00Z';const client = fakeClient({ failReview: true });
  const workflow = createWorkflow({ config, subscriptions, client, adapters: adapters(() => now), clock: () => now,
    connect: () => { assert.fail('not time to push'); } });resources.push(workflow);
  const scheduler = new Scheduler({ ledger, plans: workflow.plans, handlers: workflow.handlers, clock: () => Date.parse(now), random: () => 0 });
  await scheduler.tick();
  assert.equal(ledger.rows('2026-10-27').find(row => row.task_id === 'track').status, 'retry_wait');
  assert.deepEqual(client.calls, { edit: 1, judge: 1, review: 1 });
  now = '2026-10-27T00:03:00Z';await scheduler.tick();
  assert.deepEqual(client.calls, { edit: 1, judge: 1, review: 2 });
  const row = ledger.rows('2026-10-27').find(row => row.task_id === 'compose');assert.equal(row.status, 'succeeded');
  const document = JSON.parse(await readFile(row.output_refs[0].path, 'utf8'));
  assert.equal(document.edition.window_end, '2026-10-27T00:00:00.000Z');
  const composedHash = contentHash(document);
  const context = { run_id: row.run_id, business_date: row.business_date,
    input_refs: ledger.rows(row.business_date).find(row => row.task_id === 'track').output_refs };
  await workflow.handlers.compose.execute(context);
  assert.equal(contentHash(JSON.parse(await readFile(row.output_refs[0].path, 'utf8'))), composedHash);
}));
