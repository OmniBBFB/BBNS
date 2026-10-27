import { boundary, requestSignal } from './errors.mjs';
import { load } from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { sourceMessage } from './source-message.mjs';
import { sourceTime } from './source-time.mjs';

const plain = html => load(String(html ?? '')).text().replace(/\s+/g, ' ').trim();
const date = value => sourceTime(value);
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];

export class HttpClient {
  constructor({ fetchImpl = fetch, timeoutMs = 20000 } = {}) { this.fetch = fetchImpl; this.timeoutMs = timeoutMs; }
  async get(url, { signal } = {}) {
    return boundary('collection.http', async () => {
      const response = await this.fetch(url, { signal: requestSignal(this.timeoutMs, signal),
        headers: { 'User-Agent': 'BBNS/1.0 (personal news reader)', Accept: 'application/json, application/rss+xml, text/html' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.http_status = response.status;
        error.retry_after = response.headers.get('retry-after');
        throw error;
      }
      return { text: await response.text(), metadata: {
        cache_control: response.headers.get('cache-control'), retry_after: response.headers.get('retry-after') } };
    }, { kind: 'dependency', signal });
  }
}

export class RssAdapter {
  constructor(http = new HttpClient()) { this.http = http; }
  async collect(request, { fetched_at, signal }) {
    return boundary('collection.adapter', async () => {
      const { text, metadata } = await this.http.get(request.options.url, { signal });
      if (XMLValidator.validate(text) !== true) throw new Error('Invalid RSS XML');
      const feed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(text);
      if (!feed.rss?.channel) throw new Error('Expected RSS 2.0 channel');
      const items = list(feed.rss.channel.item);
      return { metadata, truncated: items.length > request.limit,
        messages: items.slice(0, request.limit).map(item => sourceMessage(request.source_id, {
          source_item_id: String(item.guid?.['#text'] ?? item.guid ?? item.link ?? '') || null,
          title: plain(item.title), url: item.link ?? null, published_at: sourceTime(item.pubDate, request.options.utc_offset ?? '+08:00'),
          data: { source_updated_at: sourceTime(item.updated, request.options.utc_offset ?? '+08:00'),
            source_time: { published_raw: item.pubDate ?? null, updated_raw: item.updated ?? null, utc_offset: request.options.utc_offset ?? '+08:00' } },
          content: { text: plain(item['content:encoded'] ?? item.description), format: 'text',
            completeness: item['content:encoded'] ? 'full' : 'summary' }
        }, fetched_at)) };
    }, { kind: 'validation', signal });
  }
}

export class AihotAdapter {
  constructor(http = new HttpClient()) { this.http = http; }
  async collect(request, { fetched_at, signal }) {
    return boundary('collection.adapter', async () => {
      const messages = [];
      let cursor;
      let metadata;
      const cursors = new Set();
      while (messages.length < request.limit) {
        const url = new URL('https://aihot.news/api/v1/items');
        url.searchParams.set('mode', request.options.mode ?? 'selected');
        url.searchParams.set('window', request.options.window ?? '24h');
        url.searchParams.set('limit', Math.min(100, request.limit - messages.length));
        if (request.options.category) url.searchParams.set('category', request.options.category);
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await this.http.get(url, { signal });
        metadata = response.metadata;
        const body = JSON.parse(response.text);
        if (!Array.isArray(body.items) || !body.page || typeof body.page.hasMore !== 'boolean') throw new Error('Unexpected AIHOT response');
        messages.push(...body.items.slice(0, request.limit - messages.length).map(item => sourceMessage(request.source_id, {
          source_item_id: item.id, title: item.title, url: item.links?.original ?? item.links?.aihot ?? null,
          published_at: date(item.publishedAt),
          content: { text: item.summary ?? '', format: 'text', completeness: 'summary' },
          source_signals: { score: item.score ?? null, selected: item.selected ?? null, reason: item.reason ?? null },
          data: { publisher: item.source ?? null, attribution: item.attribution ?? null, links: item.links ?? {},
            category: item.category ?? null, discovered_at: date(item.discoveredAt) }
        }, fetched_at)));
        if (!body.page.hasMore) return { messages, metadata, truncated: false };
        cursor = body.page.nextCursor;
        if (!body.items.length || !cursor || cursors.has(cursor)) throw new Error('Invalid AIHOT pagination');
        cursors.add(cursor);
      }
      return { messages, metadata, truncated: true };
    }, { kind: 'validation', signal });
  }
}

export class GithubTrendingAdapter {
  constructor(http = new HttpClient()) { this.http = http; }
  async collect(request, { fetched_at, signal }) {
    return boundary('collection.adapter', async () => {
      const url = new URL('https://github.com/trending' + (request.options.language ? '/' + encodeURIComponent(request.options.language) : ''));
      url.searchParams.set('since', 'daily');
      const { text, metadata } = await this.http.get(url, { signal });
      const $ = load(text);
      const rows = $('article.Box-row').toArray();
      if (!rows.length) throw new Error('GitHub Trending rows missing; page may have changed');
      const number = value => Number(value.replace(/[^0-9]/g, '')) || 0;
      return { metadata, truncated: rows.length > request.limit,
        messages: rows.slice(0, request.limit).map((row, index) => {
          const entry = $(row);
          const path = entry.find('h2 a').attr('href');
          if (!/^\/[^/]+\/[^/]+$/.test(path ?? '')) throw new Error('Invalid Trending repository');
          const starsToday = entry.find('.float-sm-right').text().trim();
          return sourceMessage(request.source_id, {
            source_item_id: path.slice(1), kind: 'ranking_entry', title: path.slice(1),
            url: new URL(path, 'https://github.com').href, observed_at: fetched_at,
            content: { text: entry.find('p').text().replace(/\s+/g, ' ').trim(), format: 'text', completeness: 'summary' },
            source_signals: { rank: index + 1, stars_today: starsToday ? number(starsToday) : null },
            data: { period: 'daily', language_filter: request.options.language ?? null,
              language: entry.find('[itemprop="programmingLanguage"]').text().trim() || null,
              stars: number(entry.find('a[href$="/stargazers"]').text()), snapshot_url: url.href }
          }, fetched_at);
        }) };
    }, { kind: 'validation', signal });
  }
}

export function defaultAdapters(http = new HttpClient()) {
  return { rss: new RssAdapter(http), aihot: new AihotAdapter(http), github_trending: new GithubTrendingAdapter(http) };
}
