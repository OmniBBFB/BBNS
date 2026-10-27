import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { dailyPlans } from '../src/scheduling.mjs';
import { businessDay, publish } from '../src/daily-store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { DeepSeekClient } from '../src/deepseek-client.mjs';
import { summaryHandler, pushHandler, wecomConnection } from '../src/task-handlers.mjs';
import { todayCollectionHandler } from '../src/today-collection.mjs';
import { fault, invalid } from '../src/errors.mjs';

const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const controller = new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => controller.abort());
let ledger;
try {
  const config = await read('config/scheduler.local.json');
  const subscriptions = new Subscriptions((await read(config.subscriptions_config)).sources);
  const summaryConfig = await read(config.summary_config), messagingConfig = await read(config.messaging_config);
  let manifest, manifestPath;
  if (process.argv[2] === '--resume') {
    if (!process.argv[3]) throw invalid('Missing manual manifest', 'manual.config');
    manifestPath = resolve(process.argv[3]); manifest = await read(manifestPath);
    if (manifest.business_date !== businessDay(new Date(), config.timezone)) throw invalid('Manual run is not for today', 'manual.config');
  } else {
    if (process.argv.length > 2) throw invalid('Unknown manual argument', 'manual.config');
    const id = randomUUID(), day = businessDay(new Date(), config.timezone);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const prefix = 'manual:' + id + ':';
    const plans = dailyPlans(subscriptions.list(), { timezone: config.timezone }).map(plan => ({
      ...plan, task_id: prefix + plan.task_id, depends_on: plan.depends_on.map(id => prefix + id),
      time, timezone: config.timezone, max_attempts: config.max_attempts ?? 3, lateness_ms: 3600000,
      timeout_ms: plan.handler === 'collect' ? 180000 : 900000, recovery: plan.handler === 'push' ? 'unknown' : 'retry'
    }));
    manifest = { id, business_date: day, created_at: new Date().toISOString(), mode: 'manual_today', plans };
    const directory = resolve('data/scheduler/manual', day);
    await mkdir(directory, { recursive: true });
    manifestPath = join(directory, id + '.json');
    await publish(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(JSON.stringify({ event: 'manual.start', manifest: manifestPath, business_date: manifest.business_date }));
  const handlers = {
    collect: todayCollectionHandler({ subscriptions, directory: resolve(config.collection_directory), timezone: config.timezone }),
    summarize: summaryHandler({ directory: resolve(config.summary_directory), collectionDirectory: resolve(config.collection_directory),
      client: new DeepSeekClient({ ...summaryConfig.client, apiKey: process.env.DEEPSEEK_API_KEY }), batchSize: config.summary_batch_size ?? 20 }),
    push: pushHandler({ summaryDirectory: resolve(config.summary_directory), deliveryDirectory: resolve(config.delivery_directory),
      target: config.target, partBytes: config.push_part_bytes ?? 1500, intervalMs: config.push_interval_ms ?? 3000,
      connect: () => wecomConnection(messagingConfig) })
  };
  ledger = new SchedulerLedger(config.database);
  const scheduler = new Scheduler({ ledger, plans: manifest.plans, handlers, timezone: config.timezone });
  scheduler.on('state', event => console.log(JSON.stringify({ event: 'task.state', ...event })));
  let report;
  do {
    report = await scheduler.tick({ signal: controller.signal });
    if (report.locked) { await delay(2000, undefined, { signal: controller.signal }); continue; }
    if (report.runs.every(row => !['pending','running','retry_wait'].includes(row.status))) break;
    await delay(5000, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
  const ids = new Set(manifest.plans.map(plan => plan.task_id));
  const rows = ledger.rows(manifest.business_date).filter(row => ids.has(row.task_id));
  const result = { manifest: manifestPath, business_date: manifest.business_date,
    status: rows.length === manifest.plans.length && rows.every(row => row.status === 'succeeded') ? 'succeeded' : 'failed',
    runs: rows.map(row => ({ task_id: row.task_id, status: row.status, attempt: row.attempt,
      outputs: row.output_refs, error_code: row.error?.code ?? null })) };
  try { await publish(manifestPath + '.result.json', JSON.stringify(result, null, 2) + '\n'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  console.log(JSON.stringify({ event: 'manual.result', ...result }));
  if (result.status !== 'succeeded') process.exitCode = 1;
} catch (error) {
  const info = fault(error, { operation: 'manual.run' });
  console.error(JSON.stringify({ code: info.code, operation: info.operation }));
  process.exitCode = 1;
} finally { ledger?.close(); }
