import { EventEmitter } from 'node:events';
import { fault, invalid, retryDecision } from './errors.mjs';
import { businessDay, validateDay } from './daily-store.mjs';

function localParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(instant);
  const get = type => parts.find(part => part.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute');
}

export function scheduledInstant(day, time, timezone) {
  validateDay(day);
  const target = day + 'T' + time;
  let instant = Date.parse(target + ':00Z');
  for (let i = 0; i < 6; i++) {
    const formatted = localParts(new Date(instant), timezone);
    if (formatted === target) return new Date(instant).toISOString();
    instant += Date.parse(target + ':00Z') - Date.parse(formatted + ':00Z');
  }
  throw invalid('Nonexistent local schedule time', 'schedule.timezone');
}

export function validatePlans(plans) {
  const ids = new Set();
  for (const plan of plans) {
    if (typeof plan.task_id !== 'string' || !plan.task_id || ids.has(plan.task_id) ||
        typeof plan.handler !== 'string' || !Array.isArray(plan.depends_on) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plan.time)) throw invalid('Invalid task plan', 'schedule.config');
    ids.add(plan.task_id);
    try { new Intl.DateTimeFormat('en-US', { timeZone: plan.timezone }); }
    catch { throw invalid('Invalid task timezone', 'schedule.config'); }
    if (plan.lateness_ms != null && (!Number.isFinite(plan.lateness_ms) || plan.lateness_ms < 0))
      throw invalid('Invalid task deadline window', 'schedule.config');
    if (plan.recovery !== 'retry' && plan.recovery !== 'unknown') throw invalid('Invalid recovery policy', 'schedule.config');
    if (!Number.isInteger(plan.timeout_ms) || plan.timeout_ms < 1) throw invalid('Invalid task timeout', 'schedule.config');
    if (!Number.isInteger(plan.max_attempts) || plan.max_attempts < 1) throw invalid('Invalid attempt budget', 'schedule.config');
  }
  const visit = (id, stack = new Set(), done = new Set()) => {
    if (stack.has(id)) throw invalid('Cyclic task dependency', 'schedule.config');
    if (done.has(id)) return;
    if (!ids.has(id)) throw invalid('Unknown dependency', 'schedule.config');
    stack.add(id);
    for (const dependency of plans.find(plan => plan.task_id === id).depends_on) visit(dependency, stack, done);
    stack.delete(id); done.add(id);
  };
  const done = new Set();
  for (const id of ids) visit(id, new Set(), done);
}

const terminalFailure = new Set(['failed', 'blocked', 'unknown', 'expired', 'partial']);
function stateError(code, outcome = 'not_completed') {
  return { schema_version: 1, code, category: 'internal', operation: 'scheduler',
    retryable: false, outcome, message: code, http_status: null, retry_after_ms: null };
}

