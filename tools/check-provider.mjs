import { readFile } from 'node:fs/promises';
import { DeepSeekClient } from '../src/deepseek-client.mjs';

// Explicit paid probe; never called by health checks or ordinary page reads.
try {
  const config = JSON.parse(await readFile(process.argv[2] ?? 'config/summary.json', 'utf8'));
  const client = new DeepSeekClient({ ...config.client, apiKey: process.env.DEEPSEEK_API_KEY,
    maxTokens: 64, timeoutMs: 30000 });
  const response = await client.complete([{ role: 'user', content: 'Return exactly this JSON object: {"ok":true}' }]);
  if (JSON.parse(response.content).ok !== true) throw new Error('Unexpected probe response');
  console.log(JSON.stringify({ status: 'ok', provider: response.provider, model: response.model,
    request_id: response.request_id, usage: response.usage }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'PROVIDER_CHECK_FAILED' }));
  process.exitCode = 1;
}
