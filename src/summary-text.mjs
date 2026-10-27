/** Remove only the legacy provenance prefix; preserve factual qualifications in the body. */
export function summaryText(text, completeness) {
  if (completeness !== 'summary') return text;
  const cleaned = text.replace(/^\s*(?:仅依据摘要|仅基于摘要|仅根据摘要)\s*[：:]\s*/, '');
  return cleaned.trim() ? cleaned : text;
}
export function materialLabel(completeness) {
  return completeness === 'summary' ? '基于来源摘要' : completeness === 'full' ? '基于全文' : null;
}
