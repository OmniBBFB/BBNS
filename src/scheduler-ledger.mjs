import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function fingerprint(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}
const decode = row => row && ({ ...row, plan: JSON.parse(row.plan_json), output_refs: JSON.parse(row.outputs_json),
  error: row.error_json ? JSON.parse(row.error_json) : null });

/** Local-machine ledger. No business payloads and no distributed lock assumptions. */
export class SchedulerLedger {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scheduler_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, business_date TEXT NOT NULL, task_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL UNIQUE, scheduled_at TEXT NOT NULL, deadline TEXT NOT NULL,
        plan_json TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, started_at TEXT, finished_at TEXT,
        outputs_json TEXT NOT NULL DEFAULT '[]', error_json TEXT,
        UNIQUE(business_date,task_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_day ON runs(business_date,position);
    `);
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquire() {
    const owner = { token: randomUUID(), pid: process.pid, fingerprint: fingerprint(process.pid) };
    if (!owner.fingerprint) throw new Error('Linux process identity unavailable');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT owner FROM scheduler_lock WHERE id=1').get();
      if (row) {
        const previous = JSON.parse(row.owner);
        if (fingerprint(previous.pid) === previous.fingerprint) return null;
      }
      this.db.prepare('INSERT OR REPLACE INTO scheduler_lock(id,owner) VALUES(1,?)').run(JSON.stringify(owner));
      return owner;
    });
  }
  release(owner) {
    this.db.prepare('DELETE FROM scheduler_lock WHERE id=1 AND owner=?').run(JSON.stringify(owner));
  }
  event(runId, type, at, payload = {}) {
    this.db.prepare('INSERT INTO events(run_id,at,type,payload_json) VALUES(?,?,?,?)')
      .run(runId, at, type, JSON.stringify(payload));
  }
  seed(day, plans) {
    this.transaction(() => {
      for (const [position, plan] of plans.entries()) {
        this.db.prepare(`INSERT OR IGNORE INTO runs
          (run_id,business_date,task_id,occurrence_id,scheduled_at,deadline,plan_json,position)
          VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), day, plan.task_id, day + '/' + plan.task_id,
          plan.scheduled_at, plan.deadline, JSON.stringify(plan), position);
      }
    });
  }
  rows(day) {
    return this.db.prepare('SELECT * FROM runs WHERE business_date=? ORDER BY position').all(day).map(decode);
  }
  unfinished() {
    return this.db.prepare("SELECT * FROM runs WHERE status IN ('pending','retry_wait','running')").all().map(decode);
  }
  get(id) { return decode(this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(id)); }
  claim(id, at) {
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE runs SET status='running',attempt=attempt+1,started_at=?,finished_at=NULL
        WHERE run_id=? AND status IN ('pending','retry_wait')`).run(at, id);
      if (!changed.changes) return null;
      this.event(id, 'task.running', at);
      return this.get(id);
    });
  }
  finish(id, status, { at, outputs = [], error = null, next = null } = {}) {
    this.transaction(() => {
      this.db.prepare(`UPDATE runs SET status=?,outputs_json=?,error_json=?,next_attempt_at=?,finished_at=?
        WHERE run_id=?`).run(status, JSON.stringify(outputs), error ? JSON.stringify(error) : null, next, at, id);
      this.event(id, 'task.' + status, at, { error_code: error?.code ?? null, next_attempt_at: next });
    });
  }
  close() { this.db.close(); }
}
