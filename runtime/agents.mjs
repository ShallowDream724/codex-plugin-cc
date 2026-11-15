import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadSettings, permissionParams } from './settings.mjs';
import { loadGuidance, defaultRole, resolveNativeDefault, externalClientTools } from './roles.mjs';

const CONTINUE = 'Continue the existing task from the compacted context. Do not repeat completed work.';
const ACTIVE = new Set(['starting', 'running', 'waiting', 'compacting']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0;
const copy = (x) => structuredClone(x);
const input = (text) => [{ type: 'text', text }];
const isOverflow = (error) => error?.codexErrorInfo === 'contextWindowExceeded' || error?.code === 'contextWindowExceeded';
const roleConfig = (role) => role === 'default' ? { 'features.default_mode_request_user_input': false, 'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.image_generation': false } : undefined;

/** Owns directly-created Codex threads; never forwards nested agents or tool traces. */
export class AgentController extends EventEmitter {
  constructor({ client, statePath, settings, nativeRoleResolver = resolveNativeDefault } = {}) {
    super();
    if (!client) throw new TypeError('client is required.');
    this.client = client;
    this.statePath = statePath;
    this.settings = loadSettings(settings);
    this.guidance = loadGuidance();
    this.nativeRoleResolver = nativeRoleResolver;
    this.adoptions = new Map();
    this.reservations = new Set();
    this.agents = new Map();
    this.threads = new Map();
    this.descendants = new Map();
    this.unlinkedThreads = new Map();
    this.descendantTurns = new Map();
    this.retiredThreads = new Set();
    this.pendingEvents = [];
    this.nextSeq = 1;
    this.starting = 0;
    this.early = [];
    this.persistTail = Promise.resolve();
    this.closed = false;
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.onNotification = (m) => this.observe(m);
    this.onRequest = (m) => { this.serverRequest(m).catch((error) => this.emit('controllerError', error)); };
    this.onClosed = () => this.disconnected();
    client.on('notification', this.onNotification);
    client.on('request', this.onRequest);
    client.on('closed', this.onClosed);
  }

  async init() {
    if (!this.statePath) return this;
    let data;
    try { data = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return this; throw error; }
    if (data.version !== 1 || !Array.isArray(data.agents) || !Array.isArray(data.pendingEvents)) throw new Error('Invalid agent state.');
    // Wire requests cannot be recovered by a new app-server connection.
    this.pendingEvents = data.pendingEvents.filter((event) => !['question', 'approval'].includes(event.kind));
    this.retiredThreads = new Set(data.retiredThreads ?? []);
    this.nextSeq = data.pendingEvents.reduce((next, event) => Math.max(next, event.seq + 1), data.nextSeq ?? 1);
    for (const saved of data.agents) {
      const a = { ...saved, lastTurnId: saved.turnId, pending: [], completedTurns: new Set(), compactItems: new Set(), loaded: false, terminalEmitted: true };
      this.agents.set(a.id, a);
      if (a.threadId) this.threads.set(a.threadId, a);
      if (ACTIVE.has(a.status)) {
        a.status = 'unknown'; a.turnId = null; a.activity = 'stale_pending';
        this.publish(a, 'unknown', { reason: 'controller_restarted', stale_pending: true });
      }
    }
    this.pendingEvents = this.pendingEvents.filter((event) => this.agents.has(event.agent_id));
    // A restarted controller cannot assume an active turn stopped. Reconcile
    // native state now so confirmed idle threads release capacity automatically.
    await Promise.allSettled([...this.agents.values()].filter((a) => a.status === 'unknown' && a.threadId).map((a) => this.reconcileUnknown(a)));
    await this.persist();
    return this;
  }

  view(a, metrics = false) {
    const result = { id: a.id, agent_id: a.id, thread_id: a.threadId, name: a.name, cwd: a.cwd,
      model: a.model, reasoning_effort: a.effort, status: a.status, activity: a.activity,
      turn_id: a.turnId, error: a.error ?? null,
      pending_requests: a.pending.map(({ id, method, params }) => ({ method, ...copy(params), request_id: id,
        reply_format: replyFormat(method, params), ...(params.threadId !== a.threadId ? { source_thread_id: params.threadId } : {}) })) };
    if (metrics) {
      result.token_usage = copy(a.tokenUsage ?? null); result.result = a.result ?? null;
      result.context_snapshot = copy(a.snapshot ?? null);
    }
    return result;
  }

  snapshot() { return { agents: [...this.agents.values()].map((a) => this.view(a, true)), pendingEvents: copy(this.pendingEvents), nextSeq: this.nextSeq }; }
  hasActiveWork() {
    return this.descendantTurns.size > 0 || [...this.agents.values()].some((a) => ACTIVE.has(a.status) || a.status === 'unknown' || a.turnId || a.pending.length > 0);
  }
  eventsAfter(cursor = 0, targets = []) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(targets)) throw new TypeError('Invalid event cursor or targets.');
    const ids = new Set(targets.map((target) => this.find(target).id));
    return copy(this.pendingEvents.filter((e) => this.agents.has(e.agent_id) && e.seq > cursor && (!ids.size || ids.has(e.agent_id))));
  }
  async ackSequences(sequences) {
    if (!Array.isArray(sequences) || sequences.some((seq) => !Number.isSafeInteger(seq) || seq < 1 || seq >= this.nextSeq)) {
      throw new TypeError('Invalid event acknowledgement sequences.');
    }
    const acknowledged = [...new Set(sequences)];
    const selected = new Set(acknowledged);
    this.pendingEvents = this.pendingEvents.filter((event) => !selected.has(event.seq));
    await this.persist();
    return { acknowledged };
  }
  async ackEvents(cursor) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= this.nextSeq) throw new TypeError('Invalid event acknowledgement cursor.');
    this.pendingEvents = this.pendingEvents.filter((event) => event.seq > cursor);
    await this.persist();
    return { acknowledged: cursor };
  }

  async dispatch(operation, args = {}) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    switch (operation) {
      case 'spawn_agent': return this.spawn(args);
      case 'list_agents': return { agents: [...this.agents.values()].map((a) => this.view(a)) };
      case 'list_models': return this.models();
      case 'send_message': return this.send(this.find(args.target), args.message, false);
      case 'followup_task': return this.followup(args.target, args.message);
      case 'interrupt_agent': return this.interrupt(this.find(args.target));
      case 'close_agent': return this.closeSelected(args);
      case 'answer_agent': return this.answer(this.find(args.target), args.request_id, args.answer);
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  }

  find(target) {
    if (typeof target === 'string' && target.startsWith('codex://threads/')) target = target.slice('codex://threads/'.length);
    const matches = [...this.agents.values()].filter((a) => a.id === target || a.threadId === target || a.name === target);
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous agent target.' : 'Unknown agent target.');
    return matches[0];
  }

  occupies(a) {
    return ACTIVE.has(a.status) || a.status === 'unknown' || !!a.turnId || !!a.pending.length || a.spawning || a.resuming || a.startingTurn || a.recovery || [...this.descendants].some(([id, root]) => root === a && this.descendantTurns.has(id));
  }

  reserve(key, a) {
    if (a && this.occupies(a)) return false;
    const count = [...this.agents.values()].filter((agent) => this.occupies(agent)).length + this.reservations.size;
    if (count >= this.settings.maxActiveAgents) throw new Error(`Active agent limit (${this.settings.maxActiveAgents}) reached.`);
    this.reservations.add(key);
    return true;
  }

  action(kind, a, message) {
    this.emit('agentAction', { kind, agent_id: a.id, thread_id: a.threadId ?? null, turn_id: a.turnId ?? null, name: a.name ?? null, ...(message === undefined ? {} : { message }) });
  }

  updateResolved(a, response) {
    const model = response?.model ?? response?.thread?.model;
    const effort = response?.reasoningEffort ?? response?.thread?.reasoningEffort;
    if (nonempty(model)) a.model = model;
    if (nonempty(effort)) a.effort = effort;
  }

  async rpc(method, params) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    return Promise.race([this.client.request(method, params, { timeoutMs: 120000 }), this.closedPromise.then(() => { throw new Error('App-server connection closed.'); })]);
  }

  async spawn({ message, cwd, model, reasoning_effort, name, context_mode, snapshot, role }) {
    let roleInstructions = '';
    if (role !== undefined) {
      if (role !== 'default') throw new TypeError('Unknown role.');
      const preset = defaultRole(this.guidance);
      if (model !== undefined && model !== preset.model || reasoning_effort !== undefined && reasoning_effort !== preset.reasoning_effort || context_mode !== undefined && context_mode !== 'none') throw new TypeError('role default requires its configured model, effort, and context_mode none.');
      model = preset.model; reasoning_effort = preset.reasoning_effort; context_mode = 'none'; roleInstructions = `${preset.instructions}\n\n`;
    }
    context_mode ??= 'available';
    if (!nonempty(message) || !nonempty(cwd)) throw new TypeError('message and cwd are required.');
    if (!path.posix.isAbsolute(cwd) && !path.win32.isAbsolute(cwd)) throw new TypeError('cwd must be an absolute path.');
    if (!['available', 'none'].includes(context_mode)) throw new TypeError('context_mode must be available or none.');
    if (context_mode === 'available' && (!object(snapshot) || !Array.isArray(snapshot.history) || !nonempty(snapshot.digest) || !object(snapshot.stats))) {
      throw new Error('context_mode available requires a validated snapshot.');
    }
    const reservation = Symbol('spawn'); this.reserve(reservation);
    const a = { id: randomUUID(), name, cwd, model, effort: reasoning_effort, role, status: 'starting', activity: 'starting',
      pending: [], turnId: null, completedTurns: new Set(), compactItems: new Set(), loaded: true, recoveryUsed: false, interrupted: false, spawning: true };
    this.agents.set(a.id, a);
    this.reservations.delete(reservation);
    this.starting++;
    try {
      const nativeDefault = role === undefined ? await this.nativeRoleResolver({ cwd, guidance: this.guidance, readConfig: (params) => this.rpc('config/read', params) }) : undefined;
      const response = await this.rpc('thread/start', { cwd, ...(model ? { model } : {}), ...permissionParams(this.settings), ephemeral: false, serviceTier: 'default',
        config: roleConfig(role) ?? { 'features.default_mode_request_user_input': true, ...nativeDefault }, dynamicTools: role === 'default' ? [] : [{ type: 'function', name: 'notify_parent',
          description: 'Send a necessary coordination message to Claude.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }] });
      if (!nonempty(response.thread?.id)) throw new Error('thread/start returned no thread id.');
      this.updateResolved(a, response);
      a.threadId = response.thread.id;
      this.action('spawn', a, message);
      this.threads.set(a.threadId, a);
      this.linkDescendants();
      this.replayEarly(a.threadId);
      if (context_mode === 'available') {
        await this.rpc('thread/inject_items', { threadId: a.threadId, items: snapshot.history });
        a.snapshot = { digest: snapshot.digest, stats: snapshot.stats };
        a.injected = true;
      }
      const collaboration = role === 'default' ? 'Claude is your parent agent.\n\n' : `${this.guidance.collaboration.trim()}\n\n`;
      if (!a.interrupted) await this.startTurn(a, collaboration + roleInstructions + message, true);
      return { ...this.view(a), context_snapshot: a.snapshot ? { ...copy(a.snapshot), ...(Object.hasOwn(snapshot, 'preview') ? { preview: copy(snapshot.preview) } : {}) } : null };
    } catch (error) {
      if (ACTIVE.has(a.status) && !a.turnId) this.finish(a, this.closing ? 'interrupted' : 'failed', { message: error.message });
      const recovery = a.threadId ? `Inspect or continue agent ${a.id} on native thread ${a.threadId}; do not create replacement work until its state is known.` : `Agent ${a.id} has no confirmed native thread; inspect its status or close it before retrying.`;
      throw Object.assign(new Error(`Agent ${a.id}${a.threadId ? ` (thread ${a.threadId})` : ''}: ${error.message} ${recovery}`, { cause: error }), { agent_id: a.id, thread_id: a.threadId ?? null, status: a.status, recovery });
    } finally {
      a.spawning = false;
      this.starting--;
      if (!this.starting) {
        const early = this.early.splice(0);
        for (const entry of early) if (entry.request) await this.client.reject(entry.message.id, -32601, 'Thread is not owned by this controller.').catch(() => {});
      }
      await this.persist();
    }
  }

  replayEarly(threadId) {
    const owns = (e) => this.threadId(e.message.params) === threadId || this.descendants.get(this.threadId(e.message.params))?.threadId === threadId;
    const matching = this.early.filter(owns);
    this.early = this.early.filter((e) => !owns(e));
    for (const entry of matching) entry.request ? this.onRequest(entry.message) : this.observe(entry.message);
  }

  async startTurn(a, text, newTask = false) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    const previousTaskTurns = newTask ? new Set(a.completedTurns) : null;
    if (newTask) { a.recoveryUsed = false; a.interrupted = false; a.error = null; a.terminalEmitted = false; }
    a.compactItems.clear();
    a.result = null;
    a.unclassifiedResult = null;
    a.status = a.pending.length ? 'waiting' : 'running'; a.activity = a.pending.length ? 'waiting for parent' : 'working'; a.turnId = null; a.overflow = false;
    a.startingTurn = true;
    a.startEvents = [];
    let response;
    try {
      response = await this.rpc('turn/start', { threadId: a.threadId, input: input(text),
        ...(a.effort ? { effort: a.effort } : {}), serviceTierForTurn: 'default' });
      if (!nonempty(response?.turn?.id)) throw new Error('turn/start returned no turn id; start outcome is unknown.');
      a.startingTurn = false;
      await this.replayTurnStart(a, response.turn.id);
    } catch (error) {
      a.startingTurn = false;
      // On a lost reply, a single observed start is the best available identity.
      // On success, the response above is authoritative and discards late traffic
      // from older tasks, without retaining every historical turn ID forever.
      const observed = [...new Set((a.startEvents ?? []).filter((entry) => !entry.request && entry.message.method === 'turn/started')
        .map((entry) => entry.message.params.turn.id).filter((id) => !a.completedTurns.has(id)))];
      await this.replayTurnStart(a, observed.length === 1 ? observed[0] : null);
      // A transport failure says nothing about whether the server started work.
      // An observed turn remains authoritative even if its RPC reply was lost.
      if (!a.turnId && !a.terminalEmitted) this.finish(a, Number.isInteger(error.code) ? 'failed' : 'unknown',
        { message: error.message, reason: Number.isInteger(error.code) ? 'turn_start_rejected' : 'turn_start_outcome_unknown',
          ...(Number.isInteger(error.code) ? {} : { recovery: `Keep this same agent. An explicit send, followup, interrupt, or close first checks native Codex thread ${a.threadId} metadata and restores its subscription when needed. Do not create replacement work or automatically resend the original task; if metadata remains inconclusive, inspect this thread in Codex.` }) });
      await this.persist();
      throw error;
    }
    finally {
      a.startingTurn = false;
      a.startEvents = null;
      // Keep the prior task's IDs until start notifications have been processed.
      // After binding a new turn, admission checks below reject unrelated turns.
      if (previousTaskTurns && (a.turnId || a.terminalEmitted && a.status !== 'unknown')) {
        for (const id of previousTaskTurns) a.completedTurns.delete(id);
      }
    }
    // Notifications may already have completed this turn while its RPC was pending.
    const turn = response.turn;
    if (turn?.id && !a.completedTurns.has(turn.id) && ACTIVE.has(a.status) && !a.turnId) a.turnId = turn.id;
    a.lastTurnId = turn?.id ?? a.lastTurnId;
    if (previousTaskTurns) for (const id of previousTaskTurns) a.completedTurns.delete(id);
    if (a.interrupted && a.turnId) await this.requestInterrupt(a);
    await this.persist();
  }

  async replayTurnStart(a, turnId) {
    const events = a.startEvents ?? [];
    a.startEvents = null;
    for (const entry of events) {
      const p = entry.message.params ?? {};
      const sourceTurn = p.turnId ?? p.turn?.id;
      if (!turnId || sourceTurn && sourceTurn !== turnId) {
        if (entry.request) await this.client.reject(entry.message.id, -32602, 'Stale or unconfirmed agent turn.');
        continue;
      }
      if (entry.request) await this.serverRequest(entry.message);
      else this.observe(entry.message);
    }
  }

  async reconcileUnknown(a) {
    if (a.status !== 'unknown') return;
    if (a.reconciling) return a.reconciling;
    const reconcile = async () => {
      let resumed = false;
      a.error = { ...a.error };
      delete a.error.reconciliation_error; delete a.error.reconciliation_status;
      try {
        const response = await this.rpc('thread/read', { threadId: a.threadId, includeTurns: false });
        if (a.status !== 'unknown') return;
        let status = response?.thread?.status?.type;
        if (status === 'active' && !a.loaded) {
          const response = await this.rpc('thread/resume', { threadId: a.threadId, excludeTurns: true, ...permissionParams(this.settings), ...(a.role === 'default' ? { config: roleConfig(a.role) } : {}) });
          this.updateResolved(a, response);
          resumed = true; a.loaded = true;
          if (a.status !== 'unknown') return { resumed };
          // The thread may finish while its subscription is being restored.
          // Use the resume response before deciding whether to bind a live turn.
          status = response?.thread?.status?.type;
        }
        if (['idle', 'notLoaded'].includes(status)) {
          if (status === 'notLoaded') a.loaded = false;
          a.status = 'interrupted'; a.activity = 'outcome_reconciled'; a.turnId = null;
          a.error = null; a.terminalEmitted = true; a.interrupted = true;
          this.publish(a, 'interrupted', { reason: 'outcome_reconciled', native_status: status });
        } else if (status === 'active') {
          // Read a single turn with no item history. An active thread alone is
          // insufficient to infer which turn may safely be steered/interrupted.
          const page = await this.rpc('thread/turns/list', { threadId: a.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
          if (a.status !== 'unknown') return { resumed };
          const turn = page?.data?.[0];
          if (nonempty(turn?.id) && turn.status === 'inProgress') {
            a.turnId = turn.id; a.lastTurnId = turn.id; a.status = a.pending.length ? 'waiting' : 'running';
            a.activity = a.pending.length ? 'waiting for parent' : 'working'; a.error = null; a.terminalEmitted = false;
          } else a.error = { ...a.error, reconciliation_status: 'active thread has no confirmed inProgress turn' };
        } else a.error = { ...a.error, reconciliation_status: status ?? 'missing thread status' };
      } catch (error) {
        if (a.status === 'unknown') a.error = { ...a.error, reconciliation_error: error.message };
        else throw error;
      }
      await this.persist();
      return { resumed };
    };
    a.reconciling = reconcile();
    try { return await a.reconciling; }
    finally { a.reconciling = null; }
  }

  unknownError(a) {
    return new Error(`Previous turn/start outcome is unknown; native metadata could not confirm a safe operation (${a.error?.reconciliation_error ?? a.error?.reconciliation_status ?? 'unconfirmed thread'}). Inspect thread ${a.threadId} in Codex before retrying.`);
  }

  async followup(target, message) {
    if (!nonempty(message)) throw new TypeError('message must be nonempty.');
    let id = typeof target === 'string' && target.startsWith('codex://threads/') ? target.slice('codex://threads/'.length) : target;
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) id = id.toLowerCase();
    const matches = [...this.agents.values()].filter((a) => a.id === id || a.threadId === id || a.name === id);
    if (matches.length > 1) throw new Error('Ambiguous agent target. Use an agent ID.');
    const existing = matches[0];
    if (this.adoptions.has(existing?.threadId ?? id)) throw new Error(`Thread ${existing?.threadId ?? id} is already being adopted; retry using the registered agent after it completes.`);
    if (existing) return this.send(existing, message, true);
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Unknown agent target; native thread IDs must be UUIDs.');
    const reservation = Symbol('adopt'); this.reserve(reservation);
    this.adoptions.set(id, true);
    try {
      const response = await this.rpc('thread/read', { threadId: id, includeTurns: false });
      const thread = response?.thread;
      if (thread?.id !== id || !nonempty(thread.cwd) || !path.posix.isAbsolute(thread.cwd) && !path.win32.isAbsolute(thread.cwd)) throw new Error('Native thread metadata has no matching ID and absolute cwd.');
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw new Error(`Native thread status is ${thread.status?.type ?? 'unknown'}; active or unconfirmed external threads cannot be adopted.`);
      const clientTools = await externalClientTools(thread);
      const a = { id: randomUUID(), threadId: id, cwd: thread.cwd, status: 'interrupted', activity: 'adopted',
        pending: [], turnId: null, completedTurns: new Set(), compactItems: new Set(), loaded: false, recoveryUsed: false, interrupted: false, terminalEmitted: true, adopting: true, externalAdopted: true, externalThread: true };
      this.updateResolved(a, { thread });
      this.retiredThreads.delete(id); this.agents.set(a.id, a); this.threads.set(id, a);
      try {
        await this.persist();
        const result = await this.send(a, message, true, reservation);
        return { ...result, client_tools_unavailable: clientTools, limitations: ['Original client dynamic tools are unavailable here. Continue in the original Codex client if those tools are needed.'] };
      } catch (error) {
        throw new Error(`Thread ${id} is registered as agent ${a.id}. ${error.message} Inspect the thread in Codex or retry using this agent ID; do not create replacement work.`, { cause: error });
      }
    } catch (error) {
      if (error.cause) throw error;
      throw new Error(`Could not adopt native thread ${id}: ${error.message} Inspect the thread in Codex and retry when its state is confirmed.`, { cause: error });
    } finally { const a = this.threads.get(id); if (a) a.adopting = false; this.reservations.delete(reservation); this.adoptions.delete(id); }
  }

  async send(a, message, followup, existingReservation) {
    if (!nonempty(message)) throw new TypeError('message must be nonempty.');
    if (a.adopting && !existingReservation) throw new Error(`Thread ${a.threadId} is being adopted.`);
    if (a.externalConflict) throw new Error(`Thread ${a.threadId} became active in another client. Close this agent and retry adoption once the native thread is idle.`);
    const reconciliation = await this.reconcileUnknown(a);
    if (a.status === 'unknown') throw this.unknownError(a);
    if (a.removing) throw new Error('Agent is closing.');
    if (a.pending.length || a.status === 'waiting') throw new Error('Agent is waiting for a response; use answer_agent with its pending request_id.');
    if (ACTIVE.has(a.status)) {
      if (!a.turnId || a.status === 'compacting') throw new Error('Agent turn is not steerable yet.');
      const turnId = a.turnId;
      a.sending = (a.sending ?? 0) + 1;
      try {
        const response = await this.rpc('turn/steer', { threadId: a.threadId, expectedTurnId: turnId, input: input(message) });
        this.action('send', a, message);
        return { agent_id: a.id, status: 'steered', turn_id: response.turnId ?? turnId };
      } finally { a.sending--; }
    }
    if (a.resuming) throw new Error('Agent followup is already starting.');
    const reservation = existingReservation ?? Symbol('followup');
    if (followup && !existingReservation) this.reserve(reservation, a);
    a.resuming = true;
    this.reservations.delete(reservation);
    try {
      if ((followup && !reconciliation?.resumed) || !a.loaded) {
        const response = await this.rpc('thread/resume', { threadId: a.threadId, excludeTurns: true, ...permissionParams(this.settings), ...(a.role === 'default' ? { config: roleConfig(a.role) } : {}) });
        this.updateResolved(a, response);
        if (a.externalAdopted && !a.loaded && !['idle', 'notLoaded'].includes(response?.thread?.status?.type)) {
          a.externalConflict = true;
          throw new Error(`Native thread ${a.threadId} became active or unconfirmed during resume; no task was sent.`);
        }
      }
      a.loaded = true;
      a.externalAdopted = false;
      if (!followup) {
        await this.rpc('thread/inject_items', { threadId: a.threadId,
          items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] }] });
        this.action('send', a, message);
        return { agent_id: a.id, status: 'stored', model_turn_started: false };
      }
      await this.startTurn(a, message, true);
      this.action('send', a, message);
      return this.view(a);
    } finally { a.resuming = false; }
  }

  async closeSelected(args) {
    const { target, targets, except } = args;
    if (target !== undefined && targets !== undefined) throw new TypeError('Specify target or targets, not both.');
    if (except !== undefined && (!Array.isArray(except) || except.some((x) => !nonempty(x)))) throw new TypeError('except must be an array of nonempty targets.');
    if (except !== undefined && targets !== 'all') throw new TypeError('except is only valid with targets all.');
    if (targets === undefined && target !== undefined && except === undefined) return this.closeAgent(this.find(target));
    if (targets !== 'all' && (!Array.isArray(targets) || targets.length === 0 || targets.some((x) => !nonempty(x)))) throw new TypeError('targets must be all or a nonempty array of targets.');
    const excluded = new Set((except ?? []).map((x) => this.find(x).id));
    const selected = targets === 'all' ? [...this.agents.values()] : targets.map((x) => this.find(x));
    const snapshot = [...new Map(selected.filter((a) => !excluded.has(a.id)).map((a) => [a.id, a])).values()];
    const closed_ids = [], skipped = [];
    for (const a of snapshot) {
      try { await this.closeAgent(a); closed_ids.push(a.id); }
      catch (error) { skipped.push({ agent_id: a.id, reason: error.message }); }
    }
    return { closed_count: closed_ids.length, closed_ids, skipped };
  }

  canClose(a) {
    if (a.status === 'unknown') throw new Error('Agent turn/start outcome is unknown; reconcile the native Codex thread before closing ownership.');
    if (!TERMINAL.has(a.status) || a.turnId || a.pending.length || a.spawning || a.adopting || a.resuming || a.startingTurn || a.sending || a.recovery) {
      throw new Error('Agent must be idle and terminal with no pending requests or operations before closing.');
    }
    for (const [threadId, root] of this.descendants) {
      if (root === a && this.descendantTurns.has(threadId)) throw new Error('Agent has an active descendant.');
    }
  }

  async closeAgent(a) {
    await this.reconcileUnknown(a);
    if (a.status === 'unknown') throw this.unknownError(a);
    if (a.removing) throw new Error('Agent is already closing.');
    this.canClose(a);
    a.removing = true;
    try {
      let unsubscribed = false;
      if (a.loaded && a.threadId) { await this.rpc('thread/unsubscribe', { threadId: a.threadId }); a.loaded = false; unsubscribed = true; }
      // A server event can reveal an active descendant while unsubscribe is pending.
      try { this.canClose(a); }
      catch (error) {
        if (unsubscribed) await this.restoreSubscription(a);
        throw error;
      }
      const threadIds = new Set(a.threadId ? [a.threadId] : []);
      for (const [id, root] of this.descendants) if (root === a) threadIds.add(id);
      let changed;
      do {
        changed = false;
        for (const [id, parentId] of this.unlinkedThreads) {
          if (threadIds.has(parentId) && !threadIds.has(id)) { threadIds.add(id); changed = true; }
        }
      } while (changed);
      for (const id of threadIds) {
        this.retiredThreads.add(id);
        this.threads.delete(id); this.descendants.delete(id); this.unlinkedThreads.delete(id); this.descendantTurns.delete(id);
      }
      this.agents.delete(a.id);
      this.pendingEvents = this.pendingEvents.filter((event) => event.agent_id !== a.id);
      this.early = this.early.filter((entry) => !threadIds.has(this.threadId(entry.message.params)));
      await this.persist();
      this.action('close', a);
      return { agent_id: a.id, thread_id: a.threadId, status: 'closed' };
    } finally { a.removing = false; }
  }

  async restoreSubscription(a) {
    try {
      const response = await this.rpc('thread/resume', { threadId: a.threadId, excludeTurns: true, ...permissionParams(this.settings), ...(a.role === 'default' ? { config: roleConfig(a.role) } : {}) });
      this.updateResolved(a, response);
      a.loaded = true;
      if (response?.thread?.status?.type !== 'idle') {
        a.status = 'unknown'; a.activity = 'subscription restored; native status unconfirmed';
        await this.reconcileUnknown(a);
      }
      if (a.status !== 'unknown') { await this.persist(); return; }
      throw new Error('Native status remains unconfirmed after restoring subscription.');
    } catch (error) {
      a.status = 'unknown'; a.activity = 'subscription recovery required';
      a.error = { code: 'subscription_restore_failed', message: error.message, recovery: `Inspect native thread ${a.threadId} in Codex, then retry an operation on agent ${a.id} to reconcile its state.` };
      this.publish(a, 'message', { code: 'subscription_restore_failed', message: `Closing agent ${a.id} was cancelled and subscription recovery is unconfirmed: ${error.message}. ${a.error.recovery}` });
      await this.persist();
    }
  }

  async interrupt(a) {
    await this.reconcileUnknown(a);
    if (a.status === 'unknown') throw this.unknownError(a);
    a.interrupted = true;
    if (!ACTIVE.has(a.status)) return { agent_id: a.id, status: 'not_running' };
    if (a.turnId) await this.requestInterrupt(a);
    // A recovery between turns must not restart after the user interrupts it.
    if (!a.turnId && !a.startingTurn) this.finish(a, 'interrupted', { reason: 'parent_interrupt' });
    return { agent_id: a.id, status: 'interrupting' };
  }

  async requestInterrupt(a) {
    if (!a.turnId || a.interruptSentTurn === a.turnId) return;
    const turnId = a.turnId;
    a.interruptSentTurn = turnId;
    try { await this.rpc('turn/interrupt', { threadId: a.threadId, turnId }); }
    catch (error) { if (a.interruptSentTurn === turnId) a.interruptSentTurn = null; throw error; }
  }

  interruptUnconfirmed(a, error) {
    if (this.closed || this.closing || !a.turnId) return;
    if (a.status === 'interrupted') a.status = 'unknown';
    a.activity = 'interrupt not confirmed';
    a.error = { code: 'interrupt_unconfirmed', message: error.message, turn_id: a.turnId };
    this.publish(a, 'message', { code: 'interrupt_unconfirmed', message: 'Interruption was not confirmed. This agent may still be running; retry interrupt_agent for this agent.' });
  }

  threadId(params = {}) { return params.threadId ?? params.thread?.id; }
  linkDescendants() {
    let changed;
    do {
      changed = false;
      for (const [id, parentId] of this.unlinkedThreads) {
        const root = this.threads.get(parentId) ?? this.descendants.get(parentId);
        if (!root || id === root.threadId) continue;
        this.descendants.set(id, root); this.unlinkedThreads.delete(id); changed = true;
      }
    } while (changed);
  }

  observeDescendant(a, message, p) {
    if (!['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(message.method)) return;
    const sourceId = this.threadId(p);
    if (message.method === 'turn/started') this.descendantTurns.set(sourceId, p.turn.id);
    if (message.method === 'turn/completed') {
      if (this.descendantTurns.get(sourceId) === p.turn?.id) this.descendantTurns.delete(sourceId);
      a.pending = a.pending.filter((r) => r.params.threadId !== sourceId || r.params.turnId !== p.turn?.id);
    }
    if (message.method === 'serverRequest/resolved') a.pending = a.pending.filter((r) => r.wireId !== p.requestId);
    if (!a.pending.length) {
      if (a.status === 'waiting') a.status = 'running';
      a.activity = ACTIVE.has(a.status) ? 'working' : a.status;
    }
    this.pruneRequestEvents(a);
    this.persist().catch(() => {});
  }

  observe(message) {
    if (this.closed) return;
    const p = message.params ?? {};
    if (this.retiredThreads.has(this.threadId(p))) return;
    if (message.method === 'thread/started' && p.thread?.id) {
      const source = p.thread.source?.subAgent;
      const parentId = p.thread.parentThreadId ?? source?.thread_spawn?.parent_thread_id ?? source?.parentThreadId;
      if (this.retiredThreads.has(parentId)) { this.retiredThreads.add(p.thread.id); return; }
      if (parentId) { this.unlinkedThreads.set(p.thread.id, parentId); this.linkDescendants(); }
    }
    const sourceId = this.threadId(p), a = this.threads.get(sourceId);
    if (!a) {
      const root = this.descendants.get(sourceId);
      if (root) { this.observeDescendant(root, message, p); return; }
      if (this.starting && this.important(message)) this.early.push({ message: copy(message) });
      return;
    }
    if (a.startingTurn && ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'error', 'serverRequest/resolved'].includes(message.method)) {
      const buffered = copy(message);
      if (buffered.params.item && buffered.params.item.type !== 'agentMessage') buffered.params.item = { id: p.item.id, type: p.item.type };
      a.startEvents.push({ message: buffered });
      return;
    }
    switch (message.method) {
      case 'turn/started':
        if (a.completedTurns.has(p.turn.id)) return;
        if (a.terminalEmitted && a.lastTurnId === p.turn.id) return;
        if (a.turnId && a.turnId !== p.turn.id) return;
        if (a.terminalEmitted && a.status !== 'unknown') {
          if (a.interrupted) {
            a.turnId = p.turn.id;
            this.requestInterrupt(a).catch((error) => this.interruptUnconfirmed(a, error));
          }
          return;
        }
        a.turnId = p.turn.id;
        a.lastTurnId = p.turn.id;
        if (a.status === 'unknown') { a.terminalEmitted = false; a.error = null; a.status = 'running'; }
        if (!a.recovery && !a.terminalEmitted) { a.status = a.pending.length ? 'waiting' : 'running'; a.activity = a.pending.length ? 'waiting for parent' : 'working'; }
        if (a.interrupted) this.requestInterrupt(a).catch((error) => this.interruptUnconfirmed(a, error));
        break;
      case 'thread/tokenUsage/updated': a.tokenUsage = copy(p.tokenUsage); break;
      case 'error':
        if (a.terminalEmitted || (p.turnId && (a.completedTurns.has(p.turnId) || a.turnId && a.turnId !== p.turnId))) return;
        if (isOverflow(p.error)) a.overflow = true;
        a.lastError = p.error ? { message: p.error.message, codexErrorInfo: p.error.codexErrorInfo } : null;
        break;
      case 'item/started': case 'item/completed': {
        if (a.terminalEmitted) return;
        const item = p.item ?? {};
        if (p.turnId && a.completedTurns.has(p.turnId)) return;
        if (a.turnId && p.turnId && a.turnId !== p.turnId) return;
        if (item.type === 'agentMessage' && message.method === 'item/completed') {
          if (['final_answer', 'finalAnswer'].includes(item.phase)) a.result = item.text;
          else if (item.phase == null) a.unclassifiedResult = item.text;
        }
        if (item.type === 'contextCompaction') {
          if (!a.compactItems.has(item.id)) {
            a.compactItems.add(item.id);
            this.publish(a, 'compacting', { item_id: item.id, ...(a.overflow || a.recovery ? { reason: 'contextWindowExceeded' } : {}) });
          }
          if (a.recovery && message.method === 'item/completed') a.recovery.compacted = true;
          a.activity = 'compacting context';
        } else if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') a.activity = 'delegated to subagent';
        else if (item.type !== 'agentMessage' && item.type !== 'reasoning' && item.type !== 'userMessage') a.activity = item.type ?? 'working';
        break;
      }
      case 'thread/compacted': if (a.recovery) a.recovery.compacted = true; break;
      case 'serverRequest/resolved':
        a.pending = a.pending.filter((r) => r.wireId !== p.requestId);
        this.pruneRequestEvents(a);
        if (!a.pending.length && a.status === 'waiting') a.status = 'running';
        break;
      case 'turn/completed': this.turnCompleted(a, p.turn); break;
      default: return;
    }
    this.persist().catch(() => {});
  }

  important(message) {
    return ['thread/started', 'turn/started', 'turn/completed', 'error', 'thread/tokenUsage/updated', 'thread/compacted', 'serverRequest/resolved'].includes(message.method)
      || (['item/started', 'item/completed'].includes(message.method) && ['agentMessage', 'contextCompaction'].includes(message.params?.item?.type));
  }

  turnCompleted(a, turn) {
    if (!turn?.id || a.completedTurns.has(turn.id)) return;
    if (a.terminalEmitted) {
      if (a.turnId === turn.id) { a.turnId = null; a.lastTurnId = turn.id; }
      return;
    }
    if (a.turnId && a.turnId !== turn.id) return;
    a.completedTurns.add(turn.id); a.lastTurnId = turn.id; a.turnId = null;
    a.pending = a.pending.filter((request) => request.params.threadId !== a.threadId || request.params.turnId !== turn.id);
    this.pruneRequestEvents(a);
    if (this.closing || a.interrupted || turn.status === 'interrupted') { a.recovery = null; this.finish(a, 'interrupted', {}); return; }
    if (a.recovery) {
      if (turn.status !== 'completed' || !a.recovery.compacted) {
        a.recovery = null;
        this.finish(a, 'failed', { message: turn.error?.message ?? 'Context compaction did not complete.' });
      } else {
        a.recovery = null;
        // startTurn already records this agent's failed/unknown outcome. A
        // rejected continuation must not terminate unrelated agents or helper.
        this.startTurn(a, CONTINUE).catch(() => {});
      }
      return;
    }
    if (turn.status === 'failed' && (a.overflow || isOverflow(turn.error)) && !a.recoveryUsed) {
      a.recoveryUsed = true; a.overflow = true; a.recovery = { compacted: false }; a.status = 'compacting';
      a.activity = 'compacting context';
      this.rpc('thread/compact/start', { threadId: a.threadId }).catch((error) => {
        if (a.recovery && !a.interrupted && !this.closing) { a.recovery = null; this.finish(a, 'failed', { message: `Context compaction failed: ${error.message}` }); }
      });
      return;
    }
    if (turn.status === 'completed') { a.result ??= a.unclassifiedResult ?? ''; this.finish(a, 'completed', { result: a.result }); }
    else this.finish(a, 'failed', { message: turn.error?.message ?? a.lastError?.message ?? 'Codex turn failed.', codexErrorInfo: turn.error?.codexErrorInfo ?? a.lastError?.codexErrorInfo });
  }

  finish(a, kind, details) {
    if (a.terminalEmitted) return;
    a.terminalEmitted = true;
    a.status = kind; a.activity = kind; a.turnId = null; a.recovery = null;
    // Descendants can outlive the root turn. Their wire IDs remain answerable
    // until their own turn ends, the server resolves them, or the controller closes.
    a.pending = a.pending.filter((request) => request.params.threadId !== a.threadId);
    this.pruneRequestEvents(a);
    if (kind === 'failed' || kind === 'unknown') a.error = details;
    this.publish(a, kind, details);
  }

  pruneRequestEvents(a) {
    this.pendingEvents = this.pendingEvents.filter((event) => event.agent_id !== a.id || !['question', 'approval'].includes(event.kind)
      || a.pending.some((request) => request.id === event.request_id && request.params.threadId === (event.source_thread_id ?? a.threadId)));
  }

  async serverRequest(message) {
    if (this.closed || this.closing) {
      await this.client.reject(message.id, -32000, 'Agent controller is closing.').catch(() => {});
      return;
    }
    const p = message.params ?? {}, sourceId = this.threadId(p), direct = this.threads.get(sourceId), a = direct ?? this.descendants.get(sourceId);
    if (this.retiredThreads.has(sourceId)) { await this.client.reject(message.id, -32601, 'Thread is not owned by this controller.'); return; }
    if (!a) {
      if (this.starting) { this.early.push({ request: true, message: copy(message) }); return; }
      await this.client.reject(message.id, -32601, 'Thread is not owned by this controller.'); return;
    }
    if (direct && a.startingTurn) { a.startEvents.push({ request: true, message: copy(message) }); return; }
    const activeTurnId = direct ? a.turnId : this.descendantTurns.get(sourceId);
    if (!direct && !activeTurnId) { await this.client.reject(message.id, -32602, 'Descendant has no active turn.'); return; }
    if (activeTurnId && p.turnId && p.turnId !== activeTurnId) { await this.client.reject(message.id, -32602, 'Stale agent turn.'); return; }
    if (direct && a.terminalEmitted) { await this.client.reject(message.id, -32602, 'Agent has no active turn.'); return; }
    if (message.method === 'item/tool/call' && a.externalThread) {
      const tool = nonempty(p.tool) ? p.tool : '(unknown)';
      a.unavailableTools ??= [];
      if (!a.unavailableTools.includes(tool)) {
        a.unavailableTools.push(tool);
        this.publish(a, 'message', { code: 'client_tools_unavailable', message: `Original client dynamic tool ${tool} is unavailable here. Continue the thread in its original Codex client if needed.` });
      }
      await this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: 'This dynamic tool belongs to the original client and is unavailable here. Continue this thread in its original Codex client if the tool is needed.' }], success: false });
      return;
    }
    if (message.method === 'item/tool/call' && p.tool === 'notify_parent') {
      const valid = nonempty(p.arguments?.message);
      if (valid && direct) this.publish(a, 'message', { message: p.arguments.message });
      await this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: valid ? direct ? 'Delivered to parent.' : 'Report this blocker to your Codex parent agent.' : 'A nonempty message is required.' }], success: valid });
      return;
    }
    const kind = message.method === 'item/tool/requestUserInput' ? 'question' : APPROVALS.has(message.method) ? 'approval' : null;
    if (!kind) { await this.client.reject(message.id, -32601, 'Unsupported server request.'); return; }
    const id = String(message.id);
    const existing = [...this.agents.values()].flatMap((agent) => agent.pending).find((r) => r.id === id);
    if (existing) {
      if (existing.wireId !== message.id || existing.params.threadId !== sourceId) await this.client.reject(message.id, -32600, 'Request id collides after string normalization.');
      return;
    }
    if (direct && !a.turnId && p.turnId) a.turnId = p.turnId;
    a.pending.push({ id, wireId: message.id, method: message.method, params: copy(p) });
    if (ACTIVE.has(a.status)) a.status = 'waiting';
    a.activity = `${direct ? '' : 'subagent '}waiting for parent ${kind}`;
    this.publish(a, kind, { method: message.method, ...copy(p), request_id: id,
      reply_format: replyFormat(message.method, p), ...(direct ? {} : { source_thread_id: sourceId }) });
  }

  async answer(a, id, answer) {
    const pending = a.pending.find((r) => r.id === String(id));
    if (!pending || pending.responding) throw new Error('No matching pending request.');
    let result;
    try { result = validateAnswer(pending, answer); }
    catch (error) {
      error.code = 'invalid_answer'; error.request_id = pending.id; error.reply_format = replyFormat(pending.method, pending.params);
      throw error;
    }
    pending.responding = true;
    try { await this.client.respond(pending.wireId, result); }
    catch (error) { pending.responding = false; throw error; }
    a.pending = a.pending.filter((r) => r !== pending);
    this.pruneRequestEvents(a);
    if (!a.pending.length) {
      if (a.status === 'waiting') a.status = 'running';
      a.activity = ACTIVE.has(a.status) ? 'working' : a.status;
    }
    await this.persist();
    return { agent_id: a.id, request_id: pending.id, answered: true };
  }

  async models() {
    const models = [], seen = new Set(); let cursor;
    do {
      const page = await this.rpc('model/list', { ...(cursor ? { cursor } : {}) });
      for (const model of page.data ?? []) {
        const id = model.model || model.id;
        models.push({ id, name: model.displayName, description: model.description, default: model.isDefault,
          efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort), default_effort: model.defaultReasoningEffort,
          ...(this.guidance.models?.[id]?.selection_note ? { selection_note: this.guidance.models[id].selection_note } : {}) });
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('model/list returned a repeated cursor.');
      seen.add(cursor);
    } while (cursor);
    return { models };
  }

  publish(a, kind, details) {
    const event = { seq: this.nextSeq++, agent_id: a.id, name: a.name ?? null, turn_id: details.turnId ?? a.turnId ?? a.lastTurnId ?? null, kind, ...details };
    this.pendingEvents.push(event);
    // Keep every important event until a future explicit retention policy exists.
    // No tool output, thinking, or input prompt enters this durable journal.
    this.persist().then(() => {
      if (this.agents.has(a.id) && this.pendingEvents.some((pending) => pending.seq === event.seq)) this.emit('event', copy(event));
    }).catch(() => {});
  }

  persist() {
    if (!this.statePath) return Promise.resolve();
    if (this.persistScheduled) return this.persistScheduled;
    // Snapshot once per microtask batch, then serialize disk writes. All callers
    // await the batch containing their mutation; failed writes still reject them.
    const write = this.persistTail.then(() => {
      this.persistScheduled = null;
      const data = { version: 1, nextSeq: this.nextSeq, retiredThreads: [...this.retiredThreads], pendingEvents: copy(this.pendingEvents), agents: [...this.agents.values()].map((a) => ({
      id: a.id, threadId: a.threadId, name: a.name, cwd: a.cwd, model: a.model, effort: a.effort, role: a.role, status: a.status,
      activity: a.activity, turnId: a.turnId, result: a.result, error: a.error, tokenUsage: a.tokenUsage,
      snapshot: a.snapshot, injected: a.injected, recoveryUsed: a.recoveryUsed, externalAdopted: a.externalAdopted, externalConflict: a.externalConflict, externalThread: a.externalThread, unavailableTools: a.unavailableTools,
    })) };
      return (async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const temp = `${this.statePath}.tmp`;
      await writeFile(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.statePath);
      })();
    });
    const durable = write.catch((error) => {
      // One failure notification per actual write batch, regardless of how many
      // callers share it. ACK/removal mutations must fail closed just like events.
      this.emit('controllerError', error);
      throw error;
    });
    this.persistScheduled = durable;
    this.persistTail = durable.catch(() => {});
    return durable;
  }

  disconnected() {
    if (this.closed) return;
    this.closed = true; this.resolveClosed();
    for (const a of this.agents.values()) {
      a.pending = [];
      this.pruneRequestEvents(a);
      if (ACTIVE.has(a.status)) this.finish(a, 'failed', { message: 'App-server connection closed.' });
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.resolve().then(() => this.shutdown());
    return this.closePromise;
  }

  async shutdown() {
    if (!this.closed) {
      const turns = new Map(this.descendantTurns);
      for (const a of this.agents.values()) {
        if (ACTIVE.has(a.status)) {
          a.interrupted = true;
          if (a.turnId) turns.set(a.threadId, a.turnId);
        }
      }
      // Use the connection directly: normal RPCs are refused while closing.
      // Bound shutdown even if a transport fails to enforce its timeout.
      await Promise.allSettled([...turns].map(async ([threadId, turnId]) => {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => this.closed ? undefined : this.client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 1500 })),
            new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
            this.closedPromise,
          ]);
        } finally { clearTimeout(timer); }
      }));
    }
    if (!this.closed) {
      this.closed = true; this.resolveClosed();
      for (const a of this.agents.values()) {
        a.pending = [];
        this.pruneRequestEvents(a);
        if (ACTIVE.has(a.status)) this.finish(a, 'interrupted', { reason: 'controller_closed' });
      }
    }
    this.client.off('notification', this.onNotification);
    this.client.off('request', this.onRequest);
    this.client.off('closed', this.onClosed);
    this.descendantTurns.clear();
    await this.persist();
  }
}

