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
const OLDER = 'gpt-5.6-astra';
const SOL = 'gpt-6.2-sol';

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
    const thread = { id: THREAD, cwd: '/workspace', status: { type: 'idle' }, model: this.model, modelProvider: this.modelProvider };
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
  assert.ok(error.turn_id == null);
  return true;
}

function assertPendingRecovery(agent, model, reason) {
  assert.equal(agent.model_recovery?.model, model);
  assert.equal(agent.model_recovery?.reason, reason);
  return agent.model_recovery;
}

async function assertConsumed(promise, model, turnId) {
  const error = await rejection(promise);
  assert.equal(error.code, 'model_recovery_consumed');
  assert.equal(error.thread_id, THREAD);
  assert.equal(error.model, model);
  assert.equal(error.turn_id, turnId);
  assert.equal(error.model_turn_started, false);
  assert.match(error.message, /already accepted turn.*did not send another message.*list_agents/);
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
  const current = assertPendingRecovery((await agents())[0], OLD, 'model_not_listed');
  assert.deepEqual(current.available_models, [OLD, REPLACEMENT]);
  assert.deepEqual(current.recovery_choices, []);
  assert.match(current.message, /gpt-6-astra is visible again.*regular followup_task/);
  assert.deepEqual(client.writes(), []);
  await assert.rejects(followup(target), /visible again.*recovery choices have expired.*gpt-6-astra.*original agent ID/);
  await assert.rejects(followup(target), /invalid or expired.*list_agents/);
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
    if (outcome === 'accepted') assert.equal(listed.model_recovery, undefined);
    else if (outcome === 'failed-model') assertPendingRecovery(listed, REPLACEMENT, 'provider_model_unavailable');
    else assertPendingRecovery(listed, OLD, 'model_not_listed');
    assert.deepEqual(client.writes(), [], 'reconciliation never repeats the lost request');
    if (outcome === 'accepted') {
      await assertConsumed(reopened.followup(target), REPLACEMENT, client.latestTurn.id);
    } else if (outcome === 'rejected') {
      assert.equal(listed.status, 'interrupted');
    } else if (outcome === 'failed-model') {
      assert.match(listed.error.message, /Turn new-native-turn failed because Codex rejected model gpt-6.2-astra/);
      assert.ok(reopened.controller.eventsAfter().some(event => event.kind === 'failed' && event.turn_id === 'new-native-turn'));
      await assertConsumed(reopened.followup(target), REPLACEMENT, 'new-native-turn');
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
  const highest = 'gpt-6.10-astra';
  const equalVersion = 'gpt-6.0-astra';
  client.handler = (method, params) => {
    if (method !== 'model/list') return;
    return params.cursor
      ? { data: [{ model: REPLACEMENT, hidden: false }, { model: highest }], nextCursor: null }
      : { data: [{ model: OLD, hidden: true }, { model: HIDDEN, hidden: true }, ...[OTHER, OLDER, SOL, equalVersion].map(model => ({ model }))], nextCursor: 'page-2' };
  };
  const visibleModels = [OTHER, OLDER, SOL, equalVersion, REPLACEMENT, highest];
  const { models } = await controller.dispatch('list_models');
  assert.deepEqual(new Set(models.map(model => model.id)), new Set(visibleModels));

  const cursor = controller.snapshot().nextSeq - 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(followup(agent.id), error => {
      assertGate(error, agent, 'model_not_listed');
      assert.deepEqual(error.available_models, visibleModels);
      assert.equal(error.recommended_model, highest);
      assert.match(error.message, /gpt-6-astra is absent.*No turn was started.*complete visible model list is in available_models.*Possible successor: gpt-6.10-astra.*Use the user's chosen model.*target.*message/);
      assert.deepEqual(error.recovery_choices.map(choice => choice.model), error.available_models);
      return true;
    });
  }
  await assert.rejects(followup(agent.id, { replacement_model: HIDDEN }), /requested replacement gpt-6.9-astra is absent.*recovery_choices/);
  assert.deepEqual(client.writes(), []);
  assertPendingRecovery((await agents())[0], OLD, 'model_not_listed');
  assert.ok(controller.eventsAfter(cursor).length <= 1, 'retrying a blocked operation must not accumulate duplicate events');
});

