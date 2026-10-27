import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourceMessage } from '../src/source-message.mjs';
import { selectToday, todayCollectionHandler } from '../src/today-collection.mjs';
import { summaryHandler, renderSummary } from '../src/task-handlers.mjs';
import { SummaryReader } from '../src/summary-reader.mjs';
import { deriveView, renderArticles } from '../web/view.mjs';

const day = '2026-10-26';
const make = (fields = {}) => sourceMessage('rqdmap', { title: '文章', source_item_id: 'stable',
  published_at: day + 'T00:00:00Z', ...fields }, day + 'T01:00:00Z');
test('selection ignores fetch UUID, isolates sources, falls back to URL, preserves daily rankings', () => {
  const post = make();
  const url = make({ source_item_id: null, url: 'https://example.com/post' });
  const ranking = make({ kind: 'ranking_entry', observed_at: day + 'T00:00:00Z' });
  const result = selectToday([post, { ...post, id: randomUUID() }, { ...post, source_id: 'other' },
    url, { ...url, id: randomUUID() }, ranking, make({ published_at: '2026-10-25T00:00:00Z' })], day);
  assert.equal(result.selected.length, 4);
  assert.equal(result.counts.duplicates, 2);
  assert.equal(result.counts.other_date, 1);
  assert.equal(selectToday([{ ...ranking, observed_at: '2026-10-27T00:00:00Z' }], '2026-10-27').selected.length, 1);
});
test('daily handler preserves raw history, reports empty source and archives readable notice without inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bbns-selection-'));
  try {
    const collectionDirectory = join(root, 'collection'), directory = join(root, 'summary');
    const context = { business_date: day, run_id: randomUUID(), config_ref: 'rqdmap' };
    const collect = todayCollectionHandler({ directory: collectionDirectory,
      subscriptions: { requests: () => [{ source_id: 'rqdmap', adapter: 'fake', limit: 10 }] },
      adapters: { fake: { collect: async () => ({ messages: [make({ published_at: '2020-01-01T00:00:00Z' }), make({ published_at: null })] }) } } });
    const result = await collect.execute(context);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output_refs[0].counts.selected, 0);
    assert.equal((await collect.execute(context)).output_refs[0].source_id, 'rqdmap');
    assert.equal((await readFile(join(collectionDirectory, day, context.run_id + '.jsonl'), 'utf8')).trim().split('\n').length, 2);
    const summary = await summaryHandler({ directory, collectionDirectory,
      client: { complete() { assert.fail('empty report must not invoke model'); } } }).execute({
        business_date: day, run_id: randomUUID(), input_refs: result.output_refs });
    const ref = summary.output_refs[0];
    const archived = JSON.parse(await readFile(ref.path, 'utf8'));
    assert.match(renderSummary(archived).join(''), /rqdmap.*无当日可用内容/);
    const doc = await new SummaryReader(directory).get(day, ref.id);
    assert.match(renderArticles(deriveView(doc)), /rqdmap 博客：无当日可用内容/);
    assert.equal((await new SummaryReader(directory).catalog()).documents.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('push identifies each item source', () => {
  assert.match(renderSummary({ title: '日报', items: [{ source: make(), summary: '摘要' }] }).join(''), /\[rqdmap\] 文章/);
});
