import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { businessDay, publish, validateDay } from './daily-store.mjs';
import { Scheduler, scheduledInstant, validatePlans } from './scheduler.mjs';
import { SchedulerLedger } from './scheduler-ledger.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { DeepSeekClient } from './deepseek-client.mjs';
import { editionPlans } from './scheduling.mjs';
import { createWorkflow } from './workflow.mjs';
import { wecomConnection } from './task-handlers.mjs';
import { fault, invalid } from './errors.mjs';

const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const controller = new AbortController();
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => controller.abort());
let ledger, workflow;
try {
  const [command = 'plan', configPath = 'config/workflow.local.json', argument, resumePath] = process.argv.slice(2);
  const config = await read(configPath);
  if (config.workflow_version !== 2) throw invalid('Version 2 configuration required', 'workflow.config');
  const subscriptions = new Subscriptions((await read(config.subscriptions_config)).sources);
  if (command === 'plan') {
    const day = validateDay(argument ?? config.start_date ?? businessDay(new Date(), config.timezone));
    const plans = editionPlans(subscriptions.list(), { timezone: config.timezone, cutoff: config.edition_cutoff,
      includeInitialHistory: config.include_initial_history });
    console.log(JSON.stringify({ business_date: day, plans: plans.map(plan => ({ ...plan,
      scheduled_at: scheduledInstant(day, plan.time, plan.timezone) })) }, null, 2));
  } else if (command === 'status') {
    ledger = new SchedulerLedger(config.database);
    const day = validateDay(argument ?? businessDay(new Date(), config.timezone));
    console.log(JSON.stringify({ business_date: day, runs: ledger.rows(day).map(row => ({
      task_id: row.task_id, status: row.status, attempt: row.attempt, error_code: row.error?.code ?? null })) }, null, 2));
  } else if (['check','tick','manual'].includes(command)) {
    const summary = await read(config.summary_config), messaging = await read(config.messaging_config);
    const client = new DeepSeekClient({ ...summary.client, apiKey: process.env.DEEPSEEK_API_KEY });
    const target = messaging.push?.targets?.[config.target];
    if (!target?.recipient_id || target.adapter_id !== messaging.adapter?.id) throw invalid('Invalid messaging target', 'workflow.config');
    for (const key of Object.values(messaging.adapter.credentials)) if (!process.env[key]?.trim())
      throw invalid('Missing messaging credential', 'workflow.config');
    workflow = createWorkflow({ config, subscriptions, client, connect: () => wecomConnection(messaging) });
    validatePlans(workflow.plans);
    if (command === 'check') {
      console.log(JSON.stringify({ status: 'ready', task_count: workflow.plans.length, external_connections: 'not_tested' }));
    } else {
      let plans = workflow.plans, manifestPath;
      if (command === 'manual') {
        const day = businessDay(new Date(), config.timezone);
        if (argument === '--resume') {
          if (!resumePath) throw invalid('Missing manual manifest', 'workflow.manual');
          const manifest = await read(resumePath);
          if (manifest.business_date !== day || manifest.workflow_version !== 2) throw invalid('Invalid manual manifest', 'workflow.manual');
          plans = manifest.plans; manifestPath = resolve(resumePath);
        } else {
          if (argument) throw invalid('Unknown manual argument', 'workflow.manual');
          const prefix = 'manual:' + randomUUID() + ':';
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date());
          plans = plans.map(plan => ({ ...plan, task_id: prefix + plan.task_id,
            depends_on: plan.depends_on.map(id => prefix + id), time: parts, timezone: config.timezone, lateness_ms: 3600000 }));
          const directory = resolve(config.stage_directory, day, 'manual');
          await mkdir(directory, { recursive: true });
          manifestPath = join(directory, randomUUID() + '.json');
          await publish(manifestPath, JSON.stringify({ workflow_version: 2, business_date: day, plans }, null, 2) + '\n');
        }
      }
      ledger = new SchedulerLedger(config.database);
      const scheduler = new Scheduler({ ledger, plans, handlers: workflow.handlers, timezone: config.timezone,
        ...(command === 'manual' ? {} : { startDate: config.start_date }) });
      scheduler.on('state', event => console.log(JSON.stringify({ event: 'task.state', ...event })));
      let report;
      do {
        report = await scheduler.tick({ signal: controller.signal });
        if (command !== 'manual' || (!report.locked && report.runs.every(row => !['pending','running','retry_wait'].includes(row.status)))) break;
        await delay(2000, undefined, { signal: controller.signal });
      } while (!controller.signal.aborted);
      console.log(JSON.stringify({ event: 'workflow.result', manifest: manifestPath, ...report }));
      if (report.runs?.some(row => ['failed','unknown','blocked','expired','partial'].includes(row.status))) process.exitCode = 1;
    }
  } else throw invalid('Unknown workflow command', 'workflow.cli');
} catch (error) {
  const info = fault(error, { operation: 'workflow.cli' });
  console.error(JSON.stringify({ code: info.code, operation: info.operation })); process.exitCode = 1;
} finally { ledger?.close(); workflow?.close(); }
