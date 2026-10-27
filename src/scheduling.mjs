import { invalid } from './errors.mjs';

/** Pure schedule projection. Never examines business payloads or starts a timer. */
export function dailyPlans(sources, { timezone = 'Asia/Shanghai' } = {}) {
  const plans = sources.filter(source => source.enabled).map(source => ({
    task_id: 'collect:' + source.id, handler: 'collect', config_ref: source.id,
    time: source.recommended_collection?.time ?? '08:00',
    timezone: source.recommended_collection?.timezone ?? timezone, depends_on: []
  }));
  plans.push({ task_id: 'summarize', handler: 'summarize', time: '08:00', timezone,
    depends_on: plans.map(plan => plan.task_id) });
  plans.push({ task_id: 'push', handler: 'push', time: '09:15', timezone, depends_on: ['summarize'] });
  for (const plan of plans) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(plan.time)) throw invalid('Invalid schedule time: ' + plan.task_id, 'schedule.config');
    try { new Intl.DateTimeFormat('en-US', { timeZone: plan.timezone }); }
    catch { throw invalid('Invalid schedule timezone: ' + plan.task_id, 'schedule.config'); }
  }
  return plans;
}

/** V2 workflow entry; existing deployed dailyPlans remains valid until an explicit cutover. */
export function editionPlans(sources, { timezone = 'Asia/Shanghai', cutoff = '08:00', includeInitialHistory = false } = {}) {
  const collect = dailyPlans(sources, { timezone }).filter(plan => plan.handler === 'collect');
  const plans = [...collect];
  let dependencies = collect.map(plan => plan.task_id);
  for (const handler of ['prepare','edit','track','compose']) {
    plans.push({ task_id: handler, handler, time: cutoff, timezone, depends_on: dependencies,
      parameters: { cutoff, timezone, include_initial_history: includeInitialHistory, source_ids: collect.map(plan => plan.config_ref) } });
    dependencies = [handler];
  }
  plans.push({ task_id: 'push', handler: 'push', time: '09:15', timezone, depends_on: dependencies });
  return plans;
}