test('equal and lower versions and different series are choices without a possible successor', async t => {
  const { client, spawn, followup } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  const models = [OLDER, 'gpt-6.0-astra', SOL, OTHER];
  client.catalog = models.map(model => ({ model }));
  client.calls.length = 0;

  const gated = await rejection(followup(agent.id));
  assertGate(gated, agent, 'model_not_listed');
  assert.deepEqual(gated.available_models, models);
  assert.deepEqual(gated.recovery_choices.map(choice => choice.model), models);
  assert.equal(gated.recommended_model, undefined);
  assert.match(gated.message, /Ask the user which model to use.*pins the selected model for later followups/);
  assert.doesNotMatch(gated.message, /Possible successor/);
  assert.deepEqual(client.writes(), []);
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
      assert.equal(error.available_models, undefined);
      assert.equal(error.recovery_choices, undefined);
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

test('model-list diagnostics distinguish protocol incompatibility from timeout without starting a turn', async t => {
  const { client, spawn, followup } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.calls.length = 0;
  for (const [code, diagnostic] of [[-32601, /does not implement model\/list/], [-32602, /rejected the model\/list parameters/], ['ETIMEDOUT', /did not answer model\/list in time/]]) {
    client.handler = method => { if (method === 'model/list') throw Object.assign(new Error('sensitive'), { code }); };
    const error = await rejection(followup(agent.id));
    assert.equal(error.code, 'model_catalog_unavailable');
    assert.match(error.message, diagnostic);
    assert.doesNotMatch(error.message, /sensitive/);
  }
  assert.deepEqual(client.writes(), []);
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
  await assert.rejects(followup(forged), /invalid or expired.*list_agents.*original agent/);
  assert.deepEqual(client.calls, []);

  client.catalog = [{ model: REPLACEMENT, hidden: true }];
  const unavailable = await rejection(followup(target));
  assertGate(unavailable, agent, 'model_not_listed');
  assert.match(unavailable.message, /requested replacement gpt-6.2-astra is absent.*No turn was started.*visible model catalog is empty.*list_agents/);
  assert.deepEqual(unavailable.available_models, []);
  assert.deepEqual(unavailable.recovery_choices, []);
  assertPendingRecovery((await agents())[0], OLD, 'model_not_listed');
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
  client.modelProvider = 'test-provider';
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.calls.length = 0;
  client.handler = method => {
    if (method === 'turn/start') throw Object.assign(new Error('Provider rejected model'), { code: -32602, reason: 'provider_model_unavailable' });
  };
  await assert.rejects(followup(agent.id), error => {
    assertGate(error, agent, 'provider_model_unavailable');
    assert.deepEqual(error.available_models, [OLD, REPLACEMENT]);
    assert.deepEqual(error.recovery_choices.map(choice => choice.model), [REPLACEMENT]);
    assert.match(error.message, /Codex rejected model gpt-6-astra as unavailable.*No turn was started.*test-provider.*exact model ID.*custom model catalog.*upstream provider.*configured account.*recovery_choices/);
    assert.doesNotMatch(error.message, /CLI|install|upgrade/);
    return true;
  });
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['turn/start', OLD]]);
  assert.ok(client.calls.filter(call => call.method === 'model/list').every(call => call.params.modelProvider === 'test-provider'));
  assertPendingRecovery((await agents())[0], OLD, 'provider_model_unavailable');
  client.handler = undefined;
  client.catalog = [{ model: OLD }];
  const unavailable = await rejection(followup(agent.id));
  assertGate(unavailable, agent, 'provider_model_unavailable');
  assert.deepEqual(unavailable.available_models, [OLD]);
  assert.deepEqual(unavailable.recovery_choices, []);
  assert.match(unavailable.message, /visible catalog has no selectable replacement.*list_agents/);
  assert.doesNotMatch(unavailable.message, /catalog is empty/);
  assert.equal(client.writes().length, 1);

  const { retry_after_access_fix: [{ model, target }] } = unavailable;
  assert.equal(model, OLD);
  assert.match(unavailable.message, /If the user confirms that access is restored.*retry_after_access_fix/);
  client.calls.length = 0;
  await assert.rejects(followup(agent.id, { replacement_model: OLD }), /same as the unavailable model/);
  await assert.rejects(followup(target.replace('/retry/', '/')), /invalid or expired/);
  assert.deepEqual(client.writes(), []);

  const recovered = await followup(target);
  assert.equal(recovered.model, OLD);
  assert.equal(recovered.thread_id, THREAD);
  assert.equal(recovered.agent_id, agent.id);
  assert.deepEqual(client.writes().map(call => [call.method, call.params.model]), [['turn/start', OLD]]);
  assert.ok(!recovered.model_recovery);
  await assertConsumed(followup(target), OLD, recovered.turn_id);
  assert.equal(client.writes().length, 1);
});

