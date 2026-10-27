import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(join(process.env.HALLMARK_PUPPETEER || process.cwd(), 'package.json'));
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.news-card');
  const initial = await page.$$eval('.news-card', cards => cards.length);
  await page.click('[data-source="github-trending"]');
  assert.equal(new URL(page.url()).searchParams.get('source'), 'github-trending');
  const filtered = await page.$$eval('.news-card', cards => cards.length);
  assert.ok(filtered > 0 && filtered < initial);
  await page.type('#search', 'zz-no-such-news-zz');
  assert.equal(await page.$$eval('.news-card', cards => cards.length), 0);
  assert.ok(new URL(page.url()).searchParams.get('q'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-clear]');
  assert.equal(await page.$eval('#search', input => input.value), 'zz-no-such-news-zz');
  assert.equal(new URL(page.url()).searchParams.get('source'), 'github-trending');
  await page.click('[data-clear]');
  assert.equal(await page.$$eval('.news-card', cards => cards.length), initial);
  await page.focus('#search');
  await page.keyboard.press('Tab');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.$eval('#search', input => getComputedStyle(input).outlineStyle), 'solid');
  assert.equal(await page.$eval('.summary-text', el => getComputedStyle(el).fontSize), '16px');
  await page.focus('[data-source="github-trending"]');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.source), 'github-trending');
  for (const width of [320, 375, 414, 1280, 1920]) {
    await page.setViewport({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at ' + width);
    assert.ok(await page.$eval('#refresh', el => el.getBoundingClientRect().height >= 44));
    assert.ok(await page.$eval('#search', el => el.getBoundingClientRect().height >= 44));
  }
  await page.setRequestInterception(true);
  let mode = 'empty';
  page.on('request', request => {
    if (request.url().endsWith('/api/summaries')) {
      if (mode === 'error') request.respond({ status: 503, contentType: 'application/json', body: '{}' });
      else request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [], dates: [], unavailable: 0 }) });
    } else request.continue();
  });
  await page.reload({ waitUntil: 'networkidle0' });
  assert.match(await page.$eval('#articles', el => el.textContent), /还没有总结归档/);
  mode = 'error';
  await page.reload({ waitUntil: 'networkidle0' });
  assert.match(await page.$eval('#articles', el => el.textContent), /暂时无法打开简报/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', url_restore: true, keyboard_focus: true, viewport_widths: [320,375,414,1280,1920], empty_and_error: true, console_errors: errors }));
} finally { await browser.close(); }
