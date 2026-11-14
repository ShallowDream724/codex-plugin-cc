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
const threadId = 'offline-thread';
const turnId = 'offline-turn';
record({ kind: 'started', pid: process.pid, argv: process.argv.slice(2) });
let asked = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  record({ kind: 'frame', ...frame });
  if (!frame.method) {
    if (frame.id === 1000 && frame.result) {
      notify('item/completed', { threadId, turnId, item: { id: 'offline-final', type: 'agentMessage', phase: 'final_answer', text: 'OFFLINE_CODEX_COMPLETED' } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }
    return;
  }
  const respond = (result) => send({ id: frame.id, result });
  switch (frame.method) {
    case 'initialize': respond({ userAgent: 'offline-fake-codex' }); break;
    case 'initialized': break;
    case 'thread/start': respond({ thread: { id: threadId } }); break;
    case 'thread/inject_items': respond({}); break;
    case 'turn/start':
      respond({ turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      if (!asked) {
        asked = true;
        setTimeout(() => send({ id: 1000, method: 'item/tool/requestUserInput', params: {
          threadId, turnId, itemId: 'offline-question', questions: [{ id: 'choice', header: 'Offline', question: 'Choose the synthetic answer.', options: [{ label: 'Proceed', description: 'Complete this offline fixture.' }] }],
        } }), 30);
      }
      break;
    case 'turn/interrupt': respond({}); notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } }); break;
    default: send({ id: frame.id, error: { code: -32601, message: 'Unsupported offline fixture request.' } });
  }
});
