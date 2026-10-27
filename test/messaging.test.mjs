import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Messaging, WecomAdapter } from '../src/messaging.mjs';
test('single chat identifies sender, replies through opaque token; events ignored', async () => {
  const c = new EventEmitter(); c.connect = () => {}; c.disconnect = () => {};
  const replies = []; c.replyStream = async (...args) => { replies.push(args); return { errcode: 0 }; };
  const a = new WecomAdapter(c, 'bot');
  let received;
  const m = new Messaging(a, {}, async message => { received = message; return { type: 'text', text: 'todo' }; });
  m.start(); c.emit('authenticated');
  c.emit('message', { body: { msgid: 'event', from: { userid: 'u' }, chattype: 'single', msgtype: 'event' } });
  const frame = { headers: { req_id: 'r' }, body: { msgid: 'm', from: { userid: 'u' }, chattype: 'single', msgtype: 'image' } };
  c.emit('message', frame);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.conversation_id, 'u'); assert.equal(replies.length, 1);
  assert.equal(replies[0][0], frame); assert.equal(replies[0][2], 'todo'); assert.equal(replies[0][3], true);
  assert.equal('headers' in received, false); m.stop();
});
test('push uses configured target and reports ambiguous send without retry', async () => {
  let calls = 0;
  const a = { id: 'bot', ready: true, send: async target => { assert.equal(target, 'owner'); calls++; throw new Error(); } };
  const m = new Messaging(a, { personal: { adapter_id: 'bot', recipient_id: 'owner' } }, async () => null);
  const req = { request_id: 'r', target: 'personal', content: { type: 'text', text: 'hello' } };
  assert.equal((await m.push({ ...req, target: 'missing' })).error_code, 'INVALID_TARGET');
  assert.equal((await m.push(req)).status, 'unknown'); assert.equal(calls, 1);
});
