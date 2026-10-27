import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectToday } from '../src/today-collection.mjs';
import { sourceMessage } from '../src/source-message.mjs';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { Scheduler, scheduledInstant } from '../src/scheduler.mjs';

test('today selection uses publication/observation dates in Shanghai and excludes undated history', () => {
  const make = (extra = {}) => sourceMessage('feed', { title: 'news', ...extra }, '2026-10-23T08:00:00Z');
  const today = make({ published_at: '2026-10-22T16:30:00Z' });
  const old = make({ published_at: '2026-10-22T15:59:00Z' });
  const undated = make();
  const ranking = make({ kind: 'ranking_entry', observed_at: '2026-10-23T08:00:00Z' });
  const result = selectToday([today,old,undated,ranking], '2026-10-23');
  assert.deepEqual(result.selected, [today,ranking]);
  assert.deepEqual(result.counts, { fetched: 4, selected: 2, other_date: 1, undated: 1 });
});

test('manual engine only executes its registered task namespace, leaving automatic tasks untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bbns-manual-'));
  const ledger = new SchedulerLedger(join(directory, 'state.sqlite'));
  try {
    const base = { handler: 'collect', depends_on: [], time: '08:00', timezone: 'Asia/Shanghai',
      max_attempts: 3, timeout_ms: 30000, recovery: 'retry' };
    ledger.seed('2026-10-23', [{ ...base, task_id: 'collect:auto',
      scheduled_at: scheduledInstant('2026-10-23', '08:00', 'Asia/Shanghai'),
      deadline: scheduledInstant('2026-10-23', '23:59', 'Asia/Shanghai') }]);
    let calls = 0;
    const scheduler = new Scheduler({ ledger, plans: [{ ...base, task_id: 'manual:id:collect:feed' }],
      handlers: { collect: { execute: async () => { calls++; return { status: 'succeeded', output_refs: [] }; } } },
      clock: () => Date.parse('2026-10-23T09:00:00Z') });
    const report = await scheduler.tick();
    assert.equal(calls, 1);
    assert.equal(report.runs.length, 1);
    assert.equal(ledger.rows('2026-10-23').find(row => row.task_id === 'collect:auto').status, 'pending');
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
