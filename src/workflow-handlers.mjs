import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publish } from './daily-store.mjs';
import { validateEditionDocument } from './edition-document.mjs';
import { editionSpec } from './edition.mjs';
import { contentHash } from './content-store.mjs';
import { extractMessages, EXTRACTION_VERSION } from './editorial.mjs';
import { track, TRACKING_VERSION } from './tracking.mjs';
import { LocalSummaryStore } from './summary.mjs';
import { invalid } from './errors.mjs';

const success = ref => ({ status: 'succeeded', output_refs: [ref] });
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const modelIdentity = client => ({ model: client.model ?? 'injected', baseUrl: client.baseUrl ?? 'injected' });

/** Paid-result checkpoints belong to task execution; business modules only see a client. */
function checkpointedClient(client, store, signal, namespace) {
  return { async complete(messages, options = {}) {
    signal?.throwIfAborted();
    const key = 'model:' + contentHash({ namespace, model: modelIdentity(client), messages });
    const saved = store.getResult(key);
    if (saved) return saved;
    const response = await client.complete(messages, { ...options, signal });
    const result = { ...response, checkpoint_key: key };
    // Persist a received result even when the caller has just been cancelled.
    store.saveResult(key, result);
    signal?.throwIfAborted();
    return result;
  } };
}
async function artifact(directory, day, runId, value) {
  const path = join(directory, day, runId + '.json');
  await mkdir(join(directory, day), { recursive: true });
  try { await publish(path, JSON.stringify(value, null, 2) + '\n'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (contentHash(await readJson(path)) !== contentHash(value)) throw invalid('Stage artifact changed', 'workflow.artifact');
  }
  return path;
}
function input(context, kind) {
  const refs = context.input_refs.filter(ref => ref.kind === kind && ref.business_date === context.business_date);
  if (refs.length !== 1) throw invalid('Missing same-edition ' + kind, 'workflow.input');
  return refs[0];
}
function reference(context, kind, path) { return { kind, path, business_date: context.business_date }; }

export function prepareHandler({ store, directory, sourceIds, sourceVersions = {}, clock = () => new Date().toISOString() }) {
  return { async execute(context) {
    context.signal?.throwIfAborted();
    const spec = editionSpec(context);
    const expectedSources = context.parameters?.source_ids ?? sourceIds;
    const existing = store.edition(spec);
    let prepared = existing.prepared_json && JSON.parse(existing.prepared_json);
    if (!prepared) {
      const refs = context.input_refs.filter(ref => ref.kind === 'collection' && ref.business_date === context.business_date);
      if (refs.length !== expectedSources.length) throw invalid('Missing source batches', 'workflow.prepare');
      for (const ref of refs) {
        const bytes = await readFile(ref.path, 'utf8');
        const messages = bytes.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
        const sourceId = ref.source_id ?? messages[0]?.source_id;
        store.ingest(messages, { timezone: spec.timezone, sourceVersion: sourceVersions[sourceId] ?? '', baselineBefore: spec.window_start });
      }
      prepared = store.prepare(spec, expectedSources, { includeInitialHistory: spec.include_initial_history, preparedAt: clock() });
    }
    const path = await artifact(directory, context.business_date, context.run_id, prepared);
    return success(reference(context, 'prepared', path));
  } };
}

export function editHandler({ store, directory, client, batchSize = 20, clock = () => new Date().toISOString() }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw invalid('Invalid edit batch size', 'workflow.edit');
  return { async execute(context) {
    const prepared = await readJson(input(context, 'prepared').path);
    const items = [], inferences = [];
    const savedClient = checkpointedClient(client, store, context.signal, EXTRACTION_VERSION);
    for (let offset = 0; offset < prepared.items.length; offset += batchSize) {
      const batch = prepared.items.slice(offset, offset + batchSize);
      const key = 'extract:' + contentHash({ ids: batch.map(item => item.revision_id), prompt: EXTRACTION_VERSION, model: modelIdentity(client) });
      let result = store.getResult(key);
      if (!result) {
        result = await extractMessages(batch.map(item => item.source), { client: savedClient, signal: context.signal });
        result.processed_at = clock();
        store.saveResult(key, result);
      }
      items.push(...batch.map((item, index) => ({ ...item, input_index: offset + index, extraction: result.items[index],
        processed_at: result.processed_at, prompt_version: result.prompt_version })));
      inferences.push(result.inference);
    }
    const value = { spec: prepared.spec, prepared_at: prepared.prepared_at, items,
      source_reports: prepared.source_reports, inferences, prompt_version: EXTRACTION_VERSION };
    return success(reference(context, 'edited', await artifact(directory, context.business_date, context.run_id, value)));
  } };
}

export function trackingHandler({ store, directory, client }) {
  return { async execute(context) {
    const ref = input(context, 'edited');
    const edited = await readJson(ref.path);
    // Freeze exactly the history used by this edition before the first model call.
    const contextKey = 'history:' + contentHash({ edition: edited.spec.id, ids: edited.items.map(item => item.revision_id) });
    let historical = store.getResult(contextKey);
    if (!historical) historical = store.saveResult(contextKey, store.historicalCandidates());
    const key = 'tracking:' + contentHash({ edition: edited.spec.id, current: edited.items,
      historical, version: TRACKING_VERSION, model: modelIdentity(client) });
    let result = store.getResult(key);
    if (!result) {
      result = await track({ current: edited.items, historicalCandidates: historical },
        { client: checkpointedClient(client, store, context.signal, TRACKING_VERSION), signal: context.signal });
      store.saveResult(key, result);
    }
    store.applyTracking(result);
    const value = { edited_path: ref.path, spec: edited.spec, result };
    return success(reference(context, 'tracked', await artifact(directory, context.business_date, context.run_id, value)));
  } };
}

export function composeHandler({ store, directory, clock = () => new Date().toISOString() }) {
  return { async execute(context) {
    const tracked = await readJson(input(context, 'tracked').path);
    const edited = await readJson(tracked.edited_path);
    const archive = new LocalSummaryStore(directory, { businessDate: context.business_date });
    let document, path = join(directory, context.business_date, context.run_id + '.json');
    try { document = await readJson(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (document) {
      if (document.id !== context.run_id || document.schema_version !== 2 || contentHash(document.edition) !== contentHash(edited.spec))
        throw invalid('Existing edition document does not match', 'workflow.compose');
    }
    const expected = { schema_version: 2, id: context.run_id, created_at: document?.created_at ?? clock(),
        title: context.business_date + ' 个人日报', edition: edited.spec, prompt_version: edited.prompt_version,
        inference: { batches: edited.inferences }, source_reports: edited.source_reports,
        items: edited.items.map((item, index) => ({ input_index: index, summary: item.extraction.summary, source: item.source,
          material: { id: item.material_id, revision_id: item.revision_id, version: item.version,
            first_discovered_at: item.first_discovered_at, processed_at: item.processed_at, inclusion: item.reason },
          facts: item.extraction.facts, extraction_issues: item.extraction.issues,
          tracking: tracked.result.entries.filter(entry => entry.revision_id === item.revision_id) })) };
    if (document && contentHash(document) !== contentHash(expected)) throw invalid('Published document differs from frozen inputs', 'workflow.compose');
    if (!document) {
      document = expected;
      validateEditionDocument(document);
      path = (await archive.save(document)).path;
    }
    validateEditionDocument(document);
    store.registerDocument(edited.spec, document, path);
    return success({ ...reference(context, 'summary', path), id: document.id });
  } };
}
