import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subscriptions } from '../src/subscriptions.mjs';
import { CollectionExecutor } from '../src/collection.mjs';
import { AihotAdapter, RssAdapter, GithubTrendingAdapter, HttpClient } from '../src/source-adapters.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { JsonlMessageStore } from '../src/jsonl-store.mjs';
const now = '2026-10-23T08:00:00Z';
const request = (adapter, limit = 10) => ({ source_id: 'source', adapter, limit, options: { url: 'https://example.com/feed' } });
const fixtureHttp = text => ({ get: async () => ({ text, metadata: {} }) });

test('policy ignores recommended time, excludes disabled sources, returns isolated requests', () => {
  const policy = new Subscriptions([
    { id: 'a', adapter: 'rss', enabled: true, limit: 5, options: { url: 'https://example.com' }, recommended_collection: { time: '23:59' } },
    { id: 'b', adapter: 'rss', enabled: false, limit: 5 }
  ]);
  const requests = policy.requests();
  assert.equal(requests.length, 1);
  requests[0].options.url = 'changed';
  assert.equal(policy.requests()[0].options.url, 'https://example.com');
  assert.throws(() => policy.requests(['missing']), /Unknown/);
  assert.equal(policy.requests(['b']).length, 0);
});

test('RSS parses entities, CDATA, GUID attributes and summary without inventing full text', async () => {
  const adapter = new RssAdapter(fixtureHttp(`<rss version="2.0"><channel><item><title>A &amp; B</title><link>https://example.com/a</link><guid isPermaLink="false">id-1</guid><pubDate>Fri, 23 Oct 2026 08:00:00 +0800</pubDate><description><![CDATA[<p>Hello &amp; world</p>]]></description></item></channel></rss>`));
  const result = await adapter.collect(request('rss'), { fetched_at: now });
  const [message] = result.messages;
  assert.equal(message.title, 'A & B');
  assert.equal(message.source_item_id, 'id-1');
  assert.equal(message.content.text, 'Hello & world');
  assert.equal(message.content.completeness, 'summary');
  assert.equal(message.published_at, '2026-10-23T00:00:00.000Z');
  await assert.rejects(new RssAdapter(fixtureHttp('<html/>')).collect(request('rss'), { fetched_at: now }), /RSS/);
});

test('AIHOT follows pagination up to requested limit and retains attribution', async () => {
  const urls = [];
  const adapter = new AihotAdapter({ get: async url => {
    urls.push(new URL(url));
    return { metadata: {}, text: JSON.stringify({ items: [{ id: 'same', title: 'News', summary: 'Summary', score: 9,
      attribution: { name: 'AIHOT' }, links: { original: 'https://example.com/a' } }],
      page: { hasMore: urls.length === 1, nextCursor: 'next' } }) };
  } });
  const result = await adapter.collect(request('aihot', 2), { fetched_at: now });
  assert.equal(urls[1].searchParams.get('cursor'), 'next');
  assert.equal(result.messages.length, 2); // no dedup, even within one response batch
  assert.notEqual(result.messages[0].id, result.messages[1].id);
  assert.equal(result.messages[0].data.attribution.name, 'AIHOT');
  assert.equal(result.truncated, false);
});

test('AIHOT signals truncation and rejects stuck pagination', async () => {
  const body = JSON.stringify({ items: [{ id: '1', title: 'News' }], page: { hasMore: true, nextCursor: 'same' } });
  const adapter = new AihotAdapter(fixtureHttp(body));
  assert.equal((await adapter.collect(request('aihot', 1), { fetched_at: now })).truncated, true);
  await assert.rejects(adapter.collect(request('aihot', 5), { fetched_at: now }), /pagination/);
});

test('GitHub preserves rank, observation time and daily stars; rejects changed page', async () => {
  const html = `<article class="Box-row"><h2><a href="/owner/repo">owner / repo</a></h2><p>Project description</p><span itemprop="programmingLanguage">JavaScript</span><a href="/owner/repo/stargazers">1,234</a><span class="float-sm-right">123 stars today</span></article>`;
  const { messages: [m] } = await new GithubTrendingAdapter(fixtureHttp(html)).collect(request('github'), { fetched_at: now });
  assert.equal(m.kind, 'ranking_entry'); assert.equal(m.source_signals.rank, 1);
  assert.equal(m.source_signals.stars_today, 123); assert.equal(m.data.stars, 1234);
  assert.equal(m.observed_at, now); assert.equal(m.published_at, null);
  await assert.rejects(new GithubTrendingAdapter(fixtureHttp('<html>Sign in</html>')).collect(request('github'), { fetched_at: now }), /rows missing/);
});

test('executor isolates failure and rejects invalid adapter output; storage remains separate', async () => {
  const executor = new CollectionExecutor({
    good: { collect: async () => ({ messages: [sourceMessage('source', { title: 'OK' }, now)] }) },
    bad: { collect: async () => { throw new Error('offline'); } },
    invalid: { collect: async () => ({ messages: [{ title: 'bad' }] }) }
  }, { clock: () => now });
  const run = await executor.execute([request('bad'), request('good'), request('invalid')]);
  assert.deepEqual(run.results.map(r => r.status), ['failed', 'succeeded', 'failed']);
  assert.equal(run.messages.length, 1);
  assert.equal(run.results[0].error.message, 'offline');
});

test('HTTP surfaces Retry-After to caller without retry or scheduling', async () => {
  let calls = 0;
  const http = new HttpClient({ fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); } });
  await assert.rejects(http.get('https://example.com'), error => error.http_status === 429 && error.retry_after === '60');
  assert.equal(calls, 1);
});

test('JSONL appends repeated messages and serializes concurrent saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bbns-test-'));
  try {
    const path = join(dir, 'nested/messages.jsonl');
    const store = new JsonlMessageStore(path);
    const m = sourceMessage('source', { title: 'Repeated' }, now);
    await Promise.all([store.save([m]), store.save([m])]);
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2); assert.deepEqual(rows[0], rows[1]);
    await assert.rejects(store.save([{ title: 'invalid' }]), /Invalid/);
    assert.equal((await store.save([])).count, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source date parsing is timezone independent and retains uncertainty', async () => {
  const { sourceTime } = await import('../src/source-time.mjs');
  const before = process.env.TZ;
  try {
    for (const timezone of ['UTC','America/New_York','Asia/Shanghai']) {
      process.env.TZ = timezone;
      assert.equal(sourceTime('2026-10-26 15:00:00'), '2026-10-26T07:00:00.000Z');
      assert.equal(sourceTime('Mon, 26 Oct 2026 15:00:00 CST'), '2026-10-26T07:00:00.000Z');
      assert.equal(sourceTime('2026-02-30'), null);
      assert.equal(sourceTime('2026-13-01'), null);
      assert.equal(sourceTime('yesterday'), null);
    }
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});
