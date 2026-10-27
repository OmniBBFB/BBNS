import { boundary, invalid, requestSignal } from './errors.mjs';

export class DeepSeekClient {
  constructor({ apiKey, model, baseUrl = 'https://api.deepseek.com', timeoutMs = 120000,
    maxTokens = 8192, fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Missing DeepSeek API key');
    if (typeof model !== 'string' || !model.trim()) throw new Error('Missing DeepSeek model');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('Invalid DeepSeek limits');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid DeepSeek base URL');
    this.apiKey = apiKey; this.model = model; this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs; this.maxTokens = maxTokens; this.fetch = fetchImpl;
  }
  async complete(messages, { signal } = {}) {
    return boundary('inference.complete', async () => {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        signal: requestSignal(this.timeoutMs, signal),
        body: JSON.stringify({ model: this.model, messages, stream: false, max_tokens: this.maxTokens,
          response_format: { type: 'json_object' } })
      });
      if (!response.ok) {
        const error = new Error(`DeepSeek HTTP ${response.status}`);
        error.http_status = response.status; error.retry_after = response.headers.get('retry-after');
        throw error;
      }
      let body;
      try { body = await response.json(); }
      catch (error) {
        signal?.throwIfAborted();
        if (['AbortError', 'TimeoutError'].includes(error?.name)) throw error;
        throw invalid('Invalid DeepSeek JSON response', 'inference.response');
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
        throw invalid('DeepSeek response incomplete or empty', 'inference.response');
      }
      return { content: choice.message.content, provider: 'deepseek', model: body.model || this.model,
        request_id: body.id ?? null, usage: body.usage ?? null };
    }, { kind: 'dependency', signal });
  }
}