test('a rejected replacement preserves other choices and read-only diagnostics can refresh an asynchronous failure', async t => {
  const { client, controller, spawn, followup, agents } = await setup(t);
  const agent = await spawn();
  client.complete(agent.turn_id);
  client.catalog = [{ model: REPLACEMENT }, { model: SOL }, { model: OLDER }];
  const { recovery_choices: [{ target }] } = await rejection(followup(agent.id));
  const cursor = controller.snapshot().nextSeq - 1;
  client.handler = method => {
    if (method === 'turn/start') throw Object.assign(new Error('Private provider detail.'), { code: -32602, codexErrorInfo: 'modelNotFound' });
  };
  const refused = await rejection(followup(target));
  assertGate(refused, agent, 'model_not_listed');
  assert.match(refused.message, /Codex rejected replacement model gpt-6.2-astra.*No turn was started.*recovery_choices/);
  assert.deepEqual(refused.available_models, [REPLACEMENT, SOL, OLDER]);
  assert.deepEqual(refused.recovery_choices.map(choice => choice.model), [SOL, OLDER]);
  assert.equal(refused.recommended_model, undefined);
  assert.match(refused.message, /Ask the user which model to use/);
  assert.equal(refused.recovery, undefined);
  const [failed] = controller.eventsAfter(cursor);
  assert.equal(failed.message, refused.message);
  assert.deepEqual(failed.recovery_choices, refused.recovery_choices);
  assert.doesNotMatch(JSON.stringify(failed), /Private provider detail/);

  client.handler = undefined;
  client.calls.length = 0;
  for (const request of [() => followup(target), () => followup(agent.id, { replacement_model: REPLACEMENT })]) {
    const knownRejected = await rejection(request());
    assertGate(knownRejected, agent, 'model_not_listed');
    assert.match(knownRejected.message, /previously rejected replacement model gpt-6.2-astra.*No turn was started/);
    assert.deepEqual(knownRejected.available_models, refused.available_models);
    assert.deepEqual(knownRejected.recovery_choices.map(choice => choice.model), [SOL, OLDER]);
  }
  assert.deepEqual(client.writes(), []);
  const recovered = await followup(refused.recovery_choices[0].target);
  client.complete(recovered.turn_id, { codexErrorInfo: 'modelNotFound', message: 'Private provider detail.' });
  const asyncFailure = controller.eventsAfter(cursor).at(-1);
  assert.equal(asyncFailure.model, SOL);
  assert.equal(asyncFailure.turn_id, recovered.turn_id);
  assert.equal(asyncFailure.model_turn_started, true);
  assert.match(asyncFailure.message, /Turn .* failed because Codex rejected model gpt-6.2-sol.*list_agents/);
  assert.doesNotMatch(JSON.stringify(asyncFailure), /Private provider detail/);
  await assertConsumed(followup(target), SOL, recovered.turn_id);

  client.calls.length = 0;
  client.handler = method => { if (method === 'model/list') throw new Error('Private catalog failure.'); };
  const unverified = assertPendingRecovery((await agents())[0], SOL, 'provider_model_unavailable');
  assert.equal(unverified.available_models, undefined);
  assert.equal(unverified.recovery_choices, undefined);
  assert.match(unverified.message, /visible model catalog was not verified.*list_agents.*without sending a task/);
  assert.doesNotMatch(unverified.message, /Private catalog failure|Turn.*failed|No turn was started/);

  client.handler = undefined;
  const [listed] = await agents();
  const current = assertPendingRecovery(listed, SOL, 'provider_model_unavailable');
  assert.deepEqual(current.available_models, [REPLACEMENT, SOL, OLDER]);
  assert.deepEqual(current.recovery_choices.map(choice => choice.model), [OLDER]);
  assert.deepEqual(current.retry_after_access_fix.map(choice => choice.model), [REPLACEMENT, SOL]);
  assert.equal(current.recommended_model, undefined);
  assert.match(current.message, /Ask the user which model to use/);
  assert.equal(listed.error.message, asyncFailure.message);
  assert.deepEqual(client.writes(), []);
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
  assertPendingRecovery(listed, OLD, 'model_not_listed');
  assert.equal(client.writes().filter(call => call.method === 'turn/start').length, 1);

  client.handler = undefined;
  client.calls.length = 0;
  await assert.rejects(followup(agent.id), error => assertGate(error, agent, 'model_not_listed'));
  assert.deepEqual(client.writes(), []);
  const recovered = await followup(agent.id, { replacement_model: REPLACEMENT });
  assert.equal(recovered.model, REPLACEMENT);
  assert.deepEqual(client.writes().filter(call => call.method === 'turn/start').map(call => call.params.model), [REPLACEMENT]);
});

