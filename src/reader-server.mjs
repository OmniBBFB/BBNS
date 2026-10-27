import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ReadError } from './summary-reader.mjs';

const assets = new Map([
  ['/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['../web/styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['../web/app.mjs', 'text/javascript; charset=utf-8']],
  ['/view.mjs', ['../web/view.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['../web/favicon.svg', 'image/svg+xml']]
]);
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
};
export function createReaderServer({ reader, onError = () => {} }) {
  const server = createServer(async (request, response) => {
    const send = (status, type, body, extra = {}) => {
      response.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const json = (status, object, extra) => send(status, 'application/json; charset=utf-8', JSON.stringify(object), extra);
    // Every route is read-only, including unsupported API paths.
    if (!['GET', 'HEAD'].includes(request.method)) {
      json(405, { error: 'READ_ONLY' }, { Allow: 'GET, HEAD' }); return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') { json(200, { status: 'ok', application: 'bbns', read_only: true }); return; }
      const story = /^\/api\/stories\/(s_[a-f0-9]{32})$/.exec(url.pathname);
      if (story) {
        const result = await reader.story(story[1]);
        json(result ? 200 : 404, result ?? { error: 'NOT_FOUND' }); return;
      }
      if (url.pathname === '/api/summaries') { json(200, await reader.catalog()); return; }
      const detail = /^\/api\/summaries\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        json(200, await reader.get(decodeURIComponent(detail[1]), decodeURIComponent(detail[2]))); return;
      }
      const asset = assets.get(url.pathname);
      if (asset) {
        send(200, asset[1], await readFile(fileURLToPath(new URL(asset[0], import.meta.url)))); return;
      }
      json(404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = error instanceof ReadError ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 500) onError({ code: error.code ?? 'READ_FAILED', operation: 'reader.query' });
      json(status, { error: status === 500 ? 'ARCHIVE_UNAVAILABLE' : error.code ?? 'INVALID_REQUEST' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return server;
}
