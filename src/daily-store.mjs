import { mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundary, invalid } from './errors.mjs';
import { validateSourceMessage } from './source-message.mjs';

export function validateDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day + 'T00:00:00Z')) ||
      new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) {
    throw invalid('Invalid business date', 'storage.date');
  }
  return day;
}

export function businessDay(instant = new Date(), timezone = 'Asia/Shanghai') {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw invalid('Invalid instant', 'storage.date');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

/** Same-filesystem atomic publication; no overwrite, no append retry. */
export async function publish(path, content) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  let primary;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await link(temporary, path);
  } catch (error) { primary = error; throw error; }
  finally {
    try { await unlink(temporary); }
    catch (error) {
      if (error.code !== 'ENOENT' && !primary) {
        // Publication may already have succeeded. Never blindly retry the write.
        throw Object.assign(error, { fault: { schema_version: 1, code: 'CLEANUP_FAILED',
          category: 'storage', operation: 'storage.cleanup', retryable: false,
          outcome: 'unknown', message: 'Publication cleanup failed', http_status: null, retry_after_ms: null } });
      }
    }
  }
}

/** Immutable files per run. SourceMessage schema and no-dedup semantics are unchanged. */
export class DailyMessageStore {
  constructor(directory, { businessDate, timezone = 'Asia/Shanghai' } = {}) {
    this.directory = resolve(directory); this.businessDate = businessDate; this.timezone = timezone;
  }
  async save(messages, { businessDate = this.businessDate ?? businessDay(new Date(), this.timezone), runId = randomUUID() } = {}) {
    return boundary('collection.store.save', async () => {
      validateDay(businessDate);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw invalid('Invalid run id', 'collection.store.save');
      for (const message of messages) {
        try { validateSourceMessage(message); }
        catch (error) { throw invalid(error.message, 'collection.store.validate'); }
      }
      const directory = join(this.directory, businessDate);
      await mkdir(directory, { recursive: true });
      const path = join(directory, runId + '.jsonl');
      await publish(path, messages.map(message => JSON.stringify(message) + '\n').join(''));
      return { count: messages.length, path, business_date: businessDate, run_id: runId };
    }, { kind: 'storage' });
  }
}
