/** Error protocol v1. Decorate at boundaries; preserve native name/code/cause. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  const time = Date.parse(text);
  return Number.isFinite(time) ? Math.max(0, time - now) : null;
}

export function fault(error, { operation = 'unknown', kind, outcome = 'not_completed', now } = {}) {
  if (error?.fault) return error.fault;
  const status = error?.http_status;
  const native = error?.code ?? error?.cause?.code;
  let category = kind ?? 'internal', code = 'INTERNAL_ERROR', retryable = false;
  if (kind === 'cancelled' || error?.name === 'AbortError') { category = 'cancelled'; code = 'CANCELLED'; }
  else if (error?.name === 'TimeoutError') { category = 'timeout'; code = 'TIMEOUT'; retryable = true; }
  else if (Number.isInteger(status)) {
    category = 'dependency'; code = 'HTTP_' + status;
    retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
  } else if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(native) ||
      (error instanceof TypeError && /fetch failed|network/i.test(error.message))) {
    category = 'network'; code = 'NETWORK_ERROR'; retryable = true;
  } else if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EEXIST', 'EROFS', 'EMFILE'].includes(native)) {
    category = 'storage'; code = native; retryable = native === 'EMFILE';
  } else if (kind === 'validation') { code = 'INVALID_DATA'; }
  else if (kind === 'storage') { code = 'STORAGE_ERROR'; }
  else if (kind === 'dependency') { code = 'DEPENDENCY_ERROR'; }
  if (outcome === 'unknown') retryable = false;
  return { schema_version: 1, code, category, operation, retryable, outcome,
    message: error?.message ?? String(error), http_status: status ?? null,
    retry_after_ms: retryAfterMs(error?.retry_after, now) };
}

export function annotate(error, options) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  if (!wrapped.fault) wrapped.fault = fault(wrapped, options);
  return wrapped;
}

export async function boundary(operation, action, { signal, ...options } = {}) {
  try { signal?.throwIfAborted(); return await action(); }
  catch (error) { throw annotate(error, { operation, ...options, ...(signal?.aborted ? { kind: 'cancelled' } : {}) }); }
}

export function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function invalid(message, operation) {
  return annotate(new Error(message), { operation, kind: 'validation' });
}

/** Only the task execution layer retries; modules always perform one attempt. */
export function retryDecision(error, { attempt, maxAttempts = 3, baseMs = 1000,
  maxMs = 60000, now = Date.now(), deadline = Infinity, random = Math.random } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isFinite(baseMs) || baseMs < 0 || !Number.isFinite(maxMs) || maxMs < baseMs) {
    throw invalid('Invalid retry policy', 'retry.policy');
  }
  const info = error?.fault ?? fault(error);
  if (!info.retryable || info.outcome === 'unknown' || attempt >= maxAttempts) return null;
  const backoff = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  const jitter = Math.floor(backoff * (0.5 + random() * 0.5));
  const delay = Math.max(jitter, info.retry_after_ms ?? 0);
  return now + delay <= deadline ? { delay_ms: delay, next_attempt_at: new Date(now + delay).toISOString() } : null;
}
