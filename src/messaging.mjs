import { fault } from './errors.mjs';
import { randomUUID } from 'node:crypto';

function deliveryFailure(result, status, code, cause = new Error(code)) {
  const error = { ...fault(cause, { operation: 'messaging.deliver', outcome: status === 'unknown' ? 'unknown' : 'not_completed' }),
    code, outcome: status === 'unknown' ? 'unknown' : 'not_completed', retryable: status !== 'unknown' && code === 'NOT_READY' };
  if (['INVALID_TARGET', 'UNSUPPORTED_CONTENT', 'INVALID_REPLY_TOKEN'].includes(code)) error.category = 'validation';
  else if (status !== 'unknown') error.category = 'dependency';
  return { ...result, status, error_code: code, error };
}

const literal = text => text.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&');
export class WecomAdapter {
  #tokens = new Map();
  constructor(client, id) { this.client = client; this.id = id; this.ready = false; }
  start(onMessage) {
    this.client.on('authenticated', () => { this.ready = true; console.log('AUTHENTICATED'); });
    this.client.on('disconnected', () => { this.ready = false; console.log('DISCONNECTED'); });
    this.client.on('error', () => console.error('CHANNEL_ERROR'));
    this.client.on('message', frame => {
      const b = frame.body;
      if (!b?.msgid || !b.from?.userid || b.msgtype === 'event') return;
      const conversation = b.chattype === 'single' ? b.from.userid : b.chatid;
      if (!conversation) return;
      const token = randomUUID();
      this.#tokens.set(token, frame);
      const timer = setTimeout(() => this.#tokens.delete(token), 60000); timer.unref();
      const message = { message_id: b.msgid, adapter_id: this.id, conversation_id: conversation,
        sender_id: b.from.userid, kind: b.msgtype, text: b.text?.content ?? null,
        received_at: new Date().toISOString(), reply_token: token };
      Promise.resolve().then(() => onMessage(message)).catch(() => console.error('HANDLER_ERROR'));
    });
    this.client.connect();
  }
  stop() { this.ready = false; this.#tokens.clear(); this.client.disconnect(); }
  async send(target, content) { return this.client.sendMessage(target, { msgtype: 'markdown', markdown: { content: literal(content.text) } }); }
  async reply(token, content) {
    const frame = this.#tokens.get(token);
    if (!frame) throw Object.assign(new Error('Invalid reply token'), { code: 'INVALID_REPLY_TOKEN' });
    this.#tokens.delete(token);
    return this.client.replyStream(frame, randomUUID(), literal(content.text), true);
  }
}

export class Messaging {
  constructor(adapter, pushTargets, handler) { this.adapter = adapter; this.pushTargets = pushTargets; this.handler = handler; }
  start(onMessage = () => {}) {
    this.adapter.start(async message => {
      onMessage(message);
      const content = await this.handler(message);
      if (content) {
        const result = await this.reply({ request_id: randomUUID(), reply_token: message.reply_token, content });
        console.log('REPLY', result.status);
      }
    });
  }
  stop() { this.adapter.stop(); }
  async #deliver(request, operation) {
    const result = { request_id: request.request_id };
    if (request.content?.type !== 'text' || typeof request.content.text !== 'string' || !request.content.text.trim())
      return deliveryFailure(result, 'failed', 'UNSUPPORTED_CONTENT');
    if (!this.adapter.ready) return deliveryFailure(result, 'failed', 'NOT_READY');
    try {
      const ack = await operation();
      if (!Number.isInteger(ack?.errcode)) return deliveryFailure(result, 'unknown', 'OUTCOME_UNKNOWN');
      if (ack.errcode !== 0) return deliveryFailure(result, 'failed', 'PROVIDER_REJECTED');
      return { ...result, status: 'accepted', provider_reference: ack.headers?.req_id };
    } catch (error) {
      if (Number.isInteger(error?.errcode) && error.errcode !== 0) return deliveryFailure(result, 'failed', 'PROVIDER_REJECTED');
      if (error?.code === 'INVALID_REPLY_TOKEN') return deliveryFailure(result, 'failed', error.code, error);
      return deliveryFailure(result, 'unknown', 'OUTCOME_UNKNOWN', error);
    }
  }
  async push(request) {
    const target = this.pushTargets[request.target];
    if (!target?.recipient_id || target.adapter_id !== this.adapter.id)
      return deliveryFailure({ request_id: request.request_id }, 'failed', 'INVALID_TARGET');
    return this.#deliver(request, () => this.adapter.send(target.recipient_id, request.content));
  }
  async reply(request) { return this.#deliver(request, () => this.adapter.reply(request.reply_token, request.content)); }
}
