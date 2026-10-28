import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Run one tick at a time; task retries and delivery decisions stay in the scheduler. */
export async function runWorker({ command, args, signal, intervalMs = 60000, onExit = () => {} }) {
  while (!signal.aborted) {
    await new Promise((resolveTick, reject) => {
      const child = spawn(command, args, { stdio: 'inherit' });
      const stop = () => child.kill('SIGTERM');
      signal.addEventListener('abort', stop, { once: true });
      child.once('error', reject);
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', stop);
        onExit({ code, signal: exitSignal }); resolveTick();
      });
      if (signal.aborted) stop();
    });
    if (!signal.aborted) {
      try { await delay(intervalMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.argv[2] ?? 'config/scheduler.local.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const cli = config.workflow_version === 2 ? 'src/workflow-cli.mjs' : 'src/scheduler-cli.mjs';
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  console.log(JSON.stringify({ event: 'worker.ready', cli, config: configPath }));
  await runWorker({ command: process.execPath, args: [cli, 'tick', configPath], signal: controller.signal,
    onExit: result => console.log(JSON.stringify({ event: 'worker.tick_exit', ...result })) });
}
