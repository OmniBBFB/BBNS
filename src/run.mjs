import { readFileSync } from 'node:fs';
import AiBot from '@wecom/aibot-node-sdk';
import { Messaging, WecomAdapter } from './messaging.mjs';
const config = JSON.parse(readFileSync(new URL('../config/message.json', import.meta.url)));
const { adapter, push, inbound } = config;
if (adapter.type !== 'wecom_aibot' || inbound.handler !== 'static') throw new Error('Unsupported configuration');
const botId = process.env[adapter.credentials.bot_id_env];
const secret = process.env[adapter.credentials.secret_env];
if (!botId?.trim() || !secret?.trim()) throw new Error('Missing bot credentials');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const client = new AiBot.WSClient({ botId, secret, logger: quiet });
const messaging = new Messaging(new WecomAdapter(client, adapter.id), push.targets,
  async () => ({ type: 'text', text: inbound.reply_text ?? 'todo' }));
messaging.start(message => console.log('INBOUND_TARGET', JSON.stringify({
  adapter_id: message.adapter_id, conversation_id: message.conversation_id, sender_id: message.sender_id
})));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { messaging.stop(); process.exit(0); });
console.log('CONNECTING');
