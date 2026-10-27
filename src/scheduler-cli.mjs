import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { businessDay, validateDay } from './daily-store.mjs';
import { dailyPlans } from './scheduling.mjs';
import { Scheduler, scheduledInstant, validatePlans } from './scheduler.mjs';
import { SchedulerLedger } from './scheduler-ledger.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { DeepSeekClient } from './deepseek-client.mjs';
import { todayCollectionHandler } from './today-collection.mjs';
import { summaryHandler, pushHandler, wecomConnection } from './task-handlers.mjs';
import { fault, invalid } from './errors.mjs';

const readJson = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
let ledger;
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
try {
  const [command = 'status', configPath = 'config/scheduler.local.json', requestedDay] = process.argv.slice(2);
  const config = await readJson(configPath);
  const subscriptionsConfig = await readJson(config.subscriptions_config);
  const subscriptions = new Subscriptions(subscriptionsConfig.sources);
  const plans = dailyPlans(subscriptions.list(), { timezone: config.timezone }).map(plan => ({
    ...plan, max_attempts: config.max_attempts ?? 3,
    timeout_ms: plan.handler === 'summarize' ? 900000 : plan.handler === 'push' ? 900000 : 180000,
    recovery: plan.handler === 'push' ? 'unknown' : 'retry',
    ...(plan.handler === 'push' ? { lateness_ms: (config.push_lateness_minutes ?? 60) * 60000 } : {})
  }));
  validatePlans(plans);
  if (config.start_date) validateDay(config.start_date);
  if (command === 'plan') {
    const day = validateDay(requestedDay ?? config.start_date ?? businessDay(new Date(), config.timezone));
    console.log(JSON.stringify({ business_date: day, plans: plans.map(plan => ({
      task_id: plan.task_id, scheduled_at: scheduledInstant(day, plan.time, plan.timezone), depends_on: plan.depends_on
    })) }, null, 2));
  } else if (command === 'status') {
    ledger = new SchedulerLedger(config.database);
    const day = validateDay(requestedDay ?? businessDay(new Date(), config.timezone));
    console.log(JSON.stringify({ business_date: day, start_date: config.start_date,
      runs: ledger.rows(day).map(row => ({ task_id: row.task_id, status: row.status, attempt: row.attempt,
        scheduled_at: row.scheduled_at, next_attempt_at: row.next_attempt_at, outputs: row.output_refs, error_code: row.error?.code ?? null })) }, null, 2));
  } else if (command === 'check' || command === 'tick') {
    const summaryConfig = await readJson(config.summary_config);
    const messagingConfig = await readJson(config.messaging_config);
    const client = new DeepSeekClient({ ...summaryConfig.client, apiKey: process.env.DEEPSEEK_API_KEY });
    const target = messagingConfig.push?.targets?.[config.target];
    if (messagingConfig.adapter?.type !== 'wecom_aibot' || !target?.recipient_id ||
        target.adapter_id !== messagingConfig.adapter.id) throw invalid('Invalid configured push target', 'scheduler.config');
    for (const key of Object.values(messagingConfig.adapter.credentials))
      if (!process.env[key]?.trim()) throw invalid('Missing messaging credentials', 'scheduler.config');
    const handlers = {
      collect: todayCollectionHandler({ subscriptions, directory: resolve(config.collection_directory), timezone: config.timezone }),
      summarize: summaryHandler({ directory: resolve(config.summary_directory), collectionDirectory: resolve(config.collection_directory),
        client, batchSize: config.summary_batch_size ?? 20 }),
      push: pushHandler({ summaryDirectory: resolve(config.summary_directory), deliveryDirectory: resolve(config.delivery_directory),
        target: config.target, partBytes: config.push_part_bytes ?? 1500, intervalMs: config.push_interval_ms ?? 3000, connect: () => wecomConnection(messagingConfig) })
    };
    if (command === 'check') {
      console.log(JSON.stringify({ status: 'ready', task_count: plans.length, timezone: config.timezone, start_date: config.start_date,
        credential_check: 'present', external_connections: 'not_tested' }));
    } else {
      ledger = new SchedulerLedger(config.database);
      const scheduler = new Scheduler({ ledger, plans, handlers, timezone: config.timezone, startDate: config.start_date });
      scheduler.on('state', event => console.log(JSON.stringify({ event: 'task.state', ...event })));
      const report = await scheduler.tick({ signal: controller.signal });
      console.log(JSON.stringify({ event: 'scheduler.tick', ...report }));
      if (report.runs.some(row => ['failed', 'unknown', 'blocked'].includes(row.status))) process.exitCode = 1;
    }
  } else throw invalid('Unknown scheduler command', 'scheduler.cli');
} catch (error) {
  const info = fault(error, { operation: 'scheduler.cli' });
  console.error(JSON.stringify({ code: info.code, operation: info.operation }));
  process.exitCode = 1;
} finally { ledger?.close(); }
