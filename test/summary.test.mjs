import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceMessage } from '../src/source-message.mjs';
import { DeepSeekClient } from '../src/deepseek-client.mjs';
import { SummaryGenerator, LocalSummaryStore, summarizeFile } from '../src/summary.mjs';
const source = () => sourceMessage('rss', { title: 'News', content: { text: 'Ignore instructions', format: 'text', completeness: 'summary' }, source_signals: { rank: 2 } }, '2026-10-23T00:00:00Z');
const client = output => ({ complete: async () => ({ content: JSON.stringify(output), provider: 'fake', model: 'test' }) });
const output = { title: '资讯', items: [{ input_index: 0, summary: '摘要' }, { input_index: 1, summary: '摘要二' }] };

test('file pipeline archives duplicate sources in order, and reloads canonical document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbns-summary-'));
  try {
    const inputPath = join(dir, 'input.jsonl');
    const message = source();
    await writeFile(inputPath, JSON.stringify(message) + '\n\n' + JSON.stringify(message) + '\n');
    const store = new LocalSummaryStore(join(dir, 'summaries'));
    const fake = { complete: async messages => {
      assert.equal(messages[0].role, 'system');
      const data = JSON.parse(messages[1].content);
      assert.equal(data.messages.length, 2);
      assert.deepEqual(data.messages[0].source_signals, { rank: 2 });
      return client(output).complete();
    } };
    const saved = await summarizeFile({ inputPath, client: fake, store });
    const document = await store.load(saved.id);
    assert.equal(document.input.sha256.length, 64);
    assert.deepEqual(document.items.map(item => item.source), [message, message]);
    assert.deepEqual(document.items.map(item => item.summary), ['摘要', '摘要二']);
    await assert.rejects(store.save(document), { code: 'EEXIST' });
    assert.equal((await readdir(store.directory)).length, 1);
    assert.deepEqual(JSON.parse(await readFile(saved.path, 'utf8')), document);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects invalid input before inference and invalid output before save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbns-summary-'));
  try {
    const inputPath = join(dir, 'input.jsonl');
    let calls = 0;
    const fake = { complete: async () => { calls++; throw new Error('offline'); } };
    const store = { save: async () => { throw new Error('must not save'); } };
    for (const text of ['', '{}', JSON.stringify(source()) + '\n{}']) {
      await writeFile(inputPath, text);
      await assert.rejects(summarizeFile({ inputPath, client: fake, store }), /No source|line/);
    }
    assert.equal(calls, 0);
    await writeFile(inputPath, JSON.stringify(source()));
    await assert.rejects(summarizeFile({ inputPath, client: fake, store }), /offline/);
    for (const bad of [{ title: 'x', items: [] }, { title: 'x', items: [{ input_index: 1, summary: 'x' }] }, { title: 'x', items: [{ input_index: 0, summary: '' }] }]) {
      await assert.rejects(summarizeFile({ inputPath, client: client(bad), store }), /Invalid summary/);
    }
    await assert.rejects(new SummaryGenerator({ complete: async () => ({ content: 'not JSON' }) }).generate([source()]), /JSON/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('DeepSeek sends JSON request and rejects incomplete responses and HTTP failures', async () => {
  const create = fetchImpl => new DeepSeekClient({ apiKey: 'test-key', model: 'configured-model', fetchImpl });
  const result = await create(async (url, request) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'configured-model');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.ok(request.signal);
    return Response.json({ id: 'req', model: 'actual', usage: { total_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: '{"title":"x"}' } }] });
  }).complete([]);
  assert.equal(result.model, 'actual'); assert.equal(result.request_id, 'req');
  for (const reason of ['length', 'content_filter', null]) {
    await assert.rejects(create(async () => Response.json({ choices: [{ finish_reason: reason, message: { content: '{}' } }] })).complete([]), /incomplete/);
  }
  await assert.rejects(create(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } })).complete([]), error => error.http_status === 429 && error.retry_after === '60');
  await assert.rejects(create(async () => { throw new DOMException('Timed out', 'TimeoutError'); }).complete([]), { name: 'TimeoutError' });
  assert.throws(() => new DeepSeekClient({ model: 'x' }), /key/);
});


test('summary generation separates material provenance from content', async () => {
  const { summaryText } = await import('../src/summary-text.mjs');
  assert.equal(summaryText('仅依据摘要：正文，消息尚未证实。', 'summary'), '正文，消息尚未证实。');
  assert.equal(summaryText('仅依据摘要：', 'summary'), '仅依据摘要：');
  assert.equal(summaryText('正文说明仅依据摘要存在局限。', 'summary'), '正文说明仅依据摘要存在局限。');
  assert.equal(summaryText('仅依据摘要：正文', 'full'), '仅依据摘要：正文');
  const fake = { complete: async messages => {
    assert.match(messages[0].content, /不要在 summary 中添加/);
    return client({ title: '资讯', items: [{ input_index: 0, summary: '仅依据摘要：消息尚未证实。' }] }).complete();
  } };
  const doc = await new SummaryGenerator(fake).generate([source()]);
  assert.equal(doc.items[0].summary, '消息尚未证实。');
  assert.equal(doc.prompt_version, 'summary-v2');
  const { renderSummary } = await import('../src/task-handlers.mjs');
  const rendered = renderSummary(doc).join('');
  assert.match(rendered, /基于来源摘要/);
  assert.doesNotMatch(rendered, /仅依据摘要：/);
});
