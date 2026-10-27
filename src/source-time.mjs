/** Source timestamps are evidence. Ambiguous local values use the source's declared offset. */
export function sourceTime(value, offset = '+08:00') {
  if (typeof value !== 'string' || !value.trim() || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset)) return null;
  let text = value.trim().replace(/\bCST\b/g, offset);
  const local = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?))?$/.exec(text);
  if (local) {
    const day = local[1];
    if (!Number.isFinite(Date.parse(day + 'T00:00:00Z')) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) return null;
    text = day + 'T' + (local[2] ?? '00:00:00') + offset;
  } else if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC|[A-Z]{3,4})\s*$/i.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
