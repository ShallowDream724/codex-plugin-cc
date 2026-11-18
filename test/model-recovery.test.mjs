import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../runtime/agents.mjs';

const THREAD = '12345678-1234-4234-8234-123456789abc';
const LINK = `codex://threads/${THREAD}`;
const OLD = 'gpt-6-astra';
const REPLACEMENT = 'gpt-6.2-astra';
const HIDDEN = 'gpt-6.9-astra';
const OTHER = 'gpt-6.4-astra-mini';

class NativeClient extends EventEmitter {
  calls = [];
  catalog = [{ model: OLD }, { model: REPLACEMENT }];
  turnCount = 0;
  model = OLD;

  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    const response = this.handler?.(method, params);
    if (response !== undefined) return response;
    if (method === 'model/list') return { data: this.catalog, nextCursor: null };
    const thread = { id: THREAD, cwd: '/workspace', status: { type: 'idle' }, model: this.model };
    if (method === 'thread/start' || method === 'thread/read') return { thread };
    if (method === 'thread/turns/list') return { data: this.latestTurn ? [this.latestTurn] : [] };
    if (method === 'thread/resume') {
      this.model = params.model ?? this.model;
      return { thread, model: this.model };
    }
    if (method === 'turn/start') {
      this.model = params.model ?? this.model;
      this.latestTurn = { id: `turn-${++this.turnCount}`, status: 'inProgress' };
      return { turn: this.latestTurn };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    return {};
  }

  complete(turnId, error) {
    this.latestTurn = { id: turnId, status: error ? 'failed' : 'completed', ...(error ? { error } : {}) };
    this.emit('notification', { method: 'turn/completed', params: { threadId: THREAD,
      turn: this.latestTurn } });
  }

  writes() {
    return this.calls.filter(call => ['thread/start', 'thread/resume', 'thread/inject_items', 'turn/start', 'turn/steer'].includes(call.method));
  }
}

async function setup(t, { client = new NativeClient(), statePath } = {}) {
  const controller = new AgentController({ client, statePath, nativeRoleResolver: async () => undefined });
  await controller.init();
  t.after(() => controller.close());
  const spawn = () => controller.dispatch('spawn_agent', { message: 'Initial task', cwd: '/workspace', model: OLD, context_mode: 'none' });
  const followup = (target, args) => controller.dispatch('followup_task', { target, message: 'Continue the same task', ...args });
  const agents = async () => (await controller.dispatch('list_agents')).agents;
  return { client, controller, spawn, followup, agents };
}

async function rejection(promise) {
  let received;
  await assert.rejects(promise, error => { received = error; return true; });
  return received;
}

function assertGate(error, agent, reason) {
  assert.equal(error.code, 'agent_model_unavailable');
  assert.equal(error.reason, reason);
  assert.equal(error.agent_id, agent.id);
  assert.equal(error.thread_id, THREAD);
  assert.equal(error.model, OLD);
  assert.equal(error.model_turn_started, false);
  return true;
}

test('a relisted model expires its catalog-only gate and continues without switching', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }];
  const missing = await rejection(followup(agent.id));
  assertGate(missing, agent, 'model_not_listed');
  const [{ target }] = missing.recovery_choices;

  client.catalog = [{ model: OLD }, { model: REPLACEMENT }];
  client.calls.length = 0;
  await assert.rejects(followup(target), /visible again.*target set to agent ID.*continue with gpt-6-astra/);
  await assert.rejects(followup(target), /invalid or no longer active.*list_agents/);
  assert.deepEqual(client.writes(), []);
  assert.ok(!(await agents())[0].model_recovery);
  assert.equal((await followup(agent.id)).model, OLD);
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['turn/start', OLD]]);
});