function replyFormat(method, params) {
  if (method === 'item/tool/requestUserInput') return { answers: Object.fromEntries(params.questions.map((question) => [question.id, { answers: ['<text>'] }])) };
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: Array.isArray(params.availableDecisions) ? '<one value from availableDecisions>' : 'accept|acceptForSession|decline|cancel' };
  }
  if (method === 'item/permissions/requestApproval') {
    const requested = params.permissions ?? {};
    const permissions = {};
    if (requested.network) permissions.network = { enabled: requested.network.enabled ?? null };
    if (requested.fileSystem) permissions.fileSystem = { read: requested.fileSystem.read ?? null, write: requested.fileSystem.write ?? null,
      ...(requested.fileSystem.entries ? { entries: copy(requested.fileSystem.entries) } : {}) };
    return { permissions, scope: 'turn' };
  }
  if (method === 'mcpServer/elicitation/request') return { action: 'accept|decline|cancel', content: '<form data or null>', _meta: null };
  throw new TypeError('Unsupported response format.');
}

function validateAnswer({ method, params }, answer) {
  if (!object(answer)) throw new TypeError('answer must be a protocol response object.');
  if (method === 'item/tool/requestUserInput') {
    const ids = params.questions.map((q) => q.id), answers = answer.answers;
    if (!object(answers) || Object.keys(answers).length !== ids.length || !ids.every((id) =>
      Array.isArray(answers[id]?.answers) && answers[id].answers.length > 0 && answers[id].answers.every(nonempty))) {
      throw new TypeError('Answer every question by its exact ID with nonempty strings.');
    }
    return { answers: copy(answers) };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const decision = answer.decision;
    let valid = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision);
    if (method === 'item/commandExecution/requestApproval' && object(decision)) {
      const exec = decision.acceptWithExecpolicyAmendment?.execpolicy_amendment;
      const network = decision.applyNetworkPolicyAmendment?.network_policy_amendment;
      valid = Object.keys(decision).length === 1 && ((Array.isArray(exec) && exec.length > 0 && exec.every(nonempty))
        || (object(network) && nonempty(network.host) && ['allow', 'deny'].includes(network.action)));
    }
    if (!valid) throw new TypeError('Invalid approval decision.');
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.some((allowed) => isDeepStrictEqual(allowed, decision))) {
      throw new TypeError('Approval decision is not in availableDecisions.');
    }
    return { decision: copy(decision) };
  }
  if (method === 'item/permissions/requestApproval') {
    const permissions = answer.permissions;
    if (!object(permissions) || !['turn', 'session'].includes(answer.scope) || Object.keys(permissions).some((k) => !['network', 'fileSystem'].includes(k))
      || (permissions.network !== undefined && (!object(permissions.network) || !Object.hasOwn(permissions.network, 'enabled') || (permissions.network.enabled !== null && typeof permissions.network.enabled !== 'boolean')))
      || (permissions.fileSystem !== undefined && !validFilePermissions(permissions.fileSystem))
      || (answer.strictAutoReview !== undefined && typeof answer.strictAutoReview !== 'boolean')) throw new TypeError('Invalid permissions response.');
    return copy(answer);
  }
  if (method === 'mcpServer/elicitation/request') {
    if (!['accept', 'decline', 'cancel'].includes(answer.action) || !Object.hasOwn(answer, 'content') || !Object.hasOwn(answer, '_meta')) throw new TypeError('Invalid elicitation response.');
    return copy(answer);
  }
  throw new TypeError('Unsupported answer method.');
}

