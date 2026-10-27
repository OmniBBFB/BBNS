import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const profile = await mkdtemp(join(tmpdir(), 'bbns-browser-'));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-background-networking', '--disable-extensions', '--no-first-run', '--hide-scrollbars',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    await delay(100);
  }
  assert.ok(port, 'Chrome failed to start');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = pages.find(page => page.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
    if (data.id) {
      const task = pending.get(data.id); pending.delete(data.id);
      if (data.error) task.reject(new Error(data.error.message)); else task.resolve(data.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error('UI assertion timed out: ' + expression);
  };
  await call('Page.enable'); await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: 'http://127.0.0.1:3080' });
  await waitFor("document.querySelectorAll('.news-card').length > 0 && document.getElementById('reader').getAttribute('aria-busy') === 'false'");
  const initial = await evaluate("({cards:document.querySelectorAll('.news-card').length,id:new URL(location.href).searchParams.get('id'),versions:document.getElementById('versions').options.length})");
  await evaluate("document.querySelector('[data-source=\"github-trending\"]').click()");
  assert.equal(await evaluate("document.querySelectorAll('.news-card').length"), 9);
  await evaluate("document.getElementById('search').value='zzzz-no-match';document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelectorAll('.news-card').length"), 0);
  assert.ok(await evaluate("!!document.querySelector('[data-clear]')"));
  await evaluate("document.querySelector('[data-clear]').click()");
  assert.equal(await evaluate("document.querySelectorAll('.news-card').length"), initial.cards);
  if (initial.versions > 1) {
    const another = await evaluate("document.getElementById('versions').options[document.getElementById('versions').options.length-1].value");
    await evaluate("document.getElementById('versions').value=" + JSON.stringify(another) + ";document.getElementById('versions').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("new URL(location.href).searchParams.get('id')===" + JSON.stringify(another));
    await evaluate("document.getElementById('versions').value=" + JSON.stringify(initial.id) + ";document.getElementById('versions').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("new URL(location.href).searchParams.get('id')===" + JSON.stringify(initial.id));
  }
  const output = resolve('data/verification');
  await mkdir(output, { recursive: true });
  const desktop = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'reader-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  const mobile = await evaluate("({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,cards:document.querySelectorAll('.news-card').length})");
  assert.ok(mobile.scrollWidth <= mobile.width + 1, 'Mobile page overflows horizontally');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'reader-mobile.png'), Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', initial, source_filter: 9, search_empty: true,
    version_switch: initial.versions > 1, mobile, console_errors: errors, screenshots: output }));
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  for (let i = 0; i < 30 && chrome.exitCode === null; i++) await delay(100);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  await delay(100);
  await rm(profile, { recursive: true, force: true });
}
