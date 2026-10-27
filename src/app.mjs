import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ContentReader } from './content-reader.mjs';
import { SummaryReader } from './summary-reader.mjs';
import { createReaderServer } from './reader-server.mjs';

let server;
try {
  let config = { host: '127.0.0.1', port: 3080 };
  try { config = { ...config, ...JSON.parse(await readFile(resolve('config/app.local.json'), 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scheduler = JSON.parse(await readFile(resolve(config.scheduler_config ?? 'config/scheduler.local.json'), 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('INVALID_PORT');
  server = createReaderServer({ reader: new SummaryReader(scheduler.summary_directory, { timezone: scheduler.timezone,
      contentReader: scheduler.content_database ? new ContentReader(scheduler.content_database) : null }),
    onError: event => console.error(JSON.stringify(event)) });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(config.port, config.host, resolve);
  });
  console.log(JSON.stringify({ event: 'app.ready', url: 'http://' + config.host + ':' + config.port }));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return; stopping = true;
    server.close(() => { console.log(JSON.stringify({ event: 'app.stopped' })); });
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 5000); timer.unref();
  });
} catch (error) {
  console.error(JSON.stringify({ event: 'app.failed', code: error.code ?? 'APP_START_FAILED' }));
  process.exitCode = 1;
  server?.close();
}
