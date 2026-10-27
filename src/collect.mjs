import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Subscriptions } from './subscriptions.mjs';
import { CollectionExecutor } from './collection.mjs';
import { defaultAdapters } from './source-adapters.mjs';
import { DailyMessageStore, businessDay } from './daily-store.mjs';
import { fault } from './errors.mjs';

// One-shot composition root; future scheduler/agent may call the same interfaces.
try {
  const [configPath = 'config/subscriptions.example.json', ...sourceIds] = process.argv.slice(2);
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  const subscriptions = new Subscriptions(config.sources);
  const day = businessDay();
  const run = await new CollectionExecutor(defaultAdapters()).execute(subscriptions.requests(sourceIds.length ? sourceIds : undefined));
  const saved = await new DailyMessageStore(config.storage.directory ?? 'data/subscriptions', { businessDate: day }).save(run.messages, { runId: run.run_id });
  const { messages, ...report } = run;
  console.log(JSON.stringify({ ...report, saved }, null, 2));
  if (run.results.some(result => result.status === 'failed')) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ code: fault(error).code, operation: fault(error).operation })); process.exitCode = 1; }
