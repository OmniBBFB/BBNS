import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentStore } from '../src/content-store.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { editionSpec } from '../src/edition.mjs';
import { randomUUID } from 'node:crypto';
const day = '2026-10-27';
const spec = (date = day) => editionSpec({ business_date: date, run_id: randomUUID() });
const message = (extra = {}) => sourceMessage('feed', { title: '发布 X', url: 'https://example.com/a', source_item_id: 'a',
  published_at: '2026-10-26T14:00:00Z', content: { text: '发布了X。', format: 'text', completeness: 'full' }, ...extra }, '2026-10-27T00:01:00Z');

test('stable articles retain content versions, discovery identities and daily observations', () => {
  const store = new ContentStore(':memory:');
  try {
    const one = store.ingest([message()])[0];
    const same = store.ingest([message()])[0];
    assert.equal(one.revision_id, same.revision_id); assert.equal(same.changed, false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM discoveries').get().n, 2);
    const updated = store.ingest([message({ content: { text: 'X现已可用。', format: 'text', completeness: 'full' } })])[0];
    assert.equal(updated.material_id, one.material_id); assert.notEqual(updated.revision_id, one.revision_id);
    assert.equal(store.db.prepare('SELECT max(version) n FROM revisions').get().n, 2);
    const ranking = date => message({ kind: 'ranking_entry', observed_at: date + 'T00:00:00Z', source_item_id: 'org/repo', source_signals: { rank: 1 } });
    const a = store.ingest([ranking(day)])[0], b = store.ingest([ranking('2026-10-28')])[0];
    assert.notEqual(a.material_id, b.material_id);
  } finally { store.close(); }
});

test('window includes last evening, freezes inputs, archives bootstrap history and holds future records', () => {
  const store = new ContentStore(':memory:');
  try {
    const edition = spec();
    store.ingest([message(), message({ source_item_id: 'old', published_at: '2020-01-01T00:00:00Z' }),
      message({ source_item_id: 'future', published_at: '2026-10-27T00:00:00Z' }),
      message({ source_item_id: 'unknown', published_at: null }),
      message({ source_item_id: 'rank', kind: 'ranking_entry', observed_at: '2026-10-27T00:01:00Z' })]);
    const prepared = store.prepare(edition, ['feed'], { preparedAt: '2026-10-27T00:02:00Z' });
    assert.deepEqual(prepared.items.map(item => item.source.source_item_id), ['a','unknown','rank']);
    assert.equal(prepared.source_reports[0].counts.initial_history, 1);
    store.ingest([message({ source_item_id: 'later', published_at: '2026-10-26T15:00:00Z' })]);
    assert.deepEqual(store.prepare(edition, ['feed']), prepared);
    assert.throws(() => store.prepare({ ...edition, window_start: '2020-01-01T00:00:00Z' }, ['feed']), /changed/);
  } finally { store.close(); }
});

test('issued versions do not repeat; later discoveries can be late without replaying old documents', () => {
  const store = new ContentStore(':memory:');
  try {
    store.ingest([message()]);
    const first = spec();store.prepare(first, ['feed'], { preparedAt: '2026-10-27T01:00:00Z' });
    store.registerDocument(first, { id: 'document', items: [] }, '/test/document.json');
    store.ingest([sourceMessage('feed', { ...message(), id: randomUUID(), source_item_id: 'late', fetched_at: '2026-10-28T00:01:00Z' }, '2026-10-28T00:01:00Z')]);
    const next = store.prepare(spec('2026-10-28'), ['feed'], { preparedAt: '2026-10-28T01:00:00Z' });
    assert.deepEqual(next.items.map(item => item.source.source_item_id), ['late']);
    assert.equal(next.items[0].reason, 'late');
    assert.equal(next.source_reports[0].counts.already_issued, 1);
  } finally { store.close(); }
});

test('edition cutoffs use calendar days across DST instead of subtracting 24 hours', () => {
  const edition = editionSpec({ business_date: '2026-11-01', run_id: 'dst', parameters: { cutoff: '08:00', timezone: 'America/New_York' } });
  assert.equal(Date.parse(edition.window_end) - Date.parse(edition.window_start), 25 * 3600000);
});

test('changing source configuration establishes a fresh history baseline rather than treating expansion as late news', () => {
  const store = new ContentStore(':memory:');
  try {
    store.ingest([message()], { sourceVersion: 'feed-one' });
    store.ingest([message({ source_item_id: 'expanded-history', published_at: '2019-01-01T00:00:00Z', fetched_at: '2026-10-28T00:01:00Z' })], { sourceVersion: 'feed-two' });
    const edition = store.prepare(spec('2026-10-28'), ['feed'], { preparedAt: '2026-10-28T01:00:00Z' });
    assert.equal(edition.items.some(item => item.source.source_item_id === 'expanded-history'), false);
    assert.equal(edition.source_reports[0].counts.initial_history, 1);
  } finally { store.close(); }
});

test('an initially valid item is still eligible after an interrupted first edition, not relabelled as bootstrap history', () => {
  const store = new ContentStore(':memory:');
  try {
    const initial = spec();
    store.ingest([message()], { baselineBefore: initial.window_start });
    store.prepare(initial, ['feed'], { preparedAt: '2026-10-27T01:00:00Z' });
    const next = store.prepare(spec('2026-10-28'), ['feed'], { preparedAt: '2026-10-28T01:00:00Z' });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].reason, 'late');
  } finally { store.close(); }
});

test('explicit initial-history policy can include old feed entries without changing their publication dates', () => {
  const store = new ContentStore(':memory:');
  try {
    store.ingest([message({ published_at: '2020-01-01T00:00:00Z' })]);
    const prepared = store.prepare(spec(), ['feed'], { includeInitialHistory: true, preparedAt: '2026-10-27T01:00:00Z' });
    assert.equal(prepared.items.length, 1);
    assert.equal(prepared.items[0].source.published_at, '2020-01-01T00:00:00Z');
    assert.equal(prepared.items[0].reason, 'late');
  } finally { store.close(); }
});
