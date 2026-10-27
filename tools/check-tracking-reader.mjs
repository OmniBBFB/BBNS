import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createWorkflow } from '../src/workflow.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { SummaryReader } from '../src/summary-reader.mjs';
import { ContentReader } from '../src/content-reader.mjs';
import { createReaderServer } from '../src/reader-server.mjs';

// Completely local fixture: no production config, models, recipients or network sources.
const require = createRequire(join(process.env.HALLMARK_PUPPETEER || process.cwd(), 'package.json'));
const puppeteer = require('puppeteer-core');
const root = await mkdtemp(join(tmpdir(), 'bbns-tracking-browser-'));
const now = '2026-10-27T00:02:00Z';
const config = { workflow_version: 2, timezone: 'Asia/Shanghai', content_database: join(root, 'content.sqlite'), stage_directory: join(root, 'stage'),
  collection_directory: join(root, 'raw'), summary_directory: join(root, 'summaries'), delivery_directory: join(root, 'delivery'), target: 'fake' };
let workflow, ledger, server, browser, modelCalls = 0;
try {
  const client = { complete: async messages => {
    modelCalls++;
    const input = JSON.parse(messages[1].content);
    if (messages[0].content.startsWith('你是个人订阅')) return { content: JSON.stringify({ items: input.messages.map((message, input_index) => ({
      input_index, summary: message.content.text, scope: 'single', facts: [{ title: message.title, subject: '机构A', action: input_index ? '开放下载' : '发布', object: '产品X',
        occurred_at: null, time_evidence: null, evidence: message.content.text, conditions: [] }] })) }), provider: 'fixture', model: 'fixture' };
    if (messages[0].content.startsWith('复核')) return { content: JSON.stringify({ confirmed: true, relation: 'SAME_STORY', reason: '明确后续' }) };
    return { content: JSON.stringify({ relation: 'SAME_STORY', target_id: input.candidates[0].fact_id, reason: '开放下载是后续', comparison: 'complement',
      current_quote: input.current.article.material, historical_quote: input.candidates[0].article.material }) };
  } };
  workflow = createWorkflow({ config, subscriptions: new Subscriptions([{ id: 'feed', adapter: 'fixture', enabled: true, limit: 10 }]),
    client, clock: () => now, connect() { assert.fail('must not send'); }, adapters: { fixture: { collect: async () => ({
      messages: ['产品X正式发布。','产品X现已开放下载。'].map((text, index) => sourceMessage('feed', { source_item_id: String(index), title: text,
        url: 'https://example.invalid/' + index, published_at: '2026-10-26T14:00:00Z', content: { text, format: 'text', completeness: 'full' } }, now))
    }) } } });
  ledger = new SchedulerLedger(join(root, 'scheduler.sqlite'));
  await new Scheduler({ ledger, plans: workflow.plans, handlers: workflow.handlers, clock: () => Date.parse(now) }).tick();
  const callsBeforeReading = modelCalls;
  server = createReaderServer({ reader: new SummaryReader(config.summary_directory, { contentReader: new ContentReader(config.content_database) }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith(base + '/')) { external.push(request.url()); request.abort(); }
    else request.continue();
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#articles')?.textContent.includes('后续进展'));
  const before = await page.$eval('#articles', el => el.textContent);
  assert.match(before, /原文证据与时间/);
  await page.click('[data-story-id] summary');
  await page.waitForFunction(() => document.querySelector('[data-story-content]')?.textContent.includes('当前事件状态'));
  assert.match(await page.$eval('[data-story-content]', el => el.textContent), /发布|开放下载/);
  for (const width of [320, 390, 1280]) {
    await page.setViewport({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
  }
  assert.equal(modelCalls, callsBeforeReading);assert.deepEqual(errors, []);assert.deepEqual(external, []);
  console.log(JSON.stringify({ status: 'passed', new_edition_reading: true, event_history: true, no_model_calls_on_read: true,
    viewport_widths: [320,390,1280], console_errors: errors, external_requests: external }));
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  ledger?.close();workflow?.close();await rm(root, { recursive: true, force: true });
}
