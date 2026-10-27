import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { SummaryReader } from '../src/summary-reader.mjs';
import { createReaderServer } from '../src/reader-server.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { deriveView, renderArticles, safeLink } from '../web/view.mjs';

const id = '11111111-1111-1111-1111-111111111111';
const legacyId = '22222222-2222-2222-2222-222222222222';
const badId = '33333333-3333-3333-3333-333333333333';
const day = '2026-10-23';
const message = sourceMessage('aihot', { title: '新闻 <img src=x onerror=alert(1)>', url: 'https://example.com/news',
  content: { text: '原始正文不作为第二事实源', format: 'text', completeness: 'summary' } }, '2026-10-23T00:00:00Z');
const document = { schema_version: 1, id, title: '日报', created_at: '2026-10-23T09:00:00Z',
  input: { path: '/private/local/input.jsonl' }, items: [{ input_index: 0, summary: '归档摘要 <script>alert(1)</script>', source: message }] };

async function setup(action) {
  const directory = await mkdtemp(join(tmpdir(), 'bbns-reader-'));
  try {
    const root = join(directory, 'summaries');
    await mkdir(join(root, day, '.batches'), { recursive: true });
    await writeFile(join(root, day, id + '.json'), JSON.stringify(document));
    await writeFile(join(root, day, id + '.md'), 'This must never be a content source');
    await writeFile(join(root, day, '.batches', legacyId + '.json'), JSON.stringify({ ...document, id: legacyId }));
    await writeFile(join(root, legacyId + '.json'), JSON.stringify({ ...document, id: legacyId, created_at: '2026-10-22T00:00:00Z' }));
    await action({ directory, root, reader: new SummaryReader(root) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('only published summary JSON drives catalog and content; legacy files are supported and checkpoints excluded', async () => setup(async ({ root, reader }) => {
  const catalog = await reader.catalog();
  assert.equal(catalog.documents.length, 2);
  assert.deepEqual(catalog.dates.map(date => date.date), ['2026-10-23','2026-10-22']);
  const detail = await reader.get(day, id);
  assert.equal(detail.items[0].summary, document.items[0].summary);
  assert.equal(detail.input, undefined);
  assert.equal(detail.items[0].source.content, undefined);
  await writeFile(join(root, day, badId + '.json'), '{"schema_version":1,"title":42}');
  const next = await reader.catalog();
  assert.equal(next.documents.length, 2); assert.equal(next.unavailable, 1);
  await writeFile(join(root, badId + '.json'), JSON.stringify({ ...document, id: badId, created_at: 'not-a-date' }));
  assert.equal((await reader.catalog()).unavailable, 2);
  await writeFile(join(root, day, badId + '.json'), JSON.stringify({ ...document, id: badId, items: [null] }));
  assert.equal((await reader.catalog()).unavailable, 2);
  await assert.rejects(reader.get(day, badId), error => error.status === 422);
  assert.equal((await reader.get('2026-10-22', legacyId)).business_date, '2026-10-22');
}));

test('HTTP API is read-only, rejects traversal, and exposes no raw files or private input paths', async () => setup(async ({ root, reader }) => {
  const path = join(root, day, id + '.json'), before = createHash('sha256').update(await readFile(path)).digest('hex');
  const server = createReaderServer({ reader });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(base + '/api/summaries/' + day + '/' + id);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await response.json()).items.length, 1);
    for (const method of ['POST','PUT','PATCH','DELETE']) {
      const rejected = await fetch(base + '/api/summaries/' + day + '/' + id, { method, body: '{}' });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
    }
    assert.equal((await fetch(base + '/api/summaries/2026-02-30/' + id)).status, 400);
    assert.equal((await fetch(base + '/api/summaries/' + day + '/not-a-uuid')).status, 400);
    for (const secret of ['/.env','/data/summaries/' + day + '/' + id + '.json','/../config/message.json'])
      assert.equal((await fetch(base + secret)).status, 404);
    const head = await fetch(base + '/api/summaries', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const html = await fetch(base); assert.equal(html.status, 200); assert.match(await html.text(), /每日简报/);
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}));

test('filesystem symlinks cannot expose data outside the summary archive', async () => setup(async ({ directory, root, reader }) => {
  await writeFile(join(directory, 'outside.json'), JSON.stringify({ ...document, id: badId }));
  await symlink(join(directory, 'outside.json'), join(root, day, badId + '.json'));
  await assert.rejects(reader.get(day, badId), error => error.status === 404);
  assert.equal((await reader.catalog()).documents.length, 2);
}));

test('view is a pure function, preserves archived order, escapes content and filters only local display', () => {
  const dto = { ...document, items: [
    ...document.items,
    { input_index: 1, summary: 'repository summary', source: { ...message, source_id: 'github-trending', title: 'GitHub repo', kind: 'ranking_entry', observed_at: message.fetched_at } }
  ] };
  const original = JSON.stringify(dto);
  const view = deriveView(dto, { source: 'github-trending', query: 'REPO' });
  assert.equal(view.items.length, 1); assert.equal(view.items[0].input_index, 1);
  const markup = renderArticles(deriveView(dto));
  assert.equal(markup.includes('<script>'), false);
  assert.equal(markup.includes('<img src=x'), false);
  assert.match(markup, /&lt;script&gt;/);
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(JSON.stringify(dto), original);
  assert.deepEqual(deriveView(dto).items.map(item => item.input_index), [0,1]);
});


test('archive emptiness and filtered emptiness give different recovery advice', () => {
  const empty = renderArticles(deriveView({ items: [] }));
  assert.match(empty, /本期暂无资讯/);
  assert.equal(empty.includes('data-clear'), false);
  const filtered = renderArticles(deriveView(document, { query: 'does-not-exist' }));
  assert.match(filtered, /没有找到匹配的资讯/);
  assert.match(filtered, /data-clear/);
});


test('material labels reflect completeness and never guess missing provenance', () => {
  const view = completeness => renderArticles(deriveView({ items: [{ ...document.items[0], source: { ...message, completeness } }] }));
  assert.match(view('summary'), /基于来源摘要/);
  assert.match(view('full'), /基于全文/);
  assert.doesNotMatch(view(undefined), /基于全文|基于来源摘要/);
});
test('reader removes legacy prefix without rewriting archives', async () => setup(async ({ root, reader }) => {
  const path = join(root, day, id + '.json');
  const bytes = JSON.stringify({ ...document, items: [{ ...document.items[0], summary: '仅依据摘要：正文，消息尚未证实。' }] });
  await writeFile(path, bytes);
  const dto = await reader.get(day, id);
  assert.equal(dto.items[0].summary, '正文，消息尚未证实。');
  assert.equal(dto.items[0].source.completeness, 'summary');
  assert.equal(await readFile(path, 'utf8'), bytes);
}));

test('current event query is read-only and does not create a missing content database', async () => setup(async ({ directory, reader }) => {
  const { ContentReader } = await import('../src/content-reader.mjs');
  const { access } = await import('node:fs/promises');
  const path = join(directory, 'does-not-exist.sqlite');
  reader.contentReader = new ContentReader(path);
  const server = createReaderServer({ reader });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const route = '/api/stories/s_' + 'a'.repeat(32);
    assert.equal((await fetch(base + route)).status, 500);
    assert.equal((await fetch(base + route, { method: 'POST', body: '{}' })).status, 405);
    await assert.rejects(access(path), { code: 'ENOENT' });
  } finally { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
}));

test('malformed v2 facts are isolated as unreadable documents rather than passed to the browser', async () => setup(async ({ root, reader }) => {
  const invalid = { ...document, id: badId, schema_version: 2, edition: { window_start: '2026-10-22T00:00:00Z', window_end: '2026-10-23T00:00:00Z' },
    items: [{ ...document.items[0], material: {}, facts: [{ evidence: null }], tracking: [] }] };
  await writeFile(join(root, day, badId + '.json'), JSON.stringify(invalid));
  await assert.rejects(reader.get(day, badId), error => error.status === 422);
  assert.equal((await reader.catalog()).unavailable, 1);
}));