test('a lost recovery reply only consumes the gate when native metadata confirms the attempted turn', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-replacement-reconciliation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const outcome of ['accepted', 'rejected', 'ambiguous', 'failed-model']) {
    const statePath = path.join(dir, `${outcome}.json`);
    const first = await setup(t, { statePath });
    const agent = await first.spawn();
    first.client.complete(agent.turn_id);
    first.client.catalog = [{ model: REPLACEMENT }];
    const missing = await rejection(first.followup(agent.id));
    assertGate(missing, agent, 'model_not_listed');
    const [{ target }] = missing.recovery_choices;
    first.client.handler = method => {
      if (method === 'turn/start') throw Object.assign(new Error('Lost replacement reply.'), { code: 'ETIMEDOUT' });
    };
    const lost = await rejection(first.followup(target, { message: 'Private text in the model request' }));
    assert.match(lost.message, /did not confirm whether it started.*gpt-6.2-astra.*Inspect thread/);
    assert.equal(lost.cause.message, 'Lost replacement reply.');
    assert.equal((await first.agents())[0].status, 'unknown');
    await first.controller.close();
    assert.doesNotMatch(await readFile(statePath, 'utf8'), /Private text in the model request/);

    const client = new NativeClient();
    client.model = outcome === 'ambiguous' ? OLD : REPLACEMENT;
    client.latestTurn = { id: outcome === 'rejected' ? agent.turn_id : 'new-native-turn', status: 'completed' };
    if (outcome === 'failed-model') Object.assign(client.latestTurn, { status: 'failed', error: { message: 'Provider detail with private text.', codexErrorInfo: 'modelNotFound' } });
    client.catalog = [{ model: REPLACEMENT }];
    const reopened = await setup(t, { client, statePath });
    const [listed] = await reopened.agents();
    assert.equal(listed.model, ['accepted', 'failed-model'].includes(outcome) ? REPLACEMENT : OLD);
    assert.deepEqual(listed.model_recovery, outcome === 'accepted' ? undefined : outcome === 'failed-model'
      ? { model: REPLACEMENT, reason: 'provider_model_unavailable' } : { model: OLD, reason: 'model_not_listed' });
    assert.deepEqual(client.writes(), [], 'reconciliation never repeats the lost request');
    if (outcome === 'accepted') {
      await assert.rejects(reopened.followup(target), /invalid or no longer active.*list_agents/);
    } else if (outcome === 'rejected') {
      assert.equal(listed.status, 'interrupted');
    } else if (outcome === 'failed-model') {
      assert.match(listed.error.message, /turn failed because Codex rejected model gpt-6.2-astra.*followup_task.*check the current replacement choices/);
      assert.ok(reopened.controller.eventsAfter().some(event => event.kind === 'failed' && event.message === listed.error.message));
      await assert.rejects(reopened.followup(target), /invalid or no longer active.*list_agents/);
    } else {
      assert.equal(listed.status, 'unknown');
      await assert.rejects(reopened.followup(target), /Native metadata could not confirm.*Inspect thread/);
    }
    assert.deepEqual(client.writes(), [], 'checking the recovery gate never sends the old request');
    await reopened.controller.close();
  }
});

test('replacement cannot change a healthy running, idle, or unregistered thread', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  await assert.rejects(followup(LINK, { replacement_model: REPLACEMENT }), /no registered model recovery.*native Codex thread link/);
  assert.deepEqual(client.writes(), []);
  assert.deepEqual(await agents(), []);

  const agent = await spawn();
  client.calls.length = 0;
  await assert.rejects(followup(agent.id, { replacement_model: REPLACEMENT }), /no pending model recovery.*continue with its current model/);
  assert.deepEqual(client.writes(), [], 'a rejected replacement must not steer a running turn');
  assert.equal((await followup(agent.id)).turn_id, agent.turn_id);

  client.complete(agent.turn_id);
  client.calls.length = 0;
  await assert.rejects(followup(agent.id, { replacement_model: REPLACEMENT }));
  assert.deepEqual(client.writes(), [], 'a rejected replacement must not resume an idle thread or deliver text');
  assert.equal((await agents())[0].model, OLD);
  const continued = await followup(agent.id);
  assert.equal(continued.model, OLD);
  assert.equal(client.writes().at(-1).params.model, OLD);
});

