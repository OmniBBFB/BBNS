import { resolve } from 'node:path';
import { editionPolicy } from './edition.mjs';
import { ContentStore, contentHash } from './content-store.mjs';
import { editionPlans } from './scheduling.mjs';
import { collectionHandler, pushHandler } from './task-handlers.mjs';
import { prepareHandler, editHandler, trackingHandler, composeHandler } from './workflow-handlers.mjs';
import { invalid } from './errors.mjs';

/** Explicit assembly. Existing deployed entry is kept until the documented service cutover. */
export function createWorkflow({ config, subscriptions, client, connect, adapters, clock }) {
  if (config.workflow_version !== 2 || !config.content_database || !config.stage_directory)
    throw invalid('Use a version 2 workflow configuration', 'workflow.config');
  editionPolicy({ timezone: config.timezone,
    cutoff: config.edition_cutoff ?? '08:00', include_initial_history: config.include_initial_history ?? false });
  if (config.database && resolve(config.database) === resolve(config.content_database))
    throw invalid('Content and execution databases must be separate', 'workflow.config');
  const plans = editionPlans(subscriptions.list(), { timezone: config.timezone, cutoff: config.edition_cutoff ?? '08:00',
    includeInitialHistory: config.include_initial_history ?? false }).map(plan => ({ ...plan,
    max_attempts: config.max_attempts ?? 3, timeout_ms: plan.handler === 'collect' ? 180000 : 900000,
    recovery: plan.handler === 'push' ? 'unknown' : 'retry',
    ...(plan.handler === 'push' ? { lateness_ms: (config.push_lateness_minutes ?? 60) * 60000 } : {}) }));
  const store = new ContentStore(resolve(config.content_database));
  try {
    const directory = resolve(config.stage_directory), summaryDirectory = resolve(config.summary_directory);
    const sourceIds = subscriptions.list().filter(source => source.enabled).map(source => source.id);
    const sourceVersions = Object.fromEntries(subscriptions.list().map(source => [source.id,
      contentHash({ adapter: source.adapter, options: source.options ?? {}, limit: source.limit })]));
    const handlers = {
      collect: collectionHandler({ subscriptions, directory: resolve(config.collection_directory), adapters }),
      prepare: prepareHandler({ store, directory, sourceIds, sourceVersions, clock }),
      edit: editHandler({ store, directory, client, batchSize: config.summary_batch_size ?? 20, clock }),
      track: trackingHandler({ store, directory, client }),
      compose: composeHandler({ store, directory: summaryDirectory, clock }),
      push: pushHandler({ summaryDirectory, deliveryDirectory: resolve(config.delivery_directory), target: config.target,
        connect, intervalMs: config.push_interval_ms ?? 3000, partBytes: config.push_part_bytes ?? 1500 })
    };
    return { plans, handlers, store, close: () => store.close() };
  } catch (error) { store.close(); throw error; }
}