function validFilePermissions(value) {
  if (!object(value) || !['read', 'write'].every((key) => Object.hasOwn(value, key) && (value[key] === null || (Array.isArray(value[key]) && value[key].every(nonempty))))) return false;
  if (Object.keys(value).some((key) => !['read', 'write', 'globScanMaxDepth', 'entries'].includes(key))) return false;
  if (value.globScanMaxDepth !== undefined && (!Number.isSafeInteger(value.globScanMaxDepth) || value.globScanMaxDepth < 0)) return false;
  if (value.entries !== undefined && (!Array.isArray(value.entries) || !value.entries.every((entry) => {
    if (!object(entry) || !['read', 'write', 'deny'].includes(entry.access) || !object(entry.path)) return false;
    const p = entry.path;
    if (p.type === 'path') return nonempty(p.path);
    if (p.type === 'glob_pattern') return nonempty(p.pattern);
    if (p.type !== 'special' || !object(p.value)) return false;
    const v = p.value;
    if (['root', 'minimal', 'tmpdir', 'slash_tmp'].includes(v.kind)) return true;
    if (v.kind === 'project_roots') return v.subpath === null || typeof v.subpath === 'string';
    return v.kind === 'unknown' && typeof v.path === 'string' && (v.subpath === null || typeof v.subpath === 'string');
  }))) return false;
  return true;
}