test('a cross-series choice pins the model and recovery replay identifies its original turn after reopening', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-model-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const first = await setup(t, { statePath });
  const agent = await first.spawn();
  first.client.complete(agent.turn_id);
  first.client.catalog = [{ model: REPLACEMENT }, { model: SOL }];
  const unavailable = await rejection(first.followup(agent.id));
  assertGate(unavailable, agent, 'model_not_listed');
  const [{ target: alternative }, { target }] = unavailable.recovery_choices;
  await first.controller.close();

  const reopened = await setup(t, { statePath });
  reopened.client.catalog = [{ model: REPLACEMENT }, { model: SOL }];
  assertPendingRecovery((await reopened.agents())[0], OLD, 'model_not_listed');
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
  assert.equal(recovered.model, SOL);
  assert.ok(!recovered.model_recovery);
  await assertConsumed(reopened.followup(target), SOL, recovered.turn_id);
  await assertConsumed(reopened.followup(alternative), SOL, recovered.turn_id);
  assert.deepEqual(reopened.client.writes().map(call => [call.method, call.params.threadId, call.params.model]), [
    ['thread/resume', THREAD, SOL], ['turn/start', THREAD, SOL],
  ]);
  assert.deepEqual(reopened.client.writes().at(-1).params.input.map(item => item.text), ['Continue the same task']);
  reopened.client.complete(recovered.turn_id);

  reopened.client.catalog.unshift({ model: OLD });
  const cursor = reopened.controller.snapshot().nextSeq - 1;
  const continued = await reopened.followup(agent.id);
  assert.equal(continued.model, SOL);
  assert.ok(!continued.model_recovery);
  await assertConsumed(reopened.followup(target), SOL, recovered.turn_id);
  assert.deepEqual(reopened.controller.eventsAfter(cursor), [], 'relisting the original model does not produce a warning');
  assert.deepEqual(reopened.client.writes().slice(2).map(call => [call.method, call.params.threadId, call.params.model]), [
    ['turn/start', THREAD, SOL],
  ]);
  reopened.client.complete(continued.turn_id);
  await reopened.controller.close();

  const next = await setup(t, { statePath });
  next.client.catalog.push({ model: SOL });
  await assertConsumed(next.followup(target), SOL, recovered.turn_id);
  await assertConsumed(next.followup(alternative), SOL, recovered.turn_id);
  assert.deepEqual(next.client.writes(), []);
  const resumed = await next.followup(LINK);
  assert.equal(resumed.agent_id, agent.id);
  assert.equal(resumed.model, SOL);
  assert.deepEqual(next.client.writes().map(call => [call.method, call.params.threadId, call.params.model]), [
    ['thread/resume', THREAD, SOL], ['turn/start', THREAD, SOL],
  ]);
  next.client.complete(resumed.turn_id);
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
