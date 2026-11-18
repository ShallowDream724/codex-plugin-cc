#!/usr/bin/env node
// This fixture implements only local synthetic app-server exchanges. No network.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const base = process.env.CODEX_SUBAGENTS_STATE_DIR;
if (!base) throw new Error('The offline fixture requires an isolated state directory.');
mkdirSync(base, { recursive: true });
const artifact = join(base, 'fake-codex.jsonl');
const record = (value) => appendFileSync(artifact, JSON.stringify(value) + '\n', { mode: 0o600 });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const threadId = '12345678-1234-4234-8234-123456789abc';
const initialTurnId = 'offline-turn';
const continuedTurnId = 'offline-continued-turn';
const defaultModel = 'gpt-6.2-sol', initialModel = 'gpt-6.1-astra', modelProvider = 'offline';
record({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) });
let asked = false;
let modelRetired = false;

function complete(turnId, text) {
  notify('item/completed', { threadId, turnId, item: { id: `${turnId}-final`, type: 'agentMessage', phase: 'final_answer', text } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  record({ kind: 'frame', ...frame });
  if (!frame.method) {
    if (frame.id === 1000 && frame.result) {
      modelRetired = true;
      complete(initialTurnId, 'OFFLINE_CODEX_COMPLETED');
    }
    return;
  }
  const respond = (result) => send({ id: frame.id, result });
  switch (frame.method) {
    case 'initialize': respond({ userAgent: 'offline-fake-codex' }); break;
    case 'initialized': break;
    case 'config/read': respond({ config: { model: defaultModel, model_provider: modelProvider }, layers: [], origins: {} }); break;
    case 'model/list': {
      const modelIds = ['gpt-6.2-astra', defaultModel];
      if (!modelRetired) modelIds.unshift(initialModel);
      respond({ data: modelIds.map(model => ({ model })), nextCursor: null });
      break;
    }
    case 'thread/start': respond({ thread: { id: threadId }, model: frame.params.model ?? defaultModel, modelProvider }); break;
    case 'thread/inject_items': respond({}); break;
    case 'turn/start': {
      const turnId = asked ? continuedTurnId : initialTurnId;
      respond({ turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      if (!asked) {
        asked = true;
        setTimeout(() => send({ id: 1000, method: 'item/tool/requestUserInput', params: {
          threadId, turnId, itemId: 'offline-question', questions: [{ id: 'choice', header: 'Offline', question: 'Choose the synthetic answer.', options: [{ label: 'Proceed', description: 'Complete this offline fixture.' }] }],
        } }), 30);
      } else complete(turnId, 'OFFLINE_CODEX_RECOVERED');
      break;
    }
    case 'turn/interrupt': respond({}); notify('turn/completed', { threadId, turn: { id: frame.params.turnId, status: 'interrupted' } }); break;
    default: send({ id: frame.id, error: { code: -32601, message: 'Unsupported offline fixture request.' } });
  }
});