test('catalog preflight blocks a hidden model before native inference and only offers visible choices', async t => {
  const { client, controller, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.calls.length = 0;
  client.handler = (method, params) => {
    if (method !== 'model/list') return;
    return params.cursor
      ? { data: [{ model: REPLACEMENT, hidden: false }], nextCursor: null }
      : { data: [{ model: OLD, hidden: true }, { model: HIDDEN, hidden: true }, { model: OTHER }], nextCursor: 'page-2' };
  };
  const { models } = await controller.dispatch('list_models');
  assert.deepEqual(new Set(models.map(model => model.id)), new Set([OTHER, REPLACEMENT]));

  const cursor = controller.snapshot().nextSeq - 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(followup(agent.id), error => {
      assertGate(error, agent, 'model_not_listed');
      assert.deepEqual(new Set(error.available_models), new Set([OTHER, REPLACEMENT]));
      assert.equal(error.recommended_model, REPLACEMENT);
      assert.match(error.message, /gpt-6-astra is absent.*No turn was started.*target.*recovery_choices.*message/);
      assert.deepEqual(error.recovery_choices.map(choice => choice.model), error.available_models);
      return true;
    });
  }
  await assert.rejects(followup(agent.id, { replacement_model: HIDDEN }), /requested replacement gpt-6.9-astra is absent.*recovery_choices/);
  assert.deepEqual(client.writes(), []);
  assert.deepEqual((await agents())[0].model_recovery, { model: OLD, reason: 'model_not_listed' });
  assert.ok(controller.eventsAfter(cursor).length <= 1, 'retrying a blocked operation must not accumulate duplicate events');
});

test('catalog failures block inference without authorizing replacement', async t => {
  for (const readCatalog of [
    () => { throw new Error('App-server request timed out.'); },
    () => ({ data: [{ model: REPLACEMENT }], nextCursor: 'repeat' }),
    () => ({ nextCursor: null }),
  ]) {
    const { client, spawn, followup, agents } = await setup(t);
    const agent = await spawn();
    client.complete(agent.turn_id);
    client.calls.length = 0;
    client.handler = method => method === 'model/list' ? readCatalog() : undefined;
    await assert.rejects(followup(agent.id, { replacement_model: REPLACEMENT }));
    assert.deepEqual(client.writes(), []);
    await assert.rejects(followup(agent.id), error => {
      assert.notEqual(error.code, 'agent_model_unavailable');
      assert.match(error.message, /Could not verify the Codex model catalog.*No turn was started.*target set to agent ID.*once the model catalog is available/);
      assert.doesNotMatch(error.message, /timed out|invalid page|repeated cursor/);
      return true;
    });
    assert.deepEqual(client.writes(), []);
    const [listed] = await agents();
    assert.equal(listed.model, OLD);
    assert.ok(!listed.model_recovery);
  }
});

test('native thread lookup failure does not register or authorize model recovery', async t => {
  const { client, followup, agents } = await setup(t);
  const cause = Object.assign(new Error('Native thread lookup failed.'), { reason: 'provider_model_unavailable' });
  client.handler = method => { if (method === 'thread/read') throw cause; };
  await assert.rejects(followup(LINK), error => {
    assert.equal(error.cause, cause);
    assert.notEqual(error.code, 'agent_model_unavailable');
    return true;
  });
  await assert.rejects(followup(LINK, { replacement_model: REPLACEMENT }));
  assert.deepEqual(client.writes(), []);
  assert.deepEqual(await agents(), []);
});

test('a native deep link registers a recovery target when its known model is unavailable', async t => {
  const { client, followup, agents } = await setup(t);
  client.catalog = [{ model: REPLACEMENT }];
  let gated;
  await assert.rejects(followup(LINK), error => {
    gated = error;
    return true;
  });
  const listed = await agents();
  assert.equal(listed.length, 1);
  const [agent] = listed;
  assertGate(gated, agent, 'model_not_listed');
  assert.equal(agent.context_source, 'codex');
  assert.deepEqual(client.writes(), []);

  const recovered = await followup(gated.recovery_choices[0].target);
  assert.equal(recovered.agent_id, agent.id);
  assert.equal(recovered.thread_id, THREAD);
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [
    ['thread/resume', REPLACEMENT], ['turn/start', REPLACEMENT],
  ]);
});

