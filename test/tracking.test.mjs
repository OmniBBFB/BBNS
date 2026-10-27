import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessages, originalQuote } from '../src/editorial.mjs';
import { track } from '../src/tracking.mjs';
import { sourceMessage } from '../src/source-message.mjs';
const source = (id = 'official', text = '2026-10-26 发布了产品X。免费使用。') => sourceMessage(id, { title: '产品X', url: 'https://' + id + '.example.com/x',
  content: { text, format: 'text', completeness: 'full' } }, '2026-10-27T00:00:00Z');
const fact = { title: '发布产品X', subject: '机构A', action: '发布', object: '产品X', occurred_at: '2026-10-26',
  time_evidence: '2026-10-26 发布了产品X。', evidence: '2026-10-26 发布了产品X。', conditions: ['免费使用。'] };
const output = facts => ({ content: JSON.stringify({ items: [{ input_index: 0, summary: '产品X已经发布。', scope: 'single', facts }] }), model: 'fake', provider: 'fake' });

test('fact extraction grounds original quotes, does not invent dates, and preserves observations', async () => {
  const result = await extractMessages([source()], { client: { complete: async () => output([fact]) } });
  assert.equal(result.items[0].facts[0].occurred_at, '2026-10-26');
  assert.equal(result.items[0].facts[0].evidence.text, fact.evidence);
  assert.deepEqual(originalQuote('a\n  b', 'a b'), { text: 'a\n  b', start: 0, end: 5 });
  const wrong = await extractMessages([source()], { client: { complete: async () => output([{ ...fact, evidence: '原文没有说这句话' }]) } });
  assert.equal(wrong.items[0].facts.length, 0);
  assert.deepEqual(wrong.items[0].issues, ['ungrounded_evidence']);
  const undated = await extractMessages([source()], { client: { complete: async () => output([{ ...fact, time_evidence: null }]) } });
  assert.equal(undated.items[0].facts[0].occurred_at, null);
  await assert.rejects(extractMessages([{ ...source(), kind: 'ranking_entry' }], { client: { complete: async () => output([fact]) } }), /Observation/);
});

const old = { revision_id: 'r_old', fact_id: 'f_old', story_id: 's_old', story_title: '产品X发布', fact_index: 0,
  source: source(), fact: { ...fact, evidence: originalQuote(source().content.text, fact.evidence), conditions: [] } };
const current = () => [{ revision_id: 'r_new', source: source('media', '产品X现在开放下载。'), extraction: {
  facts: [{ ...old.fact, title: '产品X开放下载', action: '开放下载', evidence: { text: '产品X现在开放下载。', start: 0, end: 12 } }] } }];
function model(relation, confirmed = true) {
  let calls = 0;
  return { get calls() { return calls; }, async complete(messages) {
    calls++;
    if (messages[0].content.startsWith('复核')) return { content: JSON.stringify({ confirmed, relation, reason: '有直接关系' }) };
    return { content: JSON.stringify({ relation, target_id: 'f_old', reason: '同一事件的变化', comparison: 'complement',
      current_quote: '产品X现在开放下载。', historical_quote: fact.evidence }) };
  } };
}

test('direct developments create a new fact in the same story, keeping cross-source evidence', async () => {
  const client = model('SAME_STORY');
  const result = await track({ current: current(), historicalCandidates: [old] }, { client });
  assert.equal(client.calls, 2);
  const entry = result.entries[0];
  assert.equal(entry.story_id, 's_old'); assert.notEqual(entry.fact_id, 'f_old');
  assert.match(entry.progress, /后续进展/);
  assert.equal(entry.comparison.evidence.length, 2); assert.equal(entry.comparison.independence, 'unknown');
});

test('same occurrence shares a fact; review rejection keeps an unresolved separate record', async () => {
  const same = await track({ current: current(), historicalCandidates: [old] }, { client: model('SAME_OCCURRENCE') });
  assert.equal(same.entries[0].fact_id, 'f_old');
  const no = await track({ current: current(), historicalCandidates: [old] }, { client: model('SAME_STORY', false) });
  assert.equal(no.entries[0].relation, 'UNRESOLVED'); assert.notEqual(no.entries[0].story_id, 's_old');
});

test('shared upstream URL is not independent corroboration; foreign targets are rejected', async () => {
  const incoming = current();incoming[0].source.data.origin_url = old.source.url;
  const result = await track({ current: incoming, historicalCandidates: [old] }, { client: model('SAME_OCCURRENCE') });
  assert.equal(result.entries[0].comparison.independence, 'shared_origin');
  await assert.rejects(track({ current: current(), historicalCandidates: [old] }, { client: {
    complete: async () => ({ content: JSON.stringify({ relation: 'SAME_STORY', target_id: 'invented', reason: 'x', comparison: 'unknown' }) })
  } }), /target/);
});

test('a fabricated relationship quotation cannot establish a link even when the target id exists', async () => {
  let calls = 0;
  const result = await track({ current: current(), historicalCandidates: [old] }, { client: { complete: async () => {
    calls++;
    return { content: JSON.stringify({ relation: 'SAME_STORY', target_id: old.fact_id, reason: 'guess', comparison: 'agreement',
      current_quote: '不存在的证据', historical_quote: fact.evidence }) };
  } } });
  assert.equal(calls, 1);
  assert.equal(result.entries[0].relation, 'UNRESOLVED');
  assert.notEqual(result.entries[0].story_id, old.story_id);
});
