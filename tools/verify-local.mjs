import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Subscriptions } from '../src/subscriptions.mjs';
import { CollectionExecutor } from '../src/collection.mjs';
import { defaultAdapters } from '../src/source-adapters.mjs';
import { DailyMessageStore, businessDay } from '../src/daily-store.mjs';
import { DeepSeekClient } from '../src/deepseek-client.mjs';
import { summaryHandler, wecomConnection } from '../src/task-handlers.mjs';
import { fault } from '../src/errors.mjs';

let connection;
try {
  const read = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
  const config = await read('config/scheduler.local.json');
  const sources = new Subscriptions((await read(config.subscriptions_config)).sources);
  const requests = sources.requests().map(request => ({ ...request, limit: 1 }));
  const collected = await new CollectionExecutor(defaultAdapters()).execute(requests);
  console.log(JSON.stringify({ stage: 'collection', results: collected.results.map(result =>
    ({ source_id: result.source_id, status: result.status, count: result.count, error_code: result.error?.code ?? null })) }));
  if (!collected.messages.length) throw new Error('No live source available');
  const day = businessDay(), saved = await new DailyMessageStore(config.collection_directory, { businessDate: day })
    .save(collected.messages, { runId: 'acceptance-' + randomUUID() });
  const summaryConfig = await read(config.summary_config);
  const handler = summaryHandler({ directory: resolve(config.summary_directory), collectionDirectory: resolve(config.collection_directory),
    client: new DeepSeekClient({ ...summaryConfig.client, apiKey: process.env.DEEPSEEK_API_KEY }), batchSize: config.summary_batch_size });
  const result = await handler.execute({ business_date: day, run_id: randomUUID(),
    input_refs: [{ kind: 'collection', path: saved.path, business_date: day }] });
  console.log(JSON.stringify({ stage: 'summary', status: result.status, output_refs: result.output_refs }));
  const messagingConfig = await read(config.messaging_config);
  connection = wecomConnection({ ...messagingConfig, inbound: { handler: 'none' } });
  await connection.connect();
  console.log(JSON.stringify({ stage: 'channel', status: 'authenticated', messages_sent: 0 }));
  if (collected.results.some(result => result.status === 'failed')) process.exitCode = 1;
} catch (error) {
  const info = fault(error, { operation: 'acceptance' });
  console.error(JSON.stringify({ code: info.code, operation: info.operation }));
  process.exitCode = 1;
} finally { connection?.close(); }
