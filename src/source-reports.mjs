import { invalid } from './errors.mjs';

export function sourceFailureReports(context) {
  return (context.dependency_runs ?? []).filter(run => run.handler === 'collect' && run.status !== 'succeeded').map(run => {
    if (run.business_date !== context.business_date || !run.config_ref ||
        !['failed', 'blocked', 'expired', 'unknown', 'partial'].includes(run.status))
      throw invalid('Invalid source dependency state', 'task.source_report');
    return { source_id: run.config_ref, status: 'failed', count: null,
      error_code: /^[A-Z][A-Z0-9_]{0,63}$/.test(run.error_code ?? '') ? run.error_code : 'TASK_FAILED', attempt: run.attempt };
  });
}
