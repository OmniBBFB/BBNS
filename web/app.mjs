import { deriveView, renderDates, renderSources, renderArticles, escape, displayTime, dateLabel, renderStory } from './view.mjs';

const $ = id => document.getElementById(id);
let catalog = { documents: [], dates: [], unavailable: 0 };
let model = null, state = { source: 'all', query: '' }, selectedDate = null, sequence = 0;
const notice = message => { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); };
async function get(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error('ARCHIVE_UNAVAILABLE');
  return response.json();
}
function localFilter() {
  const view = deriveView(model, state);
  $('sources').innerHTML = renderSources(view, state.source);
  $('articles').innerHTML = renderArticles(view);
  $('result-count').textContent = view.items.length + ' / ' + view.total + ' 条';
  $('list-title').textContent = state.source === 'all' && !state.query.trim() ? '本期资讯' : '筛选结果';
}
function setLocation() {
  if (!model) return;
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('date', model.business_date);
  url.searchParams.set('id', model.id);
  if (state.source !== 'all') url.searchParams.set('source', state.source);
  if (state.query) url.searchParams.set('q', state.query);
  history.replaceState(null, '', url);
}
async function loadDocument(metadata, restore = false) {
  const current = ++sequence;
  $('reader').setAttribute('aria-busy', 'true');
  $('articles').innerHTML = '<div class="loading-state" role="status"><div class="skeleton" aria-hidden="true"><span></span><span></span><span></span></div><p>正在读取简报…</p></div>';
  $('toolbar').classList.add('hidden');
  try {
    const next = await get('/api/summaries/' + encodeURIComponent(metadata.business_date) + '/' + encodeURIComponent(metadata.id));
    if (current !== sequence) return;
    model = next; selectedDate = model.business_date;
    const params = new URL(location.href).searchParams;
    state = restore ? { source: params.get('source') || 'all', query: params.get('q') || '' } : { source: 'all', query: '' };
    const available = new Set(model.items.map(item => item.source.source_id));
    if (state.source !== 'all' && !available.has(state.source)) state.source = 'all';
    const label = dateLabel(selectedDate);
    document.title = label.full + ' BBNS 每日简报';
    $('document-date').dateTime = selectedDate;
    $('document-date').textContent = label.full + ' / ' + label.week;
    $('document-title').textContent = model.title;
    const sourceCount = new Set(model.items.map(item => item.source.source_id)).size;
    $('document-stats').innerHTML = '<strong>' + model.items.length + ' 条资讯</strong><span class="meta-divider">/</span>' +
      sourceCount + ' 个来源<span class="meta-divider">/</span>' + escape(displayTime(model.created_at)) + ' 生成' +
      (model.edition ? '<br>覆盖：' + escape(model.edition.window_start) + ' 至 ' + escape(model.edition.window_end) : '');
    $('footer-date').textContent = selectedDate;
    $('search').value = state.query;
    $('dates').innerHTML = renderDates(catalog.dates, selectedDate);
    const versions = catalog.documents.filter(doc => doc.business_date === selectedDate);
    $('versions').innerHTML = versions.map(doc => '<option value="' + escape(doc.id) + '"' + (doc.id === model.id ? ' selected' : '') + '>' +
      escape(displayTime(doc.created_at)) + ' / ' + doc.item_count + ' 条资讯</option>').join('');
    $('version-label').classList.toggle('hidden', versions.length < 2);
    $('toolbar').classList.remove('hidden');
    localFilter(); setLocation();
    notice(catalog.unavailable ? catalog.unavailable + ' 份归档暂不可读取，当前展示其余可用内容。' : '');
  } catch {
    if (current !== sequence) return;
    model = null;
    $('articles').innerHTML = '<div class="empty-state"><h2>这份简报暂时无法读取</h2><p>点击右上角刷新重试，或选择其他日期。</p></div>';
    notice('归档读取失败，请刷新重试或选择其他日期。');
  } finally { if (current === sequence) $('reader').setAttribute('aria-busy', 'false'); }
}
async function refresh() {
  $('refresh').disabled = true;
  $('refresh').setAttribute('aria-busy', 'true');
  $('refresh').querySelector('span').textContent = '读取中';
  try {
    const next = await get('/api/summaries');
    catalog = next;
    $('day-count').textContent = catalog.dates.length + ' 天';
    if (!catalog.documents.length) {
      model = null; sequence++;
      $('dates').innerHTML = '';
      $('document-date').textContent = '';
      $('document-date').removeAttribute('datetime');
      $('footer-date').textContent = '';
      $('document-title').textContent = '等一份新的简报';
      $('document-stats').textContent = '生成的总结会在这里自动成为可阅读的归档。';
      $('list-title').textContent = '阅读档案'; $('result-count').textContent = '';
      $('toolbar').classList.add('hidden'); $('version-label').classList.add('hidden');
      $('articles').innerHTML = '<div class="empty-state"><h2>还没有总结归档</h2><p>下一份简报准备好后，刷新即可阅读。</p></div>';
      notice(catalog.unavailable ? catalog.unavailable + ' 份归档暂不可读取。' : '');
      $('reader').setAttribute('aria-busy', 'false'); return;
    }
    const url = new URL(location.href);
    const requestedId = url.searchParams.get('id'), requestedDate = url.searchParams.get('date');
    const metadata = catalog.documents.find(doc => doc.id === requestedId && (!requestedDate || doc.business_date === requestedDate)) ??
      catalog.documents.find(doc => doc.business_date === requestedDate) ?? catalog.documents[0];
    await loadDocument(metadata, true);
  } catch {
    notice('暂时无法读取归档，请稍后刷新。');
    if (!model) $('articles').innerHTML = '<div class="empty-state"><h2>暂时无法打开简报</h2><p>请确认应用正在运行，再点击右上角刷新。</p></div>';
    $('reader').setAttribute('aria-busy', 'false');
  } finally { $('refresh').disabled = false; $('refresh').removeAttribute('aria-busy'); $('refresh').querySelector('span').textContent = '刷新'; }
}
$('refresh').addEventListener('click', refresh);
$('dates').addEventListener('click', event => {
  const button = event.target.closest('[data-date]');
  if (button) {
    const metadata = catalog.documents.find(doc => doc.business_date === button.dataset.date);
    if (metadata) loadDocument(metadata);
  }
});
$('versions').addEventListener('change', event => {
  const metadata = catalog.documents.find(doc => doc.id === event.target.value && doc.business_date === selectedDate);
  if (metadata) loadDocument(metadata);
});
$('sources').addEventListener('click', event => {
  const button = event.target.closest('[data-source]');
  if (button && model) {
    const source = button.dataset.source;
    const hadFocus = document.activeElement === button;
    state = { ...state, source }; localFilter(); setLocation();
    if (hadFocus) [...$('sources').querySelectorAll('button')].find(item => item.dataset.source === source)?.focus();
  }
});
$('search').addEventListener('input', event => { state = { ...state, query: event.target.value }; localFilter(); setLocation(); });
$('articles').addEventListener('click', event => {
  if (event.target.closest('[data-clear]')) { state = { source: 'all', query: '' }; $('search').value = ''; localFilter(); setLocation(); }
});
window.addEventListener('popstate', refresh);
refresh();

$('articles').addEventListener('toggle', async event => {
  const detail = event.target;
  if (!detail.open || !detail.dataset.storyId || detail.dataset.loaded) return;
  const content = detail.querySelector('[data-story-content]');
  detail.dataset.loaded = 'loading'; content.textContent = '正在读取事件历史…';
  try { content.innerHTML = renderStory(await get('/api/stories/' + encodeURIComponent(detail.dataset.storyId))); detail.dataset.loaded = 'yes'; }
  catch { delete detail.dataset.loaded; content.textContent = '暂时无法读取，收起后重新展开可重试。'; }
}, true);
