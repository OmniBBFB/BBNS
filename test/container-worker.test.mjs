import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker } from '../tools/container-worker.mjs';

test('container worker continues after a failed tick and exits when stopped during idle', async () => {
  const controller = new AbortController();
  let exits = 0;
  await runWorker({ command: process.execPath, args: ['-e', 'process.exit(1)'], intervalMs: 1,
    signal: controller.signal, onExit: ({ code }) => {
      assert.equal(code, 1);
      if (++exits === 2) controller.abort();
    } });
  assert.equal(exits, 2);
});

test('container worker forwards shutdown to the running tick and does not start another', async () => {
  const controller = new AbortController();
  let exits = 0;
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await runWorker({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      signal: controller.signal, onExit: ({ signal }) => { exits++; assert.equal(signal, 'SIGTERM'); } });
  } finally { clearTimeout(timer); }
  assert.equal(exits, 1);
});