/** Generic engine; registered handlers own all business formats. Events are observers only. */
export class Scheduler extends EventEmitter {
  constructor({ ledger, plans, handlers, timezone = 'Asia/Shanghai', startDate,
    clock = () => Date.now(), random = Math.random }) {
    super();
    validatePlans(plans);
    for (const plan of plans) if (!handlers[plan.handler]?.execute) throw invalid('Missing task handler', 'schedule.config');
    this.ledger = ledger; this.plans = plans; this.handlers = handlers; this.timezone = timezone;
    this.startDate = startDate && validateDay(startDate); this.clock = clock; this.random = random;
  }
  notify(row) {
    const event = { run_id: row.run_id, task_id: row.task_id, business_date: row.business_date,
      status: row.status, attempt: row.attempt, error_code: row.error?.code ?? null };
    for (const listener of this.rawListeners('state')) {
      try { Promise.resolve(listener.call(this, event)).catch(() => {}); } catch {}
    }
  }
  finish(row, status, options = {}) {
    this.ledger.finish(row.run_id, status, { at: new Date(this.clock()).toISOString(), ...options });
    this.notify(this.ledger.get(row.run_id));
  }
  async tick({ signal } = {}) {
    const owner = this.ledger.acquire();
    if (!owner) return { locked: true, runs: [] };
    try {
      const now = this.clock(), day = businessDay(now, this.timezone);
      // Only a proven-dead previous owner can leave running tasks for recovery.
      for (const row of this.ledger.unfinished()) {
        if (row.status === 'running') {
          if (row.plan.recovery === 'unknown') {
            this.finish(row, 'unknown', { error: stateError('INTERRUPTED_OUTCOME_UNKNOWN', 'unknown') });
          } else if (row.attempt >= row.plan.max_attempts) {
            this.finish(row, 'failed', { error: stateError('INTERRUPTED_ATTEMPTS_EXHAUSTED') });
          } else {
            this.finish(row, 'retry_wait', { next: new Date(now).toISOString(), error: stateError('INTERRUPTED') });
          }
        }
        const updated = this.ledger.get(row.run_id);
        if (['pending', 'retry_wait'].includes(updated.status) && Date.parse(updated.deadline) <= now)
          this.finish(updated, 'expired', { error: stateError('DEADLINE_EXCEEDED') });
      }
      if (this.startDate && day < this.startDate) return { locked: false, business_date: day, runs: [] };
      // Resolve next local midnight, including 23/25-hour DST days.
      const nextDay = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
      const end = Date.parse(scheduledInstant(nextDay, '00:00', this.timezone));
      this.ledger.seed(day, this.plans.map(plan => {
        const scheduled = scheduledInstant(day, plan.time, plan.timezone);
        const deadline = plan.lateness_ms == null ? end : Math.min(end, Date.parse(scheduled) + plan.lateness_ms);
        return { ...plan, scheduled_at: scheduled, deadline: new Date(deadline).toISOString() };
      }));
      const activeIds = new Set(this.plans.map(plan => plan.task_id));
      const activeRows = () => this.ledger.rows(day).filter(row => activeIds.has(row.task_id));
      let progress;
      do {
        progress = false;
        for (const row of activeRows()) {
          if (signal?.aborted) break;
          if (!['pending', 'retry_wait'].includes(row.status)) continue;
          const current = this.clock();
          if (Date.parse(row.deadline) <= current) {
            this.finish(row, 'expired', { error: stateError('DEADLINE_EXCEEDED') }); progress = true; continue;
          }
          const dependencies = row.plan.depends_on.map(id => activeRows().find(other => other.task_id === id));
          if (dependencies.some(other => other && terminalFailure.has(other.status))) {
            this.finish(row, 'blocked', { error: stateError('DEPENDENCY_FAILED') }); progress = true; continue;
          }
          if (Date.parse(row.scheduled_at) > current || (row.next_attempt_at && Date.parse(row.next_attempt_at) > current) ||
              dependencies.some(other => other?.status !== 'succeeded')) continue;
          const claimed = this.ledger.claim(row.run_id, new Date(current).toISOString());
          if (!claimed) continue;
          this.notify(claimed);
          const taskSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1,
            Math.min(row.plan.timeout_ms, Date.parse(row.deadline) - current))), ...(signal ? [signal] : [])]);
          let result;
          try {
            result = await this.handlers[row.plan.handler].execute({
              run_id: row.run_id, occurrence_id: row.occurrence_id, business_date: day,
              scheduled_at: row.scheduled_at, attempt: claimed.attempt, parameters: row.plan.parameters ?? null,
              input_refs: dependencies.flatMap(other => other.output_refs), config_ref: row.plan.config_ref, signal: taskSignal
            });
            if (!result || !['succeeded', 'partial', 'failed', 'unknown'].includes(result.status) ||
                (['succeeded', 'partial'].includes(result.status) && !Array.isArray(result.output_refs)))
              throw invalid('Invalid handler result', 'scheduler.handler');
            if (result.output_refs?.some(ref => !ref || typeof ref.kind !== 'string' || !ref.kind || ref.business_date !== day))
              throw invalid('Invalid task output reference', 'scheduler.handler');
          } catch (error) {
            result = { status: 'failed', error: fault(error, { operation: 'scheduler.handler',
              outcome: row.plan.recovery === 'unknown' ? 'unknown' : 'not_completed' }) };
          }
          if (result.error?.outcome === 'unknown') result.status = 'unknown';
          if (result.status === 'failed') {
            const info = result.error ?? stateError('TASK_FAILED');
            if (signal?.aborted && info.category === 'cancelled' && claimed.attempt < row.plan.max_attempts) {
              this.finish(row, 'retry_wait', { error: { ...info, code: 'SERVICE_INTERRUPTED' }, next: new Date(this.clock() + 1000).toISOString() });
              progress = true; continue;
            }
            const retry = retryDecision({ fault: info }, { attempt: claimed.attempt,
              maxAttempts: row.plan.max_attempts, now: this.clock(), deadline: Date.parse(row.deadline), random: this.random });
            if (retry) this.finish(row, 'retry_wait', { error: info, next: retry.next_attempt_at });
            else this.finish(row, 'failed', { error: info });
          } else {
            this.finish(row, result.status, { outputs: result.output_refs ?? [], error: result.error ?? null });
          }
          progress = true;
        }
      } while (progress && !signal?.aborted);
      return { locked: false, business_date: day, runs: activeRows().map(row => ({
        task_id: row.task_id, status: row.status, attempt: row.attempt, scheduled_at: row.scheduled_at,
        next_attempt_at: row.next_attempt_at, error_code: row.error?.code ?? null
      })) };
    } finally { this.ledger.release(owner); }
  }
}
