import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectionHandler } from './task-handlers.mjs';
import { businessDay, DailyMessageStore, publish } from './daily-store.mjs';
import { validateSourceMessage } from './source-message.mjs';
import { boundary } from './errors.mjs';

/** Calendar-date selection belongs to the task adapter, never the scheduler. */
export function selectToday(messages, day, timezone = 'Asia/Shanghai') {
  const selected = [], counts = { fetched: messages.length, selected: 0, other_date: 0, undated: 0 };
  const seen = new Set();
  for (const message of messages) {
    validateSourceMessage(message);
    const time = message.kind === 'ranking_entry' ? message.observed_at : message.published_at;
    if (!time) counts.undated++;
    else if (businessDay(time, timezone) !== day) counts.other_date++;
    else {
      const identity = message.source_item_id || message.url;
      const key = identity ? JSON.stringify([message.source_id, identity, message.kind]) : null;
      if (key && seen.has(key)) { counts.duplicates = (counts.duplicates ?? 0) + 1; continue; }
      if (key) seen.add(key);
      selected.push(message);
    }
  }
  counts.selected = selected.length;
  return { selected, counts };
}

export function todayCollectionHandler(options) {
  const base = collectionHandler(options);
  return { async execute(context) {
    return boundary('task.collect.today', async () => {
      const raw = await base.execute(context);
      if (raw.status !== 'succeeded') return raw;
      const path = join(options.directory, context.business_date, context.run_id + '-today.jsonl');
      const reportPath = join(options.directory, context.business_date, context.run_id + '-selection.json');
      try {
        await readFile(path);
        const counts = JSON.parse(await readFile(reportPath, 'utf8'));
        return { status: 'succeeded', output_refs: [{ kind: 'collection', path, business_date: context.business_date, source_id: context.config_ref, counts }] };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const bytes = await readFile(raw.output_refs[0].path, 'utf8');
      const messages = bytes.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      const { selected, counts } = selectToday(messages, context.business_date, options.timezone);
      // Publish report first; if interrupted, a report without a selected batch is safe to rebuild.
      try { await publish(reportPath, JSON.stringify(counts) + '\n'); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const saved = await new DailyMessageStore(options.directory).save(selected,
        { businessDate: context.business_date, runId: context.run_id + '-today' });
      return { status: 'succeeded', output_refs: [{ kind: 'collection', path: saved.path, business_date: context.business_date, source_id: context.config_ref, counts }] };
    }, { signal: context.signal });
  } };
}
