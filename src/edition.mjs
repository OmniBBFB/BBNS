import { scheduledInstant } from './scheduler.mjs';
import { validateDay } from './daily-store.mjs';
import { invalid } from './errors.mjs';

export function editionPolicy(parameters = {}) {
  const { cutoff = '08:00', timezone = 'Asia/Shanghai', include_initial_history = false } = parameters;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoff) || typeof include_initial_history !== 'boolean')
    throw invalid('Invalid edition policy', 'edition.policy');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw invalid('Invalid edition timezone', 'edition.policy'); }
  return { cutoff, timezone, include_initial_history };
}

/** Edition policy belongs to workflow assembly, not to the generic scheduler or collectors. */
export function editionSpec({ business_date: day, run_id: id, parameters }) {
  validateDay(day);
  const { cutoff, timezone, include_initial_history } = editionPolicy(parameters ?? {});
  const previous = new Date(Date.parse(day + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  return { schema_version: 1, id, business_date: day, timezone, cutoff, include_initial_history,
    window_start: scheduledInstant(previous, cutoff, timezone), window_end: scheduledInstant(day, cutoff, timezone),
    policy_version: 'edition-v1' };
}