test('signed recovery choices require the same pending agent and a currently visible model', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }, { model: OTHER }];
  const blocked = await rejection(followup(agent.id));
  const [{ target }] = blocked.recovery_choices;
  const forged = target.replace(REPLACEMENT, OTHER);
  client.calls.length = 0;
  await assert.rejects(followup(forged), /invalid or no longer active.*find the original agent/);
  assert.deepEqual(client.calls, []);

  client.catalog = [{ model: REPLACEMENT, hidden: true }];
  const unavailable = await rejection(followup(target));
  assertGate(unavailable, agent, 'model_not_listed');
  assert.match(unavailable.message, /requested replacement gpt-6.2-astra is absent.*No eligible replacement is visible.*Once the model catalog changes.*same message/);
  assert.deepEqual(unavailable.available_models, []);
  assert.equal(unavailable.recovery_choices, undefined);
  assert.deepEqual((await agents())[0].model_recovery, { model: OLD, reason: 'model_not_listed' });
  assert.deepEqual(client.writes(), []);
});

test('a live recovery target respects descendant activity, approval, and the user pause', async t => {
  const { client, controller, followup, spawn } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }];
  const { recovery_choices: [{ target }] } = await rejection(followup(agent.id));
  const child = '22345678-1234-4234-8234-123456789abc';
  client.calls.length = 0;
  client.emit('notification', { method: 'thread/started', params: { thread: { id: child, parentThreadId: THREAD } } });
  client.emit('notification', { method: 'turn/started', params: { threadId: child, turn: { id: 'child-turn' } } });
  await assert.rejects(followup(target), /descendants is still active.*Wait until they are idle/);
  await controller.serverRequest({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: child, turnId: 'child-turn' } });
  await assert.rejects(followup(target), /pending approval or question.*answer_agent.*pending request_id/);
  client.emit('notification', { method: 'turn/completed', params: { threadId: child, turn: { id: 'child-turn', status: 'completed' } } });
  await controller.dispatch('ui_interrupt', { target: agent.id });
  await assert.rejects(followup(target), /paused by the user.*direct message in the Codex interface/);
  assert.deepEqual(client.writes(), []);
});

test('a native resume response cannot silently replace the pinned model', async t => {
  const { client, followup, agents } = await setup(t);
  client.handler = method => {
    if (method === 'thread/resume') return { thread: { id: THREAD, status: { type: 'idle' } }, model: REPLACEMENT };
  };
  await assert.rejects(followup(LINK), error => {
    assert.notEqual(error.code, 'agent_model_unavailable');
    assert.ok(error.message.includes(REPLACEMENT));
    return true;
  });
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['thread/resume', OLD]]);
  const [agent] = await agents();
  assert.equal(agent.model, OLD);
  assert.ok(!agent.model_recovery);
  await assert.rejects(followup(LINK, { replacement_model: REPLACEMENT }));
  assert.equal(client.writes().length, 1);
});

test('provider rejection can open recovery even while the target model remains listed', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.calls.length = 0;
  client.handler = method => {
    if (method === 'turn/start') throw Object.assign(new Error('Provider rejected model'), { code: -32602, reason: 'provider_model_unavailable' });
  };
  await assert.rejects(followup(agent.id), error => {
    assertGate(error, agent, 'provider_model_unavailable');
    assert.deepEqual(error.available_models, [REPLACEMENT]);
    assert.match(error.message, /Codex rejected model gpt-6-astra as unavailable.*No turn was started.*recovery_choices/);
    return true;
  });
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['turn/start', OLD]]);
  assert.deepEqual((await agents())[0].model_recovery, { model: OLD, reason: 'provider_model_unavailable' });
  client.handler = undefined;
  await assert.rejects(followup(agent.id), error => assertGate(error, agent, 'provider_model_unavailable'));
  assert.equal(client.writes().length, 1);
});

