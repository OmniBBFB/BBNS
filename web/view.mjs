/** Pure view functions: archived model + local UI state -> escaped markup. */
const sourceNames = new Map([['aihot', 'AIHOT'], ['github-trending', 'GitHub Trending'], ['rqdmap', 'rqdmap 博客']]);
export const sourceName = id => sourceNames.get(id) ?? id;
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function displayTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
export function dateLabel(day) {
  const [year,month,date] = day.split('-');
  return { full: year + ' 年 ' + Number(month) + ' 月 ' + Number(date) + ' 日', short: month + '.' + date,
    week: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(new Date(day + 'T12:00:00+08:00')) };
}
export function deriveView(document, { source = 'all', query = '' } = {}) {
  if (!document) return { items: [], sources: [], total: 0 };
  const counts = new Map();
  for (const item of document.items) counts.set(item.source.source_id, (counts.get(item.source.source_id) ?? 0) + 1);
  const search = query.trim().toLocaleLowerCase();
  return { filtered: source !== 'all' || Boolean(search), reports: document.source_reports ?? [], edition: document.edition, total: document.items.length, sources: [...counts].map(([id,count]) => ({ id, count })),
    items: document.items.filter(item => (source === 'all' || item.source.source_id === source) &&
      (!search || [item.source.title, item.summary, sourceName(item.source.source_id)].some(text => text.toLocaleLowerCase().includes(search)))) };
}
export function renderDates(dates, selected) {
  return dates.map(({ date, documents }) => {
    const label = dateLabel(date);
    return '<button class="date-choice ' + (date === selected ? 'selected' : '') + '" data-date="' + escape(date) + '" aria-pressed="' + (date === selected) + '">' +
      '<span class="date-icon">' + Number(date.slice(8)) + '</span><span><strong>' + escape(label.full) + '</strong><small>' +
      '<span>' + escape(label.week) + '</span><span>' + documents + ' 份归档</span></small></span></button>';
  }).join('');
}
export function renderSources(view, selected) {
  return [{ id: 'all', count: view.total }, ...view.sources].map(source =>
    '<button class="source-filter ' + (selected === source.id ? 'active' : '') + '" data-source="' + escape(source.id) + '" aria-pressed="' + (selected === source.id) + '">' +
    escape(source.id === 'all' ? '全部资讯' : sourceName(source.id)) + '<span>' + source.count + '</span></button>').join('');
}
export function renderArticles(view) {
  const notices = (view.reports ?? []).filter(report => report.count === 0).map(report =>
    '<p class="source-notice" role="status">' + escape(sourceName(report.source_id)) +
    (view.edition ? '：本期无新增可用内容（已编入 ' + escape(report.counts?.already_issued ?? 0) + '，首次存量 ' + escape(report.counts?.initial_history ?? 0) + '）' : '：无当日可用内容（历史 ' + escape(report.counts?.other_date ?? 0) +
    '，无日期 ' + escape(report.counts?.undated ?? 0) + '）') + '</p>').join('');
  if (!view.items.length && !view.filtered) return notices + '<div class="empty-state"><h2>本期暂无资讯</h2><p>本期归档没有可阅读的条目。可选择其他日期，或稍后刷新归档。</p></div>';
  if (!view.items.length) return notices + '<div class="empty-state"><h2>没有找到匹配的资讯</h2><p>试试其他关键词，或查看全部来源。</p><button class="text-button" data-clear>清除筛选</button></div>';
  return notices + view.items.map(item => {
    const source = item.source, link = safeLink(source.url);
    const domain = link ? new URL(link).hostname.replace(/^www\./, '') : null;
    const time = source.kind === 'ranking_entry' ? source.observed_at : source.published_at;
    const rank = source.source_signals?.rank;
    const material = source.completeness === 'summary' ? '基于来源摘要' : source.completeness === 'full' ? '基于全文' : null;
    return '<article class="news-card"><div class="article-number">' + String(item.input_index + 1).padStart(2, '0') + '</div><div class="article-body">' +
      '<div class="article-kicker">' +
      escape(sourceName(source.source_id)) + (material ? '<span class="rank">' + material + '</span>' : '') + (Number.isFinite(rank) ? '<span class="rank">来源排名 #' + rank + '</span>' : '') + '</div>' +
      '<h2>' + (link ? '<a href="' + escape(link) + '" target="_blank" rel="noopener noreferrer">' + escape(source.title) + '</a>' : escape(source.title)) + '</h2>' +
      '<p class="summary-text">' + escape(item.summary) + '</p>' + renderTracking(item) +
      '<div class="article-footer">' + (link ? '<a href="' + escape(link) + '" target="_blank" rel="noopener noreferrer">' + escape(domain) + '</a>' : '<span>原文链接未提供</span>') +
      (time ? '<span>' + (source.kind === 'ranking_entry' ? '观测于 ' : '发布于 ') + escape(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(time))) + '</span>' : '') +
      '</div></div></article>';
  }).join('');
}

function renderTracking(item) {
  if (!item.material) return '';
  const timeNotes = [item.material.inclusion === 'late' ? '补收消息，原始发布时间见下方' : null,
    !item.source.published_at && item.source.kind === 'article' ? '发布时间未知' : null].filter(Boolean);
  const entries = item.tracking ?? [];
  const progress = [...new Set(entries.map(entry => entry.progress).filter(Boolean))];
  const evidence = (item.facts ?? []).map(fact => '<blockquote>' + escape(fact.evidence.text) + '</blockquote>');
  const stories = [...new Set(entries.map(entry => entry.story_id))];
  const comparisons = entries.filter(entry => entry.previous).map(entry => '<p>来源对照：' +
    escape(({ agreement: '说法一致', complement: '信息补充', conflict: '存在冲突', unknown: '未确定' })[entry.comparison?.relationship] ?? '未确定') +
    '；' + (entry.comparison?.independence === 'shared_origin' ? '引用相同来源，不代表独立核验' : '来源独立性未确认') + '</p>').join('');
  return timeNotes.concat(progress).map(text => '<p class="source-notice">' + escape(text) + '</p>').join('') +
    (evidence.length ? '<details><summary>原文证据与时间</summary>' + evidence.join('') +
      '<p>首次发现：' + escape(item.material.first_discovered_at) + '<br>处理：' + escape(item.material.processed_at) + '</p>' +
      (item.facts ?? []).map(fact => '<p>发生日期：' + escape(fact.occurred_at ?? '未知') + '</p>').join('') + comparisons + '</details>' : '') +
    stories.map(id => '<details data-story-id="' + escape(id) + '"><summary>查看事件当前历史</summary><div data-story-content>展开后读取已保存的事件记录</div></details>').join('');
}

export function renderStory(story) {
  return '<p>当前事件状态；历史日报仍保留当时快照。</p><h3>' + escape(story.title) + '</h3>' +
    story.reports.map(report => '<p><strong>' + escape(report.fact.title) + '</strong><br>' + escape(sourceName(report.source.source_id)) +
      ' · ' + escape(report.source.published_at ?? '发布时间未知') + (report.superseded ? ' · 历史版本，已被后续修订替代' : '') + '</p><blockquote>' + escape(report.fact.evidence.text) + '</blockquote>' +
      (report.comparison?.relationship === 'conflict' ? '<p>来源说法存在冲突，尚未判定真伪。</p>' : '')).join('');
}
