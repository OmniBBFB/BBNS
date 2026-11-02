import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { businessDay } from '../src/daily-store.mjs';
import { SchedulerLedger } from '../src/scheduler-ledger.mjs';
import { fault, invalid } from '../src/errors.mjs';

/** Explicit upgrade for today's never-started tasks; task IDs, inputs and deadlines survive. */
export function recoverSourceFailurePolicy({ ledger, timezone = 'Asia/Shanghai', now = Date.now(), apply = false }) {
  const day = businessDay(now, timezone), owner = ledger.acquire();
  if (!owner) throw invalid('Scheduler is running; stop worker before recovery', 'source_failure.recover');
  try {
    return ledger.transaction(() => {
      const rows = ledger.rows(day), summary = rows.find(row => row.task_id === 'summarize');
      const untouchedBlock = row => row?.status === 'blocked' && row.attempt === 0 &&
        row.error?.code === 'DEPENDENCY_FAILED' && row.output_refs.length === 0;
      if (!untouchedBlock(summary)) return { business_date: day, apply, tasks: [] };
      const dependencies = summary.plan.depends_on.map(id => rows.find(row => row.task_id === id));
      if (summary.plan.handler !== 'summarize' || !dependencies.length || dependencies.some(row =>
        !row || row.plan.handler !== 'collect' || !['succeeded', 'failed', 'blocked', 'expired', 'partial', 'unknown'].includes(row.status)) ||
        dependencies.every(row => row.status === 'succeeded'))
        throw invalid('Blocked summary does not match source failure recovery', 'source_failure.recover');
      const targets = [{ row: summary, plan: { ...summary.plan, dependency_policy: 'settled' } }];
      const push = rows.find(row => row.task_id === 'push');
      if (untouchedBlock(push) && push.plan.handler === 'push' &&
          push.plan.depends_on.length === 1 && push.plan.depends_on[0] === summary.task_id)
        targets.push({ row: push, plan: push.plan });
      if (apply) for (const { row, plan } of targets) {
        ledger.db.prepare(`UPDATE runs SET status='pending',error_json=NULL,finished_at=NULL,next_attempt_at=NULL,plan_json=?
          WHERE run_id=?`).run(JSON.stringify(plan), row.run_id);
        ledger.event(row.run_id, 'task.source_failure_policy_recovered', new Date(now).toISOString(), {
          previous_status: row.status, previous_error_code: row.error.code, dependency_policy: plan.dependency_policy ?? 'succeeded'
        });
      }
      return { business_date: day, apply, tasks: targets.map(({ row }) => row.task_id) };
    });
  } finally { ledger.release(owner); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let ledger;
  try {
    const [configPath = 'config/scheduler.local.json', mode] = process.argv.slice(2);
    if (mode !== undefined && mode !== '--apply') throw invalid('Use --apply or omit it for dry run', 'source_failure.recover');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config.workflow_version === 2) throw invalid('Recovery is for the deployed daily workflow', 'source_failure.recover');
    ledger = new SchedulerLedger(config.database);
    console.log(JSON.stringify(recoverSourceFailurePolicy({ ledger, timezone: config.timezone, apply: mode === '--apply' })));
  } catch (error) {
    const info = fault(error, { operation: 'source_failure.recover' });
    console.error(JSON.stringify({ code: info.code, operation: info.operation }));
    process.exitCode = 1;
  } finally { ledger?.close(); }
}