test('a rejected replacement explains the failure in results and events and offers other models', async t => {
  const { client, controller, spawn, followup } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }, { model: OTHER }];
  const { recovery_choices: [{ target }] } = await rejection(followup(agent.id));
  const cursor = controller.snapshot().nextSeq - 1;
  client.handler = method => {
    if (method === 'turn/start') throw Object.assign(new Error('Private provider detail.'), { code: -32602, codexErrorInfo: 'modelNotFound' });
  };
  const refused = await rejection(followup(target));
  assertGate(refused, agent, 'model_not_listed');
  assert.match(refused.message, /Codex rejected replacement model gpt-6.2-astra.*No turn was started.*recovery_choices/);
  assert.deepEqual(refused.recovery_choices.map(choice => choice.model), [OTHER]);
  assert.equal(refused.recovery, undefined);
  const [failed] = controller.eventsAfter(cursor);
  assert.equal(failed.message, refused.message);
  assert.deepEqual(failed.recovery_choices, refused.recovery_choices);
  assert.doesNotMatch(JSON.stringify(failed), /Private provider detail/);

  client.handler = undefined;
  const recovered = await followup(refused.recovery_choices[0].target);
  client.complete(recovered.turn_id, { codexErrorInfo: 'modelNotFound', message: 'Private provider detail.' });
  const asyncFailure = controller.eventsAfter(cursor).at(-1);
  assert.equal(asyncFailure.model, OTHER);
  assert.equal(asyncFailure.model_turn_started, true);
  assert.equal(asyncFailure.recovery_choices, undefined);
  assert.match(asyncFailure.message, /turn failed because Codex rejected model gpt-6.4-astra-mini.*model_recovery for agent.*status is failed, interrupted, or completed.*current replacement choices/);
  assert.doesNotMatch(JSON.stringify(asyncFailure), /Private provider detail/);
  await assert.rejects(followup(target), /invalid or no longer active/);
});

test('an unrelated rejection leaves the pinned model in place and does not open recovery', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  const cause = Object.assign(new Error('Request contains an unsupported input format.'), { code: -32602 });
  client.handler = method => { if (method === 'turn/start') throw cause; };
  client.calls.length = 0;
  await assert.rejects(followup(agent.id), cause);
  const [listed] = await agents();
  assert.equal(listed.model, OLD);
  assert.ok(!listed.model_recovery);
  await assert.rejects(followup(agent.id, { replacement_model: REPLACEMENT }));
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['turn/start', OLD]]);
});

test('rejected replacement start preserves the gate and requires a new explicit retry', async t => {
  const { client, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }];
  await assert.rejects(followup(agent.id), error => assertGate(error, agent, 'model_not_listed'));

  const cause = Object.assign(new Error('Request contains an unsupported input format.'), { code: -32602 });
  client.handler = method => { if (method === 'turn/start') throw cause; };
  client.calls.length = 0;
  const rejected = await rejection(followup(agent.id, { replacement_model: REPLACEMENT }));
  assert.match(rejected.message, /rejected the request.*gpt-6.2-astra.*No turn was started.*Check the followup message/);
  assert.equal(rejected.cause, cause);
  assert.equal(rejected.code, cause.code);
  const [listed] = await agents();
  assert.equal(listed.model, OLD);
  assert.deepEqual(listed.model_recovery, { model: OLD, reason: 'model_not_listed' });
  assert.equal(client.writes().filter(call => call.method === 'turn/start').length, 1);

  client.handler = undefined;
  client.calls.length = 0;
  await assert.rejects(followup(agent.id), error => assertGate(error, agent, 'model_not_listed'));
  assert.deepEqual(client.writes(), []);
  const recovered = await followup(agent.id, { replacement_model: REPLACEMENT });
  assert.equal(recovered.model, REPLACEMENT);
  assert.deepEqual(client.writes().filter(call => call.method === 'turn/start').map(call => call.params.model), [REPLACEMENT]);
});

test('recovery survives reopening and an explicit replacement starts one turn on the same native thread', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const first = await setup(t, { statePath });
  const agent = await first.spawn();
  first.client.complete(agent.turn_id);
  first.client.catalog = [{ model: REPLACEMENT }];
  const unavailable = await rejection(first.followup(agent.id));
  assertGate(unavailable, agent, 'model_not_listed');
  const [{ target }] = unavailable.recovery_choices;
  await first.controller.close();

  const reopened = await setup(t, { statePath });
  reopened.client.catalog = [{ model: REPLACEMENT }];
  assert.deepEqual((await reopened.agents())[0].model_recovery, { model: OLD, reason: 'model_not_listed' });
  let enterStart, finishStart;
  const startEntered = new Promise(resolve => { enterStart = resolve; });
  reopened.client.handler = method => {
    if (method !== 'turn/start' || finishStart) return;
    enterStart();
    return new Promise(resolve => { finishStart = resolve; });
  };
  const recovery = reopened.followup(target);
  await Promise.race([startEntered, recovery]);
  try {
    await assert.rejects(reopened.followup(target), /still active.*Wait until they are idle/);
  } finally {
    finishStart({ turn: { id: 'replacement-turn', status: 'inProgress' } });
  }
  const recovered = await recovery;
  assert.equal(recovered.agent_id, agent.id);
  assert.equal(recovered.thread_id, THREAD);
  assert.equal(recovered.model, REPLACEMENT);
  assert.ok(!recovered.model_recovery);
  await assert.rejects(reopened.followup(target), /invalid or no longer active.*list_agents/);
  assert.deepEqual(reopened.client.writes().map(call => [call.method, call.params.threadId, call.params.model]), [
    ['thread/resume', THREAD, REPLACEMENT], ['turn/start', THREAD, REPLACEMENT],
  ]);
  assert.deepEqual(reopened.client.writes().at(-1).params.input.map(item => item.text), ['Continue the same task']);
  reopened.client.complete(recovered.turn_id);
  await reopened.controller.close();

  const next = await setup(t, { statePath });
  const continued = await next.followup(LINK);
  assert.equal(continued.agent_id, agent.id);
  assert.equal(continued.model, REPLACEMENT);
  assert.deepEqual(next.client.writes().map(call => [call.method, call.params.threadId, call.params.model]), [
    ['thread/resume', THREAD, REPLACEMENT], ['turn/start', THREAD, REPLACEMENT],
  ]);
  next.client.complete(continued.turn_id);
  await next.controller.close();
});

test('a pending state created before signed recovery targets can still issue a usable choice', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-legacy-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const first = await setup(t, { statePath });
  const agent = await first.spawn();
  first.client.complete(agent.turn_id);
  first.client.catalog = [{ model: REPLACEMENT }];
  await rejection(first.followup(agent.id));
  await first.controller.close();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  delete state.agents[0].modelRecovery.ticket;
  await writeFile(statePath, JSON.stringify(state));

  const reopened = await setup(t, { statePath });
  reopened.client.catalog = [{ model: REPLACEMENT }];
  const { recovery_choices: [{ target }] } = await rejection(reopened.followup(agent.id));
  const recovered = await reopened.followup(target);
  assert.equal(recovered.model, REPLACEMENT);
  assert.equal(recovered.thread_id, THREAD);
});

test('direct user send preserves private model failure and uses the same actionable recovery gate', async t => {
  const { client, controller, spawn, followup } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  await controller.ackEvents(controller.snapshot().nextSeq - 1);

  const send = () => controller.dispatch('ui_send', { target: agent.id, message: 'Private user task' });
  const sent = await send();
  assert.equal(sent.turn_origin, 'user');
  client.complete(sent.turn_id, { message: 'Provider model unavailable', codexErrorInfo: 'modelNotFound' });
  assert.deepEqual(controller.eventsAfter(), []);
  assert.deepEqual(controller.snapshot().agents[0].model_recovery, { model: OLD, reason: 'provider_model_unavailable' });

  client.calls.length = 0;
  await assert.rejects(send(), error => assertGate(error, agent, 'provider_model_unavailable'));
  assert.deepEqual(client.writes(), []);
  assert.deepEqual(controller.eventsAfter(), []);
  const continued = await followup(agent.id, { replacement_model: REPLACEMENT });
  assert.equal(continued.turn_origin, 'parent');
  assert.equal(continued.model, REPLACEMENT);
  assert.doesNotMatch(JSON.stringify(client.writes()), /Private user task/);
});
