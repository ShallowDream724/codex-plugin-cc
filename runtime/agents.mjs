import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadSettings, permissionParams } from './settings.mjs';
import { loadGuidance, defaultRole, resolveNativeDefault, externalClientTools } from './roles.mjs';
import { isParentNotificationCall, parentNotificationCapability, parentNotificationLimitation, parentNotificationTool, parentReportPending } from './parent-notification.mjs';
import { prepareAttachments, directUserInput } from './attachments.mjs';
import { claudeMessagePrefix } from '../shared/communication.mjs';
import { AUTOMATIC_TURN_EVENTS, agentPauseSummary, isCompactionStatus, isUserSend, restoreParentEvents } from './event-routing.mjs';
import { ACTION_PREFLIGHT_FAILURE } from './receipts.mjs';
import { answerFromItems, findOwnedTurn, readOwnedAnswer } from './turn-recovery.mjs';
import { MODEL_RECOVERY_TARGET_PREFIX, modelRecoveryDetails, modelRecoveryError, modelRecoveryOptions, pendingModelRecovery, providerModelUnavailable, readVisibleModels, replacementEffort, selectModelRecovery, unsupportedChatGPTLogin } from './model-recovery.mjs';

const CONTINUE = 'Continue the existing task from the compacted context. Do not repeat completed work.';
const STARTED_TURN_ID = Symbol('startedTurnId');
const ACTIVE = new Set(['starting', 'running', 'waiting', 'compacting']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const USER_PAUSE_CONFIRMATION_MS = 10000;
const USER_PAUSE_UI_RESPONSE_MS = 1500;
const isPauseReceipt = event => event.kind === 'user_action_receipt' && event.origin === 'user' && event.action === 'interrupt';
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0;
const preflightFailure = error => Object.assign(error, { [ACTION_PREFLIGHT_FAILURE]: true });
const CONTEXT_SOURCES = new Set(['new', 'claude', 'codex', 'unknown']);
function storedContextSource(a) {
  if (CONTEXT_SOURCES.has(a.contextSource)) return a.contextSource;
  if (a.externalThread === true || a.externalAdopted === true) return 'codex';
  if (a.injected === true || object(a.snapshot) && nonempty(a.snapshot.digest) && object(a.snapshot.stats)) return 'claude';
  return 'unknown';
}
const copy = (x) => structuredClone(x);
const input = (text) => [{ type: 'text', text }];
function resetAnswer(a, turnId = null) {
  a.answerTurnId = turnId;
  a.result = null;
  a.unclassifiedResult = null;
}
function bindAnswer(a, turnId) {
  if (a.answerTurnId !== turnId) resetAnswer(a, turnId);
}
const now = () => Date.now();
const staleModelRecoveryTarget = () => new Error('This recovery choice is invalid or expired. No message was sent. Use list_agents to check the original agent and get any current recovery choices.');
function catalogFailureHint(code) {
  if (code === -32601) return 'The external Codex app-server does not implement model/list. Check which Codex CLI executable the plugin starts and update it to a version that supports this method.';
  if (code === -32602) return 'The app-server rejected the model/list parameters. Check the thread provider ID and the protocol supported by the installed Codex CLI.';
  if (code === 'ETIMEDOUT') return 'The external Codex app-server did not answer model/list in time. Check its connection before retrying.';
  return '';
}
function consumedModelRecovery(a) {
  const receipt = a.lastModelRecovery;
  return Object.assign(new Error(`Codex already accepted turn ${receipt.turnId} on this thread using ${receipt.model}. This repeated recovery choice did not send another message. Use list_agents to see the current agent status.`),
    { code: 'model_recovery_consumed', agent_id: a.id, thread_id: a.threadId, model: receipt.model, turn_id: receipt.turnId, model_turn_started: false });
}
const pendingModelRecoveryRequest = () => new Error('This agent has a pending approval or question, so model recovery cannot start. Use answer_agent with the pending request_id, then retry followup_task once the agent and its descendants are idle.');
const isOverflow = (error) => error?.codexErrorInfo === 'contextWindowExceeded' || error?.code === 'contextWindowExceeded';
const roleConfig = (role) => role === 'default' ? { 'features.default_mode_request_user_input': false, 'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.image_generation': false } : undefined;
const configWithEffort = (config, effort) => nonempty(effort) ? { ...config, model_reasoning_effort: effort } : config;

/** Owns directly-created Codex threads; never forwards nested agents or tool traces. */
export class AgentController extends EventEmitter {
  constructor({ client, statePath, settings, nativeRoleResolver = resolveNativeDefault, pauseConfirmationMs = USER_PAUSE_CONFIRMATION_MS } = {}) {
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
    this.modelCatalogRequests = new Map();
    this.threads = new Map();
    this.descendants = new Map();
    this.unlinkedThreads = new Map();
    this.unlinkedTurns = new Map();
    this.descendantTurns = new Map();
    this.retiredThreads = new Set();
    this.pausedThreads = new Set();
    this.pauseOperations = new Map();
    this.pauseConfirmationMs = pauseConfirmationMs;
    this.stopAllPromise = null;
    this.stopAllInProgress = false;
    this.stopAllEpoch = 0;
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
    this.pendingEvents = restoreParentEvents(data.pendingEvents, data.agents).filter((event) => !['question', 'approval'].includes(event.kind));
    this.retiredThreads = new Set(data.retiredThreads ?? []);
    this.pausedThreads = new Set(data.pausedThreads ?? []);
    this.pauseOperations = new Map((data.pauseOperations ?? []).map(operation => [operation.id, operation]));
    this.unlinkedThreads = new Map(data.unlinkedThreads ?? []);
    this.unlinkedTurns = new Map(data.unlinkedTurns ?? []);
    this.nextSeq = data.pendingEvents.reduce((next, event) => Math.max(next, event.seq + 1), data.nextSeq ?? 1);
    for (const saved of data.agents) {
      const privateTurnIds = data.pendingEvents.filter(event => event.agent_id === saved.id && isUserSend(event) && event.phase === 'delivered').map(event => event.turn_id).filter(Boolean);
      const a = { ...saved, contextSource: storedContextSource(saved), lastTurnId: saved.turnId ?? saved.lastTurnId, turnOrigin: saved.turnOrigin ?? (privateTurnIds.includes(saved.turnId ?? saved.lastTurnId) ? 'user' : 'parent'), pending: [], completedTurns: new Set(), compactItems: new Set(), loaded: false, terminalEmitted: true };
      if (a.contextSource === 'codex') a.externalThread = true;
      if (a.modelRecovery && !nonempty(a.modelRecovery.ticket)) a.modelRecovery = pendingModelRecovery(a.modelRecovery.model, a.modelRecovery.reason);
      // A crashed steer has no confirmed acceptance. Restore the original parent
      // task's deferred facts; never infer successful takeover from an inflight RPC.
      this.pendingEvents.push(...(saved.pendingUserSteer?.events ?? []));
      a.pendingUserSteer = null;
      if (a.threadId && this.pausedThreads.has(a.threadId)) a.userPaused = true;
      if (a.userPaused) a.interrupted = true;
      if (a.userPaused && a.threadId) this.pausedThreads.add(a.threadId);
      this.agents.set(a.id, a);
      if (a.threadId) this.threads.set(a.threadId, a);
      // Older controllers saved a transport loss as a terminal failure, or
      // reconciled an idle thread without reading its registered turn.
      const legacyDisconnect = a.status === 'failed' && a.error?.message === 'App-server connection closed.';
      const legacyIdle = a.status === 'interrupted' && a.activity === 'outcome_reconciled' && a.parentContinuationPending === undefined;
      const legacyClose = a.status === 'interrupted' && a.parentContinuationPending === undefined && this.pendingEvents.some(e => e.agent_id === a.id && e.turn_id === a.lastTurnId && e.reason === 'controller_closed');
      if ((legacyClose || legacyIdle) && !a.userPaused && a.turnOrigin !== 'user') a.parentContinuationPending = true;
      if (ACTIVE.has(a.status) || a.turnId || a.replacementAttempt || a.reconcileTurnId && a.status !== 'unknown' || legacyDisconnect) {
        // An unacknowledged start may still have the *previous* lastTurnId.
        a.reconcileTurnId = a.turnId ?? a.reconcileTurnId ?? null;
        if (!a.userPaused && a.turnOrigin !== 'user') a.parentContinuationPending = true;
        if (a.userPaused) a.pauseReconcileTurnId = a.turnId ?? a.pauseReconcileTurnId;
        a.status = 'unknown'; a.turnId = null; a.activity = 'stale_pending';
        a.restartNoticePending = true;
      }
    }
    for (const [id, rootId] of data.descendants ?? []) {
      const root = this.agents.get(rootId);
      if (root) this.descendants.set(id, root);
    }
    this.descendantTurns = new Map((data.descendantTurns ?? []).filter(([id]) => this.descendants.has(id)));
    this.linkDescendants();
    this.pendingEvents = this.pendingEvents.filter(event => this.keepsParentEvent(event)).sort((a, b) => a.seq - b.seq);
    for (const operation of this.pauseOperations.values()) this.schedulePauseResult(operation);
    // A restarted controller cannot assume an active turn stopped. Reconcile
    // native state now so confirmed idle threads release capacity automatically.
    await Promise.allSettled([...this.agents.values()].filter((a) => a.status === 'unknown' && a.threadId).map((a) => this.reconcileUnknown(a)));
    for (const a of this.agents.values()) {
      if (a.restartNoticePending && a.status === 'unknown') this.publish(a, 'unknown', { ...(a.replacementAttempt ? this.unknownReplacementDetails(a) : {}), reason: 'controller_restarted', stale_pending: true });
      delete a.restartNoticePending;
    }
    await Promise.allSettled([...this.agents.values()].filter((a) => a.userPaused).map(async (a) => {
      await this.reconcileDescendants(a);
      return this.stopTree(a);
    }));
    await this.persist();
    return this;
  }

  view(a, metrics = false) {
    const result = { id: a.id, agent_id: a.id, thread_id: a.threadId, name: a.name, cwd: a.cwd,
      model: a.model, reasoning_effort: a.effort, status: a.status, activity: a.activity,
      turn_id: a.turnId, error: a.turnOrigin === 'user' && !metrics ? null : a.error ?? null,
      turn_origin: a.turnOrigin ?? 'parent',
      parent_notification: parentNotificationCapability(a),
      final_report_pending: parentReportPending(a),
      ...(a.modelRecovery ? { model_recovery: { model: a.modelRecovery.model, reason: a.modelRecovery.reason } } : {}),
      context_source: a.contextSource ?? 'unknown',
      user_paused: !!a.userPaused, user_control_status: a.userControlStatus ?? null,
      pending_requests: a.pending.map(({ id, method, params }) => ({ method, ...copy(params), request_id: id,
        reply_format: replyFormat(method, params), ...(params.threadId !== a.threadId ? { source_thread_id: params.threadId } : {}) })) };
    if (metrics) {
      result.token_usage = copy(a.tokenUsage ?? null); result.result = a.status === 'completed' ? a.result ?? null : null;
      result.context_snapshot = copy(a.snapshot ?? null);
    }
    return result;
  }

  snapshot() { return { agents: [...this.agents.values()].map((a) => this.view(a, true)), pendingEvents: copy(this.pendingEvents), nextSeq: this.nextSeq }; }
  hasQueuedEvents() { return this.pendingEvents.length > 0; }
  hasActiveWork() {
    return this.descendantTurns.size > 0 || [...this.agents.values()].some((a) => ACTIVE.has(a.status) || a.status === 'unknown' || a.turnId || a.pending.length > 0);
  }
  hasParentWork() {
    return this.pauseOperations.size > 0 || [...this.agents.values()].some(a => !a.userPaused && (a.pending.length > 0 || a.turnOrigin !== 'user' && this.occupies(a)));
  }
  keepsParentEvent(event) { return isPauseReceipt(event) || this.agents.has(event.agent_id); }
  eventsAfter(cursor = 0, targets = []) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Array.isArray(targets)) throw new TypeError('Invalid event cursor or targets.');
    const ids = new Set(targets.map((target) => this.find(target).id));
    return copy(this.pendingEvents.filter(e => this.keepsParentEvent(e) && e.seq > cursor && (!ids.size || ids.has(e.agent_id) || e.scope === 'session')));
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

  async dispatch(operation, args = {}, action) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    switch (operation) {
      case 'spawn_agent': return this.spawn(args, action);
      case 'list_agents': return this.listAgents(args.includeModelDiagnostics !== false);
      case 'list_models': return this.models();
      case 'send_message': return this.send(this.find(args.target), args.message);
      case 'followup_task': return this.followup(args.target, args.message, args.replacement_model, action);
      case 'interrupt_agent': return this.interrupt(this.find(args.target));
      case 'ui_interrupt': return this.uiInterrupt(this.find(args.target));
      case 'ui_interrupt_all': return this.uiInterruptAll();
      case 'ui_send': return this.uiSend(this.find(args.target), args.message, args.attachments, { privateTask: args.private_task, reportToParent: args.report_to_parent });
      case 'close_agent': return this.closeSelected(args);
      case 'answer_agent': return this.answer(this.find(args.target), args.request_id, args.answer);
      default: throw new Error(`Unknown operation: ${operation}`);
    }
  }

  find(target) {
    if (typeof target === 'string' && target.startsWith('codex://threads/')) target = target.slice('codex://threads/'.length);
    const matches = nonempty(target) ? [...this.agents.values()].filter((a) => a.id === target || a.threadId === target || a.name === target) : [];
    if (matches.length !== 1) throw preflightFailure(new Error(matches.length ? 'Ambiguous agent target.' : 'Unknown agent target.'));
    return matches[0];
  }

  occupies(a, { allowResume = false } = {}) {
    return ACTIVE.has(a.status) || a.status === 'unknown' || !!a.turnId || !!a.pending.length || a.spawning || a.resuming && !allowResume || a.startingTurn || a.recovery || this.hasActiveDescendant(a);
  }

  hasActiveDescendant(a) {
    return [...this.descendants].some(([id, root]) => root === a && this.descendantTurns.has(id));
  }

  requireIdleReplacement(a, options) {
    if (a.pending.length || a.status === 'waiting') throw pendingModelRecoveryRequest();
    if (this.occupies(a, options) || a.sending || a.stopPromise) throw new Error('This agent or one of its descendants is still active, so model recovery cannot start. Wait until they are idle, then retry followup_task with the same recovery target.');
  }

  reserve(key, a) {
    if (a && this.occupies(a)) return false;
    const count = [...this.agents.values()].filter((agent) => this.occupies(agent)).length + this.reservations.size;
    if (count >= this.settings.maxActiveAgents) throw new Error(`Active agent limit (${this.settings.maxActiveAgents}) reached.`);
    this.reservations.add(key);
    return true;
  }

  action(kind, a, message, origin, attachments, turnId = a.turnId ?? null, turnInput) {
    if (kind === 'send' || kind === 'interrupt') { a.lastActivityAtMs = now(); this.persist().catch(() => {}); this.emit('state'); }
    this.emit('agentAction', { kind, agent_id: a.id, thread_id: a.threadId ?? null, turn_id: turnId, ...(turnId && turnInput ? { turn_input: turnInput } : {}), name: a.name ?? null, ...(origin ? { origin } : {}), ...(message === undefined ? {} : { message }), ...(attachments?.length ? { attachments: copy(attachments) } : {}) });
  }

  updateResolved(a, response, { keepModel = false } = {}) {
    const model = response?.model ?? response?.thread?.model;
    const provider = response?.modelProvider ?? response?.thread?.modelProvider;
    const effort = response?.reasoningEffort ?? response?.thread?.reasoningEffort;
    const threadName = response?.thread?.name;
    const matchesModel = !keepModel || !nonempty(a.model) || !nonempty(model) || model === a.model;
    if (nonempty(model) && (!keepModel || !nonempty(a.model))) a.model = model;
    if (nonempty(provider) && (!keepModel || !nonempty(a.modelProvider))) a.modelProvider = provider;
    // Native thread metadata can still report the configured default.
    if (nonempty(effort) && matchesModel && !a.effortPinned) a.effort = effort;
    if (nonempty(threadName)) a.threadName = threadName;
  }

  async rpc(method, params, timeoutMs = 120000) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    return Promise.race([this.client.request(method, params, { timeoutMs }), this.closedPromise.then(() => { throw new Error('App-server connection closed.'); })]);
  }

  async resumeThread(a, { effort = a.effort, ...overrides } = {}) {
    const config = configWithEffort(roleConfig(a.role), a.effortPinned ? effort : undefined);
    const response = await this.rpc('thread/resume', { threadId: a.threadId, excludeTurns: true, ...permissionParams(this.settings), ...overrides, ...(config ? { config } : {}) });
    if ((a.externalThread || a.externalAdopted) && a.adoptedParentNotification === undefined && response?.thread?.id === a.threadId) {
      const tools = await externalClientTools(response.thread);
      if (tools.status === 'known') a.adoptedParentNotification = tools.parentNotification === true;
    }
    return response;
  }

  visibleModels(provider) {
    const key = provider ?? '';
    if (!this.modelCatalogRequests.has(key)) {
      const request = readVisibleModels((method, params) => this.rpc(method, params), provider);
      this.modelCatalogRequests.set(key, request);
      const clear = () => this.modelCatalogRequests.delete(key);
      request.then(clear, clear);
    }
    return this.modelCatalogRequests.get(key);
  }

  async failureCatalog(a) {
    // A diagnostic read must not hold notifications for the full RPC timeout.
    let timer;
    try {
      const catalog = await Promise.race([this.visibleModels(a.modelProvider), new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 1500);
      })]);
      return { catalog };
    } catch (error) { return { catalog: null, hint: catalogFailureHint(error.code) }; }
    finally { clearTimeout(timer); }
  }

  async listAgents(includeModelDiagnostics) {
    const agents = [...this.agents.values()];
    const status = a => {
      const row = this.view(a);
      if (row.error?.code === 'agent_model_unavailable' && Array.isArray(row.error.recovery_choices)) {
        // Choices belong to a particular catalog read. Expose current choices
        // under model_recovery; keep only the historical outcome under error.
        const { available_models, recommended_model, recovery_choices, retry_after_access_fix, ...failure } = row.error;
        failure.message = failure.during_compaction ? 'Context recovery failed.'
          : failure.model_turn_started ? 'The turn failed because its model was unavailable.'
          : 'The requested model was unavailable. No turn was started.';
        row.error = failure;
      }
      return row;
    };
    if (!includeModelDiagnostics) return { agents: agents.map(status) };
    const rows = await Promise.all(agents.map(async a => {
      const gate = a.modelRecovery;
      const diagnosis = gate ? await this.failureCatalog(a) : null;
      if (this.agents.get(a.id) !== a) return null;
      const row = status(a);
      if (gate && a.modelRecovery === gate) {
        Object.assign(row.model_recovery, modelRecoveryOptions(a, diagnosis.catalog));
        if (diagnosis.hint) row.model_recovery.message = diagnosis.hint + ' ' + row.model_recovery.message;
      }
      return row;
    }));
    return { agents: rows.filter(Boolean) };
  }

  async enrichModelFailureEvent(event) {
    const a = this.agents.get(event.agent_id);
    const gate = a?.modelRecovery;
    if (!gate || event.model !== gate.model || a.error?.code !== 'agent_model_unavailable' || event.turn_id && event.turn_id !== a.lastTurnId) return event;
    const { catalog, hint } = await this.failureCatalog(a);
    if (this.agents.get(a.id) !== a || a.modelRecovery !== gate) return event;
    if (!catalog) return hint ? { ...event, message: event.message + ' ' + hint } : event;
    const enriched = modelRecoveryDetails(a, catalog, event.model_turn_started, { turnId: event.turn_id, duringCompaction: event.during_compaction, chatgptLoginUnsupported: event.access_hint === 'unsupported_chatgpt_login' });
    return { ...event, ...enriched };
  }

  async prepareTurnModel(a, replacementModel, { duringCompaction = false, retryAfterFix = false } = {}) {
    if (!nonempty(a.model)) return { effort: a.effort };
    let catalog;
    try { catalog = await this.visibleModels(a.modelProvider); }
    catch (cause) {
      const explanation = duringCompaction ? 'Context recovery stopped before starting a new turn.' : 'No turn was started.';
      const diagnosis = catalogFailureHint(cause.code);
      const recovery = a.modelRecovery ? 'Use list_agents to refresh the recovery choices without sending the task.'
        : `Retry followup_task with target set to agent ID ${a.id} and your intended message once the model catalog is available.`;
      throw Object.assign(new Error([`Could not verify the Codex model catalog for agent ${a.name ?? a.id}.`, explanation, diagnosis, recovery].filter(Boolean).join(' '), { cause }),
        { code: 'model_catalog_unavailable', agent_id: a.id, thread_id: a.threadId, model: a.model, model_turn_started: false, ...(duringCompaction ? { during_compaction: true } : {}) });
    }
    if (replacementModel !== undefined) {
      if (a.modelRecovery.reason === 'model_not_listed' && catalog.has(a.model)) {
        a.modelRecovery = null;
        await this.persist();
        throw new Error(`Model ${a.model} is visible again. The unused recovery choices have expired. No model was changed or turn started. To send your task with ${a.model}, use the original agent ID ${a.id} and your intended message.`);
      }
      const rejected = a.modelRecovery.rejectedModels?.includes(replacementModel) || replacementModel === a.modelRecovery.model && a.modelRecovery.reason === 'provider_model_unavailable';
      if (!catalog.has(replacementModel) || (retryAfterFix ? !rejected : rejected || replacementModel === a.modelRecovery.model)) {
        throw modelRecoveryError(a, catalog, false, { invalidReplacement: replacementModel });
      }
      return { model: replacementModel, effort: replacementEffort(catalog.get(replacementModel), a.effort), catalog, replacement: true };
    }
    if (!catalog.has(a.model) && !a.modelRecovery) {
      a.modelRecovery = pendingModelRecovery(a.model, 'model_not_listed');
      await this.persist();
    }
    if (a.modelRecovery && (a.modelRecovery.reason === 'provider_model_unavailable' || !catalog.has(a.model))) {
      throw modelRecoveryError(a, catalog, false, { duringCompaction });
    }
    return { model: a.model, effort: a.effort, catalog };
  }

  acceptTurnModel(a, plan, turnId) {
    if (plan.replacement) {
      const gate = a.modelRecovery;
      if (gate) {
        const rejected = new Set(gate.rejectedModels);
        if (gate.reason === 'provider_model_unavailable') rejected.add(gate.model);
        rejected.delete(plan.model);
        a.lastModelRecovery = { ticket: gate.ticket, model: plan.model, turnId, rejectedModels: [...rejected] };
      }
      a.model = plan.model; a.effort = plan.effort;
    }
    a.replacementAttempt = null;
    if (plan.model) a.modelRecovery = null;
  }

  requireModelRecovery(a, recoveryTicket) {
    if (recoveryTicket && a.lastModelRecovery?.ticket === recoveryTicket) throw consumedModelRecovery(a);
    if (recoveryTicket !== undefined && a.modelRecovery?.ticket !== recoveryTicket) throw staleModelRecoveryTarget();
    if (a.modelRecovery?.model !== a.model || !a.modelRecovery || !a.threadId) {
      throw new Error(`Agent ${a.id} has no pending model recovery. Call followup_task with this agent ID as the target and your intended message to continue with its current model.`);
    }
  }

  async latestNativeTurn(a) {
    const page = await this.rpc('thread/turns/list', { threadId: a.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!Array.isArray(page?.data) || page.data.length && !nonempty(page.data[0]?.id)) throw new Error('Native Codex returned an invalid latest turn.');
    return page.data[0];
  }

  noteUnavailableModel(a, plan, cause) {
    if (!plan.replacement) a.modelRecovery = pendingModelRecovery(plan.model, 'provider_model_unavailable');
    else a.modelRecovery.rejectedModels = [...new Set([...(a.modelRecovery.rejectedModels ?? []), plan.model])];
    return modelRecoveryError(a, plan.catalog, false, { rejectedReplacement: plan.replacement ? plan.model : undefined, chatgptLoginUnsupported: unsupportedChatGPTLogin(cause) });
  }

  recordRejectedTurnModel(a, turnId) {
    a.modelRecovery = pendingModelRecovery(a.model, 'provider_model_unavailable');
    if (turnId && a.lastModelRecovery?.turnId === turnId && a.lastModelRecovery.rejectedModels?.length) {
      a.modelRecovery.rejectedModels = [...a.lastModelRecovery.rejectedModels];
    }
  }

  async checkSpawnModel({ model, provider, role, a, catalog, resolvedModel }) {
    if (!nonempty(model)) return;
    const state = a ? `Native thread ${a.threadId} is registered as agent ${a.id}. No turn was started.` : 'No agent or native thread was created.';
    const details = { model, model_turn_started: false, ...(a ? { agent_id: a.id, thread_id: a.threadId } : {}) };
    const scope = provider ? ` for provider ${provider}` : '';
    try { catalog ??= await this.visibleModels(provider); }
    catch (cause) {
      const recovery = 'Retry spawn_agent once the model catalog is available.';
      throw Object.assign(new Error([`Could not verify the Codex model catalog${scope}.`, state, catalogFailureHint(cause.code), recovery].filter(Boolean).join(' '), { cause }),
        { ...details, code: 'model_catalog_unavailable', recovery });
    }
    const mismatch = nonempty(resolvedModel) && resolvedModel !== model;
    if (catalog.has(model) && !mismatch) return catalog;
    const available_models = [...catalog.keys()];
    if (!catalog.has(model)) {
      const recovery = available_models.length
        ? `Call spawn_agent with a model the user has chosen from available_models. Ask which model to use if their choice is unclear.${role ? ' Omit the unavailable role preset or update its configured model first.' : ''}`
        : 'Retry spawn_agent when the catalog lists a selectable model.';
      throw Object.assign(new Error(`Model ${model} is absent from the visible Codex model catalog${scope}. ${state} ${recovery}`),
        { ...details, code: 'agent_model_unavailable', reason: 'model_not_listed', available_models, recovery });
    }
    const recovery = 'Check the Codex configuration, then call spawn_agent with the model you intend to use.';
    throw Object.assign(new Error(`Codex resolved model ${resolvedModel} for requested model ${model}. ${state} ${recovery}`),
      { ...details, code: 'model_resolution_mismatch', resolved_model: resolvedModel, available_models, recovery });
  }

  async spawn({ message, cwd, model, reasoning_effort, name, context_mode, snapshot, role }, action) {
    if (this.stopAllInProgress) throw new Error('A user stop-all action is in progress; retry afterward.');
    let roleInstructions = '';
    if (role !== undefined) {
      if (role !== 'default') throw preflightFailure(new TypeError('Unknown role.'));
      const preset = defaultRole(this.guidance);
      if (model !== undefined && model !== preset.model || reasoning_effort !== undefined && reasoning_effort !== preset.reasoning_effort || context_mode !== undefined && context_mode !== 'none') throw preflightFailure(new TypeError('role default requires its configured model, effort, and context_mode none.'));
      model = preset.model; reasoning_effort = preset.reasoning_effort; context_mode = 'none'; roleInstructions = `${preset.instructions}\n\n`;
    }
    context_mode ??= 'available';
    if (!nonempty(message) || !nonempty(cwd)) throw preflightFailure(new TypeError('message and cwd are required.'));
    if (!path.posix.isAbsolute(cwd) && !path.win32.isAbsolute(cwd)) throw preflightFailure(new TypeError('cwd must be an absolute path.'));
    if (!['available', 'none'].includes(context_mode)) throw preflightFailure(new TypeError('context_mode must be available or none.'));
    if (context_mode === 'available' && (!object(snapshot) || !Array.isArray(snapshot.history) || !nonempty(snapshot.digest) || !object(snapshot.stats))) {
      throw preflightFailure(new Error('context_mode available requires a validated snapshot.'));
    }
    const reservation = Symbol('spawn'); this.reserve(reservation);
    const stopAllEpoch = this.stopAllEpoch;
    let nativeDefault, provider, configuredModel, catalog, pendingConfig;
    try {
      // The workspace configuration may establish the provider before thread/start.
      // Reuse the native role read and prefer the provider returned by thread/start.
      const readConfig = () => pendingConfig ??= this.rpc('config/read', { cwd, includeLayers: true }, 1500);
      if (role === undefined) nativeDefault = await this.nativeRoleResolver({ cwd, guidance: this.guidance, readConfig });
      const configuration = pendingConfig || nonempty(model) ? (await readConfig().catch(() => undefined))?.config : undefined;
      provider = nonempty(configuration?.model_provider) ? configuration.model_provider : undefined;
      configuredModel = configuration?.model;
      if (provider && nonempty(model)) catalog = await this.checkSpawnModel({ model, provider, role });
      if (this.stopAllInProgress || this.stopAllEpoch !== stopAllEpoch) throw new Error('A user stop-all action interrupted agent creation; retry afterward.');
    } finally { this.reservations.delete(reservation); }
    const createdAtMs = now();
    const a = { id: randomUUID(), name, cwd, model, effort: reasoning_effort, effortPinned: nonempty(reasoning_effort), role, createdAtMs, lastActivityAtMs: createdAtMs, contextSource: context_mode === 'available' ? 'claude' : 'new', status: 'starting', activity: 'starting',
      pending: [], turnId: null, completedTurns: new Set(), compactItems: new Set(), loaded: true, recoveryUsed: false, interrupted: false, spawning: true };
    this.agents.set(a.id, a);
    this.starting++;
    let spawnTurnId = null, recordSpawnAction = false;
    try {
      const config = configWithEffort(roleConfig(role) ?? { 'features.default_mode_request_user_input': true, ...nativeDefault }, reasoning_effort);
      const response = await this.rpc('thread/start', { cwd, ...(model ? { model } : {}), ...permissionParams(this.settings), ephemeral: false, serviceTier: 'default',
        config, dynamicTools: role === 'default' ? [] : [parentNotificationTool] });
      if (!nonempty(response.thread?.id)) throw new Error('thread/start returned no thread id.');
      this.updateResolved(a, response);
      if (!nonempty(a.model) && nonempty(configuredModel) && provider && a.modelProvider === provider) a.model = configuredModel;
      a.modelProvider ??= provider;
      a.threadId = response.thread.id;
      this.unlinkedTurns.delete(a.threadId);
      if (a.userPaused) { this.pausedThreads.add(a.threadId); a.pauseDurable = this.persist(); await a.pauseDurable; }
      this.threads.set(a.threadId, a);
      this.linkDescendants();
      this.replayEarly(a.threadId);
      if (!a.interrupted) catalog = await this.checkSpawnModel({ model: model ?? a.model, provider: a.modelProvider, role, a,
        catalog: a.modelProvider === provider ? catalog : undefined, resolvedModel: a.model });
      if (a.interrupted) {
        if (!a.turnId && ACTIVE.has(a.status)) this.finish(a, 'interrupted', { reason: 'interrupt' });
        return { ...this.view(a), context_snapshot: null };
      }
      recordSpawnAction = true;
      if (context_mode === 'available') {
        await this.rpc('thread/inject_items', { threadId: a.threadId, items: snapshot.history });
        a.snapshot = { digest: snapshot.digest, stats: snapshot.stats };
        a.injected = true;
      }
      const collaboration = role === 'default' ? 'Claude is your parent agent.\n\n' : `${this.guidance.collaboration.trim()}\n\n`;
      if (!a.interrupted) spawnTurnId = await this.startTurn(a, collaboration + roleInstructions + message, { newTask: true, plan: { model: a.model, effort: a.effort, catalog }, action });
      const result = { ...this.view(a), context_snapshot: a.snapshot ? { ...copy(a.snapshot), ...(Object.hasOwn(snapshot, 'preview') ? { preview: copy(snapshot.preview) } : {}) } : null };
      this.markActionFailureReported(action, a.error, result);
      return result;
    } catch (error) {
      spawnTurnId = error[STARTED_TURN_ID] ?? null;
      const modelPreflightFailed = ['agent_model_unavailable', 'model_catalog_unavailable', 'model_resolution_mismatch'].includes(error.code);
      let details;
      if (ACTIVE.has(a.status) && !a.turnId) {
        const kind = this.closing || a.interrupted ? 'interrupted' : 'failed';
        details = { ...(modelPreflightFailed ? error : {}), message: error.message };
        this.finish(a, kind, details, kind === 'failed' ? action : undefined);
      }
      const recovery = a.threadId ? `Inspect or continue agent ${a.id} on native thread ${a.threadId}; do not create replacement work until its state is known.` : `Agent ${a.id} has no confirmed native thread; inspect its status or close it before retrying.`;
      const failure = modelPreflightFailed ? Object.assign(error, { status: a.status })
        : Object.assign(new Error(`Agent ${a.id}${a.threadId ? ` (thread ${a.threadId})` : ''}: ${error.message} ${recovery}`, { cause: error }), { reason: error.reason, agent_id: a.id, thread_id: a.threadId ?? null, status: a.status, recovery: error.recovery ?? recovery });
      this.markActionFailureReported(action, details, failure);
      if (action?.outcome === error) action.outcome = failure;
      throw failure;
    } finally {
      // Bind the local task placeholder to this exact first turn. A native
      // completion may already have cleared a.turnId before turn/start replies.
      a.startAction = null;
      if (recordSpawnAction) this.action('spawn', a, message, undefined, undefined, spawnTurnId, 'start');
      a.spawning = false;
      if (a.interrupted) this.stopTree(a).catch(() => {});
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

  async startTurn(a, text, { newTask = false, origin = 'parent', reportToParent = false, plan = { model: a.model, effort: a.effort }, action } = {}) {
    if (this.closed || this.closing) throw new Error('Agent controller is closed or closing.');
    if (a.userPaused) throw new Error('Agent is paused by the user. Only a user message can resume it.');
    const previousTaskTurns = newTask ? new Set(a.completedTurns) : null;
    const continueReport = !newTask && !!a.parentReportTurnId;
    a.parentReportTurnId = null;
    if (newTask) { a.recoveryUsed = false; a.interrupted = false; a.error = null; a.terminalEmitted = false; a.turnOrigin = origin; }
    a.compactItems.clear();
    resetAnswer(a);
    a.awaitingTurnId = true;
    a.liveAnswerOnly = false;
    a.reconcileTurnId = null;
    a.lastError = null;
    a.modelUnavailableTurnId = null;
    a.status = a.pending.length ? 'waiting' : 'running'; a.activity = a.pending.length ? 'waiting for parent' : 'working'; a.turnId = null; a.overflow = false;
    a.startingTurn = true;
    a.startEvents = [];
    if (plan.replacement) a.replacementAttempt = { model: plan.model, effort: plan.effort, priorTurnId: plan.priorTurnId };
    let response, boundTurnId = null, startRequested = false;
    try {
      // Record the recipient before native work can emit a result or survive a
      // controller restart. The same native thread/history remains in use.
      await this.persist();
      if (a.userPaused || a.interrupted) {
        a.replacementAttempt = null;
        this.finish(a, 'interrupted', { reason: 'interrupt' });
        throw new Error('The agent was stopped before the message could be sent. The user can resume it with a direct message in the Codex interface.');
      }
      if (plan.replacement && (a.pending.length || this.hasActiveDescendant(a))) {
        a.replacementAttempt = null;
        const failure = a.pending.length ? pendingModelRecoveryRequest() : new Error('An agent descendant became active before model recovery could start. Wait until it is idle, then retry followup_task with the same recovery target.');
        this.finish(a, 'failed', { message: failure.message });
        throw failure;
      }
      startRequested = true;
      response = await this.rpc('turn/start', { threadId: a.threadId, input: Array.isArray(text) ? text : input(text),
        ...(plan.model ? { model: plan.model } : {}), ...(plan.effort ? { effort: plan.effort } : {}), serviceTierForTurn: 'default' });
      if (!nonempty(response?.turn?.id)) throw new Error('turn/start returned no turn id; start outcome is unknown.');
      boundTurnId = response.turn.id;
      if (a.turnOrigin === 'user' && (reportToParent || continueReport)) a.parentReportTurnId = boundTurnId;
      // Only an authoritative start reply ties the native turn to this tool result.
      if (action) a.startAction = { action, turnId: boundTurnId };
      this.acceptTurnModel(a, plan, boundTurnId);
      a.startingTurn = false;
      await this.replayTurnStart(a, response.turn.id);
      if (['completed', 'failed', 'interrupted'].includes(response.turn.status)) this.turnCompleted(a, response.turn);
    } catch (error) {
      a.startingTurn = false;
      // On a lost reply, a single observed start is the best available identity.
      // On success, the response above is authoritative and discards late traffic
      // from older tasks, without retaining every historical turn ID forever.
      const observed = [...new Set((a.startEvents ?? []).filter((entry) => !entry.request && entry.message.method === 'turn/started')
        .map((entry) => entry.message.params.turn.id).filter((id) => id !== plan.priorTurnId && !a.completedTurns.has(id)))];
      boundTurnId ??= observed.length === 1 ? observed[0] : null;
      if (boundTurnId && a.startEvents) this.acceptTurnModel(a, plan, boundTurnId);
      await this.replayTurnStart(a, boundTurnId);
      if (!boundTurnId && plan.model && providerModelUnavailable(error)) {
        a.replacementAttempt = null;
        const unavailable = this.noteUnavailableModel(a, plan, error);
        const details = { ...unavailable, message: unavailable.message };
        this.finish(a, 'failed', details, action);
        await this.persist();
        this.markActionFailureReported(action, details, unavailable);
        throw unavailable;
      }
      const rejected = Number.isInteger(error.code);
      if (!boundTurnId && (rejected || !startRequested)) a.replacementAttempt = null;
      let failure = error;
      let details = { message: error.message, reason: rejected ? 'turn_start_rejected' : 'turn_start_outcome_unknown',
        ...(rejected ? {} : { recovery: `Keep this same agent. An explicit send, followup, interrupt, or close first checks native Codex thread ${a.threadId} metadata and restores its subscription when needed. Do not create replacement work or automatically resend the original task; if metadata remains inconclusive, inspect this thread in Codex.` }) };
      if (plan.replacement && startRequested) {
        if (boundTurnId) {
          const recovery = `Inspect thread ${a.threadId} in Codex before resending the followup.`;
          details = { message: `Codex started turn ${boundTurnId} with replacement model ${plan.model}, but the followup acknowledgement failed. ${recovery}` };
        } else if (rejected) {
          const recovery = 'Check the followup message and retry followup_task with the same recovery target once the request can be accepted.';
          details = { message: `Codex rejected the request to start a turn with replacement model ${plan.model}. No turn was started. ${recovery}`, reason: 'turn_start_rejected' };
        } else {
          details = this.unknownReplacementDetails(a);
        }
        failure = Object.assign(new Error(details.message, { cause: error }), { code: error.code, ...details });
      }
      // A transport failure says nothing about whether the server started work.
      // An observed turn remains authoritative even if its RPC reply was lost.
      const startFailed = !a.turnId && !a.terminalEmitted;
      if (startFailed) this.finish(a, rejected ? 'failed' : 'unknown', details, action);
      await this.persist();
      if (startFailed && action?.failureDetails === details) {
        failure = Object.assign(new Error(details.message, { cause: failure }), { code: failure.code, ...details, agent_id: a.id, thread_id: a.threadId, status: a.status });
        this.markActionFailureReported(action, details, failure);
      }
      if (Object.isExtensible(failure)) failure[STARTED_TURN_ID] = boundTurnId;
      throw failure;
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
    if (a.interrupted && a.turnId) await this.requestTreeInterrupt(a, a.threadId, a.turnId);
    await this.persist();
    if (a.lastTurnId === turn.id && a.error?.code === 'agent_model_unavailable' && a.modelRecovery) {
      const error = modelRecoveryError(a, plan.catalog, true, { turnId: turn.id, chatgptLoginUnsupported: a.error.access_hint === 'unsupported_chatgpt_login' });
      error[STARTED_TURN_ID] = turn.id;
      this.markActionFailureReported(action, a.error, error);
      throw error;
    }
    return response.turn.id;
  }

  async replayTurnStart(a, turnId) {
    const events = a.startEvents ?? [];
    a.startEvents = null;
    if (turnId && !a.terminalEmitted && !a.turnId) { a.turnId = turnId; a.awaitingTurnId = false; }
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
    if (a.settlingTurn) return a.settlingTurn;
    if (a.reconciling) return a.reconciling;
    const reconcile = async () => {
      let resumed = false;
      a.error = { ...a.error };
      delete a.error.reconciliation_error; delete a.error.reconciliation_status;
      try {
        const response = await this.rpc('thread/read', { threadId: a.threadId, includeTurns: false });
        if (a.status !== 'unknown') return;
        let status = response?.thread?.status?.type;
        let model = response?.thread?.model;
        if (status === 'active' && !a.loaded) {
          if (a.reconcileTurnId && !a.userPaused) {
            const latest = await this.latestNativeTurn(a);
            if (a.status !== 'unknown') return;
            if (latest?.id !== a.reconcileTurnId || latest.status !== 'inProgress') {
              const turn = latest?.id === a.reconcileTurnId ? latest : await findOwnedTurn(this.rpc.bind(this), a.threadId, a.reconcileTurnId);
              if (a.status !== 'unknown') return;
              if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) await this.settleRecoveredTurn(a, turn);
              else a.error = { ...a.error, reconciliation_status: 'the active native turn does not match the registered turn' };
              await this.persist();
              return;
            }
          }
          const response = await this.resumeThread(a);
          this.updateResolved(a, response, { keepModel: true });
          model = response?.model ?? response?.thread?.model ?? model;
          resumed = true; a.loaded = true;
          if (a.status !== 'unknown') return { resumed };
          // The thread may finish while its subscription is being restored.
          // Use the resume response before deciding whether to bind a live turn.
          status = response?.thread?.status?.type;
        }
        const idle = ['idle', 'notLoaded'].includes(status);
        const ownedId = a.reconcileTurnId;
        const turn = ownedId && !a.userPaused && (idle || status === 'active')
          ? await findOwnedTurn(this.rpc.bind(this), a.threadId, ownedId)
          : status === 'active' || idle && a.replacementAttempt ? await this.latestNativeTurn(a) : undefined;
        if (a.settlingTurn) { await a.settlingTurn; return { resumed }; }
        if (a.status !== 'unknown') return { resumed };
        if (a.replacementAttempt && (status === 'active' || idle)) {
          const attempt = a.replacementAttempt;
          if (idle && (turn?.id ?? null) === attempt.priorTurnId) {
            a.replacementAttempt = null;
          } else if (nonempty(turn?.id) && turn.id !== attempt.priorTurnId && model === attempt.model && (idle ? ['completed', 'failed', 'interrupted'].includes(turn.status) : turn.status === 'inProgress')) {
            this.acceptTurnModel(a, { ...attempt, replacement: true }, turn.id);
            a.lastTurnId = turn.id;
            a.reconcileTurnId = turn.id;
            a.awaitingTurnId = false;
            if (idle && turn.status === 'failed' && providerModelUnavailable(turn.error)) {
              this.recordRejectedTurnModel(a, turn.id);
              a.terminalEmitted = false;
              this.finish(a, 'failed', modelRecoveryDetails(a, null, true, { turnId: turn.id, chatgptLoginUnsupported: unsupportedChatGPTLogin(turn.error) }));
              await this.persist();
              return { resumed };
            }
          } else {
            a.error = { ...a.error, reconciliation_status: 'native metadata could not confirm the attempted model replacement' };
            await this.persist();
            return { resumed };
          }
        }
        if (turn?.id && turn.id === a.reconcileTurnId && ['completed', 'failed', 'interrupted'].includes(turn.status) && !a.userPaused) {
          await this.settleRecoveredTurn(a, turn);
        } else if (idle) {
          if (status === 'notLoaded') a.loaded = false;
          a.pauseReconcileTurnId = null;
          a.status = 'interrupted'; a.activity = 'outcome_reconciled'; a.turnId = null;
          a.error = null; a.terminalEmitted = true; a.interrupted = true; a.reconcileTurnId = null; a.recovery = null;
          resetAnswer(a);
          a.parentContinuationPending ??= !a.userPaused && a.turnOrigin !== 'user';
          this.publish(a, 'interrupted', { reason: 'outcome_reconciled', native_status: status });
        } else if (status === 'active') {
          // Read a single turn with no item history. An active thread alone is
          // insufficient to infer which turn may safely be steered/interrupted.
          if (nonempty(turn?.id) && (!ownedId || turn.id === ownedId) && !(a.awaitingTurnId && turn.id === a.lastTurnId) && turn.status === 'inProgress') {
            a.pauseReconcileTurnId = null;
            a.turnId = turn.id; a.lastTurnId = turn.id; a.status = a.pending.length ? 'waiting' : 'running';
            a.reconcileTurnId = turn.id;
            a.awaitingTurnId = false;
            a.activity = a.pending.length ? 'waiting for parent' : 'working'; a.error = null; a.terminalEmitted = false;
          } else a.error = { ...a.error, reconciliation_status: 'active thread has no confirmed inProgress turn' };
        } else a.error = { ...a.error, reconciliation_status: status ?? 'missing thread status' };
      } catch (error) {
        if (a.status === 'unknown') a.error = { ...a.error, reconciliation_error: a.replacementAttempt ? 'native Codex metadata could not be read' : error.message };
        else throw error;
      }
      await this.persist();
      return { resumed };
    };
    a.reconciling = reconcile();
    try { return await a.reconciling; }
    finally { a.reconciling = null; this.scheduleTurnReconciliation(a); }
  }

  scheduleTurnReconciliation(a) {
    if (this.closed || this.closing || a.status !== 'unknown' || !a.reconcileTurnId || a.reconcileTimer || this.agents.get(a.id) !== a) return;
    // A missed terminal notification may be the last event on the thread.
    // Retry read-only reconciliation even if nobody sends another message.
    a.reconcileDelay = Math.min((a.reconcileDelay ?? 500) * 2, 30000);
    a.reconcileTimer = setTimeout(() => {
      a.reconcileTimer = null;
      if (!this.closed && !this.closing && this.agents.get(a.id) === a) this.reconcileUnknown(a).catch(() => {});
    }, a.reconcileDelay);
    a.reconcileTimer.unref?.();
  }

  async settleRecoveredTurn(a, turn) {
    if (a.settlingTurn) return a.settlingTurn;
    // Keep the terminal turn unavailable to steer until its final has been
    // recovered. Retrying the exact read is safe after a crash or read error.
    a.status = 'unknown'; a.turnId = null; a.terminalEmitted = true;
    const settle = async () => {
      bindAnswer(a, turn.id);
      if (turn.status === 'completed' && !a.interrupted && !a.recovery && !a.liveAnswerOnly && a.result == null) {
        const { final, legacy } = answerFromItems(turn.items);
        a.result = final ?? await readOwnedAnswer(this.rpc.bind(this), a.threadId, turn.id);
        if (!a.result) a.result = legacy ?? a.unclassifiedResult ?? '';
      }
      if (this.closed || a.reconcileTurnId !== turn.id) return;
      a.terminalEmitted = false; a.error = null;
      if (a.recovery) a.status = 'compacting';
      this.turnCompleted(a, turn);
      await this.persist();
    };
    a.settlingTurn = Promise.resolve().then(settle);
    try { await a.settlingTurn; }
    finally { a.settlingTurn = null; }
  }

  unknownReplacementDetails(a) {
    const recovery = `Inspect thread ${a.threadId} in Codex before resending the followup.`;
    const metadata = a.error?.reconciliation_error ?? a.error?.reconciliation_status;
    const explanation = `Codex did not confirm whether it started a turn with replacement model ${a.replacementAttempt.model} on thread ${a.threadId}.`;
    const message = `${explanation}${metadata ? ' Native metadata could not confirm the attempted model replacement.' : ''} ${recovery}`;
    return { message, reason: 'turn_start_outcome_unknown' };
  }

  unknownError(a) {
    if (a.replacementAttempt) {
      const details = this.unknownReplacementDetails(a);
      return Object.assign(new Error(details.message), details);
    }
    return new Error(`Previous turn/start outcome is unknown; native metadata could not confirm a safe operation (${a.error?.reconciliation_error ?? a.error?.reconciliation_status ?? 'unconfirmed thread'}). Inspect thread ${a.threadId} in Codex before retrying.`);
  }

  async followup(target, message, replacementModel, action) {
    if (!nonempty(message)) throw preflightFailure(new TypeError('message must be nonempty.'));
    if (typeof target === 'string' && target.startsWith(MODEL_RECOVERY_TARGET_PREFIX)) {
      const selection = selectModelRecovery(this.agents.values(), target);
      if (!selection) throw preflightFailure(staleModelRecoveryTarget());
      if (selection.consumed) throw consumedModelRecovery(selection.agent);
      return this.send(selection.agent, message, { followup: true, replacementModel: selection.model, recoveryTicket: selection.ticket, retryAfterFix: selection.retryAfterFix, action });
    }
    if (replacementModel !== undefined && !nonempty(replacementModel)) throw preflightFailure(new TypeError('replacement_model must be nonempty.'));
    const threadLink = typeof target === 'string' && target.startsWith('codex://threads/');
    let id = threadLink ? target.slice('codex://threads/'.length) : target;
    if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) id = id.toLowerCase();
    const matches = nonempty(id) ? [...this.agents.values()].filter((a) => a.id === id || a.threadId === id || a.name === id) : [];
    if (matches.length > 1) throw preflightFailure(new Error('Ambiguous agent target. Use an agent ID.'));
    const existing = matches[0];
    if (this.adoptions.has(existing?.threadId ?? id)) throw new Error(`Thread ${existing?.threadId ?? id} is already being adopted; retry using the registered agent after it completes.`);
    if (existing) return this.send(existing, message, { followup: true, replacementModel, action });
    if (replacementModel !== undefined) throw preflightFailure(new Error('The requested agent has no registered model recovery. Call followup_task with its agent ID or native Codex thread link and your intended message to check its current model.'));
    if (this.stopAllInProgress) throw new Error('A user stop-all action is in progress; retry afterward.');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw preflightFailure(new Error('Unknown agent target; native thread IDs must be UUIDs.'));
    const reservation = Symbol('adopt'); this.reserve(reservation);
    const stopAllEpoch = this.stopAllEpoch;
    this.adoptions.set(id, true);
    try {
      const response = await this.rpc('thread/read', { threadId: id, includeTurns: false }).catch(error => {
        // An unknown UUID may be a session-local agent ID or a native thread
        // ID. A read failure does not establish that Claude was forked.
        const message = threadLink
          ? `Could not read Codex thread ${id}: ${error.message} Verify the thread link and its state in Codex before retrying.`
          : `No agent ${id} is registered in this Claude session, and native thread lookup failed: ${error.message} Use a current agent_id from list_agents, or the original Codex thread_id/link for an agent from another session.`;
        throw new Error(message, { cause: error });
      });
      const thread = response?.thread;
      if (thread?.id !== id || !nonempty(thread.cwd) || !path.posix.isAbsolute(thread.cwd) && !path.win32.isAbsolute(thread.cwd)) throw new Error('Native thread metadata has no matching ID and absolute cwd.');
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw new Error(`Native thread status is ${thread.status?.type ?? 'unknown'}; active or unconfirmed external threads cannot be adopted.`);
      const { parentNotification, ...clientTools } = await externalClientTools(thread);
      if (this.stopAllInProgress || this.stopAllEpoch !== stopAllEpoch) throw new Error('A user stop-all action interrupted adoption; retry afterward.');
      const createdAtMs = Number.isFinite(thread.createdAt) && thread.createdAt > 0 && Number.isSafeInteger(thread.createdAt * 1000) ? thread.createdAt * 1000 : null;
      const lastActivityAtMs = Number.isFinite(thread.updatedAt) && thread.updatedAt > 0 ? thread.updatedAt * 1000 : null;
      const a = { id: randomUUID(), threadId: id, cwd: thread.cwd, createdAtMs, lastActivityAtMs, contextSource: 'codex', status: 'interrupted', activity: 'adopted',
        pending: [], turnId: null, completedTurns: new Set(), compactItems: new Set(), loaded: false, recoveryUsed: false, interrupted: false, terminalEmitted: true, adopting: true, externalAdopted: true, externalThread: true,
        ...(clientTools.status === 'known' ? { adoptedParentNotification: parentNotification === true } : {}) };
      if (this.pausedThreads.has(id)) { a.userPaused = true; a.userControlStatus = 'stopped'; a.interrupted = true; }
      this.updateResolved(a, { thread });
      this.retiredThreads.delete(id); this.agents.set(a.id, a); this.threads.set(id, a);
      try {
        await this.persist();
        if (a.userPaused) throw new Error(`Agent ${a.id} remains paused by the user. Resume it with a direct user message in the interface.`);
        const result = await this.send(a, message, { followup: true, existingReservation: reservation, action });
        const limitation = clientTools.status === 'unknown'
          ? 'The original client’s dynamic tools could not be verified. If a needed tool is unavailable here, continue in the original Codex client.'
          : clientTools.tools.length ? 'Original client dynamic tools are unavailable here. Continue in the original Codex client if those tools are needed.' : undefined;
        const limitations = [limitation, parentNotificationLimitation(result.parent_notification ?? parentNotificationCapability(a))].filter(Boolean);
        const outcome = { ...result, client_tools_unavailable: clientTools, ...(limitations.length ? { limitations } : {}) };
        if (action?.outcome === result) action.outcome = outcome;
        return outcome;
      } catch (error) {
        if (['agent_model_unavailable', 'model_catalog_unavailable'].includes(error.code)) throw error;
        const failure = new Error(`Thread ${id} is registered as agent ${a.id}. ${error.message} Inspect the thread in Codex or retry using this agent ID; do not create replacement work.`, { cause: error });
        if (action?.outcome === error) {
          Object.assign(failure, { reason: error.reason, recovery: error.recovery, agent_id: a.id, thread_id: id, status: a.status });
          action.outcome = failure;
        }
        throw failure;
      }
    } catch (error) {
      if (error.cause || error.code === 'agent_model_unavailable') throw error;
      throw new Error(`Could not adopt native thread ${id}: ${error.message} Inspect the thread in Codex and retry when its state is confirmed.`, { cause: error });
    } finally { const a = this.threads.get(id); if (a) a.adopting = false; this.reservations.delete(reservation); this.adoptions.delete(id); }
  }

  async send(a, message, { followup = false, existingReservation, origin, privateTask = false, reportToParent = false, expectedReportTurnId, resumeToken, attachments = [], replacementModel, recoveryTicket, retryAfterFix, action } = {}) {
    if (!nonempty(message) && !(origin === 'user' && attachments.length)) throw preflightFailure(new TypeError('message must be nonempty.'));
    if (a.userResumeToken && a.userResumeToken !== resumeToken) throw new Error('A direct user message is resuming this agent; retry after it completes.');
    if (a.userPaused) throw new Error('This agent is paused by the user. The user can resume it with a direct message in the Codex interface.');
    const epoch = a.controlEpoch ?? 0;
    const wireInput = origin === 'user' ? directUserInput(message, attachments) : input(claudeMessagePrefix + message);
    if (a.adopting && !existingReservation) throw new Error(`Thread ${a.threadId} is being adopted.`);
    if (a.externalConflict) throw new Error(`Thread ${a.threadId} became active in another client. Close this agent and retry adoption once the native thread is idle.`);
    if (replacementModel !== undefined) this.requireModelRecovery(a, recoveryTicket);
    await this.reconcileUnknown(a);
    if (this.closed || this.closing) throw new Error('App-server connection closed.');
    if (a.userResumeToken && a.userResumeToken !== resumeToken) throw new Error('A direct user message is resuming this agent; retry after it completes.');
    if (a.userPaused || (a.controlEpoch ?? 0) !== epoch) throw new Error('The agent was paused by the user before the message could be sent. The user can resume it with a direct message in the Codex interface.');
    if (a.status === 'unknown') throw this.unknownError(a);
    if (replacementModel !== undefined) this.requireModelRecovery(a, recoveryTicket);
    if (a.removing || this.agents.get(a.id) !== a) throw new Error('This agent is closing or has been closed. Use list_agents to confirm its status before continuing.');
    if (replacementModel !== undefined) this.requireIdleReplacement(a);
    if (a.pending.length || a.status === 'waiting') throw new Error('Agent is waiting for a response; use answer_agent with its pending request_id.');
    if (expectedReportTurnId && a.turnId !== expectedReportTurnId) throw new Error('The turn selected for sharing already ended. Send a separate message with the option to share its final reply.');
    if (ACTIVE.has(a.status)) {
      if (privateTask && a.turnOrigin !== 'user') throw new Error('This agent is working on a Claude task. Wait for it to finish before starting a separate private question.');
      if (!a.turnId || a.status === 'compacting') throw new Error('Agent turn is not steerable yet.');
      const turnId = a.turnId, turnOrigin = a.turnOrigin;
      a.sending = (a.sending ?? 0) + 1;
      try {
        const response = await this.rpc('turn/steer', { threadId: a.threadId, expectedTurnId: turnId, input: wireInput });
        // The acknowledgement can arrive after this turn completed and even
        // after another turn started. Never transfer ownership of that new turn.
        const crossedCompletion = a.turnId !== turnId || a.completedTurns.has(turnId);
        if (crossedCompletion || reportToParent && response?.turnId !== turnId) {
          await this.persist();
          return { agent_id: a.id, status: 'steer_unconfirmed', turn_id: turnId,
            recovery: reportToParent ? 'Codex could not confirm the exact turn for sharing. Once it has finished, send a separate message with the option to share its final reply.' :
              'The turn completed while Codex was acknowledging the message. The message outcome is unknown. Inspect the same agent before retrying.' };
        }
        if (reportToParent && a.turnOrigin === 'user' && !a.userPaused && (a.controlEpoch ?? 0) === epoch) a.parentReportTurnId = turnId;
        if (followup && origin !== 'user' && turnOrigin === 'user' && a.turnOrigin === 'user') {
          // A private final item may precede the turn completion notification.
          // Never reuse that already-observed text as the new parent's result.
          resetAnswer(a, turnId);
          a.liveAnswerOnly = true;
          a.turnOrigin = 'parent';
        }
        this.action('send', a, message, origin, attachments, turnId, 'steer');
        await this.persist();
        return { agent_id: a.id, status: 'steered', turn_id: response.turnId ?? turnId };
      } finally { a.sending--; if (a.interrupted) this.stopTree(a).catch(() => {}); }
    }
    if (a.resuming) throw new Error('Agent followup is already starting.');
    const reservation = existingReservation ?? Symbol('followup');
    if (followup && !existingReservation) this.reserve(reservation, a);
    a.resuming = true;
    this.reservations.delete(reservation);
    try {
      let plan = followup ? await this.prepareTurnModel(a, replacementModel, { retryAfterFix }) : { model: a.model };
      const wasLoaded = a.loaded;
      if (a.userPaused || (a.controlEpoch ?? 0) !== epoch) throw new Error('The agent was paused by the user before the message could be sent. The user can resume it with a direct message in the Codex interface.');
      if (plan.replacement) this.requireIdleReplacement(a, { allowResume: true });
      // A completed turn keeps this connection's native thread loaded. Resume
      // only after a restart/unload; repeated followups use the same writer.
      if (!a.loaded) {
        let response;
        try {
          response = await this.resumeThread(a, { effort: plan.effort,
            ...(plan.model ? { model: plan.model } : {}), ...(a.modelProvider ? { modelProvider: a.modelProvider } : {}) });
        } catch (error) {
          if (followup && plan.model && providerModelUnavailable(error)) {
            const unavailable = this.noteUnavailableModel(a, plan, error);
            await this.persist();
            throw unavailable;
          }
          if (!plan.replacement) throw error;
          throw new Error(`Codex could not resume thread ${a.threadId} with replacement model ${plan.model}. No turn was requested. Inspect the same thread in Codex and retry the recovery target once the thread is available.`, { cause: error });
        }
        if (nonempty(response?.thread?.id) && response.thread.id !== a.threadId) throw new Error(`Codex returned a different thread while resuming thread ${a.threadId}. No task was sent. Verify the original thread in Codex before retrying.`);
        if ((a.externalAdopted || replacementModel !== undefined) && !['idle', 'notLoaded'].includes(response?.thread?.status?.type)) {
          if (a.externalAdopted) a.externalConflict = true;
          const recovery = a.externalConflict ? 'Once the thread is idle in Codex, close this agent and call followup_task with the original thread ID and your intended message.' : 'Confirm the thread is idle in Codex, then retry followup_task with the same recovery target.';
          throw new Error(`Codex could not confirm that thread ${a.threadId} was idle during resume. No task was sent. ${recovery}`);
        }
        a.loaded = true;
        const resumedModel = response?.model ?? response?.thread?.model;
        const resumedProvider = response?.modelProvider ?? response?.thread?.modelProvider;
        if (followup && plan.model && nonempty(resumedModel) && resumedModel !== plan.model) {
          a.loaded = false;
          throw new Error(`Codex resumed thread ${a.threadId} with model ${resumedModel} instead of ${plan.model}. No task was sent. Check the thread's model configuration in Codex before retrying.`);
        }
        if (followup && a.modelProvider && nonempty(resumedProvider) && resumedProvider !== a.modelProvider) {
          a.loaded = false;
          throw new Error(`Codex resumed thread ${a.threadId} with a different model provider. No task was sent. Check the thread's provider configuration in Codex before retrying.`);
        }
        if (!plan.replacement) {
          this.updateResolved(a, response, { keepModel: true });
          if (followup && !plan.model && a.model) plan = await this.prepareTurnModel(a);
          else if (followup) plan.effort = a.effort;
        }
      }
      a.loaded = true;
      a.externalAdopted = false;
      if (plan.replacement) {
        const priorTurn = wasLoaded && !a.externalThread ? null : await this.latestNativeTurn(a).catch(cause => {
          throw new Error(`Codex could not confirm the latest turn on thread ${a.threadId}. No replacement task was sent. Confirm the thread is idle in Codex, then retry followup_task with the same recovery target.`, { cause });
        });
        if (priorTurn?.status === 'inProgress') throw new Error(`Codex thread ${a.threadId} is still active. No replacement task was sent. Wait until it is idle, then retry followup_task with the same recovery target.`);
        plan.priorTurnId = priorTurn?.id ?? (wasLoaded && !a.externalThread ? a.lastTurnId : null) ?? null;
      }
      if (a.userPaused || (a.controlEpoch ?? 0) !== epoch) throw new Error('The agent was paused by the user before the message could be sent. The user can resume it with a direct message in the Codex interface.');
      if (plan.replacement) this.requireIdleReplacement(a, { allowResume: true });
      if (!followup) {
        await this.rpc('thread/inject_items', { threadId: a.threadId,
          items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: claudeMessagePrefix + message }] }] });
        this.action('send', a, message, origin, attachments);
        await this.persist();
        return { agent_id: a.id, status: 'stored', model_turn_started: false };
      }
      const recipient = origin === 'user' && (privateTask || !a.parentContinuationPending) ? 'user' : 'parent';
      const startedTurnId = await this.startTurn(a, wireInput, { newTask: true, origin: recipient, reportToParent, plan, action });
      this.action('send', a, message, origin, attachments, startedTurnId, 'start');
      await this.persist();
      const result = this.view(a);
      this.markActionFailureReported(action, a.error, result);
      return result;
    } finally { a.startAction = null; a.resuming = false; if (a.interrupted) this.stopTree(a).catch(() => {}); }
  }

  async closeSelected(args) {
    const { target, targets, except } = args;
    if (target !== undefined && targets !== undefined) throw preflightFailure(new TypeError('Specify target or targets, not both.'));
    if (except !== undefined && (!Array.isArray(except) || except.some((x) => !nonempty(x)))) throw preflightFailure(new TypeError('except must be an array of nonempty targets.'));
    if (except !== undefined && targets !== 'all') throw preflightFailure(new TypeError('except is only valid with targets all.'));
    if (targets === undefined && target !== undefined && except === undefined) return this.closeAgent(this.find(target));
    if (targets !== 'all' && (!Array.isArray(targets) || targets.length === 0 || targets.some((x) => !nonempty(x)))) throw preflightFailure(new TypeError('targets must be all or a nonempty array of targets.'));
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
    if (a.userResumeToken) throw new Error('A direct user message is being delivered; retry closing afterward.');
    if (a.status === 'unknown') throw new Error('Agent turn/start outcome is unknown; reconcile the native Codex thread before closing ownership.');
    if (!TERMINAL.has(a.status) || a.turnId || a.pending.length || a.spawning || a.adopting || a.resuming || a.startingTurn || a.sending || a.recovery || a.stopPromise) {
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
        this.threads.delete(id); this.descendants.delete(id); this.unlinkedThreads.delete(id); this.unlinkedTurns.delete(id); this.descendantTurns.delete(id);
      }
      this.agents.delete(a.id);
      this.pendingEvents = this.pendingEvents.filter(event => this.keepsParentEvent(event));
      this.early = this.early.filter((entry) => !threadIds.has(this.threadId(entry.message.params)));
      await this.persist();
      this.action('close', a);
      return { agent_id: a.id, thread_id: a.threadId, status: 'closed' };
    } finally { a.removing = false; }
  }

  async restoreSubscription(a) {
    try {
      const response = await this.resumeThread(a);
      this.updateResolved(a, response, { keepModel: true });
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
      if (a.userPaused) { a.stopError = error.message; this.updateStopStatus(a); }
      else this.publish(a, 'message', { code: 'subscription_restore_failed', message: `Closing agent ${a.id} was cancelled and subscription recovery is unconfirmed: ${error.message}\n${a.error.recovery}` });
      await this.persist();
    }
  }

  async interrupt(a) {
    a.interrupted = true;
    return this.stopTree(a);
  }

  beginUserPause(scope, agents) {
    const operation = { id: randomUUID(), scope, deadline: now() + this.pauseConfirmationMs,
      roots: agents.map(a => ({ agent_id: a.id, name: [a.name, a.threadName].find(nonempty) ?? a.id })) };
    // A session pause covers every outstanding tree selected by an earlier
    // in-flight pause. The settled results already in the journal stay intact.
    for (const a of agents) {
      const previous = this.pauseOperations.get(a.userPauseId);
      if (previous) this.cancelPauseResult(previous);
      a.userPauseId = operation.id;
    }
    this.pauseOperations.set(operation.id, operation);
    this.schedulePauseResult(operation);
  }

  schedulePauseResult(operation) {
    operation.timer = setTimeout(() => this.settleUserPause(operation, true), Math.max(0, operation.deadline - now()));
    operation.timer.unref();
  }

  cancelPauseResult(operation) {
    this.pauseOperations.delete(operation.id);
    clearTimeout(operation.timer);
  }

  settleUserPause(operation, expired = false) {
    if (!operation || !this.pauseOperations.has(operation.id)) return;
    const outstanding = operation.roots.filter(({ agent_id }) => {
      const a = this.agents.get(agent_id);
      return a?.userPaused && a.userPauseId === operation.id && this.treeBusy(a);
    });
    if (!expired && outstanding.some(({ agent_id }) => !this.agents.get(agent_id).stopError)) return;
    this.cancelPauseResult(operation);
    for (const { agent_id } of outstanding) {
      const a = this.agents.get(agent_id);
      a.stopError ??= 'Native Codex did not confirm that this agent and its descendants stopped before the deadline.';
      this.updateStopStatus(a);
    }
    const confirmed = !outstanding.length;
    const receipt = { kind: 'user_action_receipt', origin: 'user', action: 'interrupt', scope: operation.scope,
      phase: confirmed ? 'confirmed' : 'unconfirmed' };
    if (operation.scope === 'agent') {
      const root = operation.roots[0];
      Object.assign(receipt, root, { summary: agentPauseSummary(root.name, confirmed) });
    } else {
      const names = outstanding.map(({ name }) => name).join('、');
      receipt.summary = confirmed ? '用户暂停了本会话中的所有 Codex 代理。'
        : `以下 Codex 代理及其子代理的暂停状态尚未确认：${names}。可在代理列表查看状态。`;
      if (!confirmed) receipt.unconfirmed_agents = outstanding;
    }
    // The operation and its result share one journal snapshot across restarts.
    this.enqueueParentEvent(receipt);
  }

  prepareUserInterrupt(a) {
    const changed = !a.userPaused;
    a.userPaused = true; a.interrupted = true; a.controlEpoch = (a.controlEpoch ?? 0) + 1;
    if (a.threadId) this.pausedThreads.add(a.threadId);
    for (const [threadId, root] of this.descendants) if (root === a) this.pausedThreads.add(threadId);
    if (!a.stopPromise) a.interruptSent = new Map();
    if (changed) {
      a.userControlStatus = this.treeBusy(a) ? 'stopping' : 'stopped';
      if (a.pending.length) this.pruneRequestEvents(a);
      this.action('interrupt', a, undefined, 'user');
    }
  }

  async uiInterrupt(a) {
    if (!a.userPaused) this.beginUserPause('agent', [a]);
    this.prepareUserInterrupt(a);
    a.pauseDurable = this.persist();
    // The pause barrier must be durable before any native operation is awaited.
    await a.pauseDurable;
    const result = await this.requestUserStop(a);
    return { ...result, user_paused: !!a.userPaused, user_control_status: a.userControlStatus ?? null };
  }

  async uiInterruptAll() {
    if (this.stopAllPromise) return this.stopAllPromise;
    if (this.stopAllInProgress) throw new Error('A user stop-all action is in progress; retry afterward.');
    this.stopAllInProgress = true;
    this.stopAllEpoch++;
    const agents = [...this.agents.values()];
    const busy = agents.filter(a => this.treeBusy(a));
    if (busy.some(a => !a.userPaused)) this.beginUserPause('session', busy);
    // Install every in-memory barrier before yielding to persistence or RPCs.
    for (const a of agents) this.prepareUserInterrupt(a);
    const durable = this.persist();
    for (const a of agents) a.pauseDurable = durable;
    const run = async () => {
      try {
        await durable;
        const settled = await Promise.allSettled(agents.map(a => this.requestUserStop(a)));
        return { results: settled.map((result, i) => {
          const a = agents[i];
          if (result.status === 'fulfilled') return { ...result.value, user_paused: !!a.userPaused, user_control_status: a.userControlStatus ?? null };
          a.stopError = result.reason?.message ?? String(result.reason);
          this.updateStopStatus(a);
          return { agent_id: a.id, status: 'unconfirmed', user_paused: true, user_control_status: 'unconfirmed', error: a.stopError };
        }) };
      } catch (error) {
        return { results: agents.map(a => {
          a.stopError = error.message; this.updateStopStatus(a);
          return { agent_id: a.id, status: 'unconfirmed', user_paused: true, user_control_status: 'unconfirmed', error: error.message };
        }) };
      }
    };
    this.stopAllPromise = run();
    try { return await this.stopAllPromise; } finally { this.stopAllPromise = null; this.stopAllInProgress = false; }
  }

  async requestUserStop(a) {
    let timer;
    try {
      return await Promise.race([this.stopTree(a), new Promise(resolve => {
        timer = setTimeout(() => resolve(this.stopResult(a)), USER_PAUSE_UI_RESPONSE_MS);
      })]);
    } finally { clearTimeout(timer); }
  }

  async uiSend(a, message, attachments, { privateTask = false, reportToParent = false } = {}) {
    if (this.stopAllInProgress) throw new Error('A user stop-all action is in progress; retry afterward.');
    if (typeof privateTask !== 'boolean') throw new TypeError('private_task must be a boolean.');
    if (typeof reportToParent !== 'boolean') throw new TypeError('report_to_parent must be a boolean.');
    if (message !== undefined && typeof message !== 'string') throw new TypeError('message must be a string.');
    if (a.userResumeToken) throw new Error('A direct user message is already being delivered.');
    const resumeToken = Symbol('user resume');
    const epoch = a.controlEpoch ?? 0;
    const reportingActive = reportToParent && ACTIVE.has(a.status);
    if (reportingActive && !a.turnId) throw new Error('Wait until the current turn can accept a message or has finished before requesting a report.');
    const expectedReportTurnId = reportingActive ? a.turnId : undefined;
    a.userResumeToken = resumeToken;
    try {
      const files = await prepareAttachments(attachments);
      if ((a.controlEpoch ?? 0) !== epoch) throw new Error('Agent was paused by the user before the message could be sent.');
      message ??= '';
      if (!nonempty(message) && !files.length) throw new TypeError('A message or attachment is required.');
      if (a.pending.length || a.status === 'waiting') throw new Error('Agent is waiting for a response; answer the pending request first.');
      if (a.userPaused && (this.treeBusy(a) || a.stopPromise)) throw new Error('Interruption is not yet confirmed; retry after all agent work stops.');
      if (!ACTIVE.has(a.status) && this.hasActiveDescendant(a)) throw new Error('Agent has an active descendant; wait for it to finish before resuming.');
      const wasPaused = !!a.userPaused;
      try {
        a.userPaused = false; a.userControlStatus = null; a.userPauseId = null;
        if (wasPaused) await this.persist();
        const result = await this.send(a, message, { followup: true, origin: 'user', privateTask, reportToParent, expectedReportTurnId, resumeToken, attachments: files });
        if (wasPaused && !a.userPaused && a.threadId) this.pausedThreads.delete(a.threadId);
        await this.persist();
        const delivery = ['steered', 'steer_unconfirmed'].includes(result.status) ? result.status : 'started';
        return { ...result, delivery, final_report_pending: parentReportPending(a), user_paused: !!a.userPaused, user_control_status: a.userControlStatus ?? null };
      } catch (error) {
        if (wasPaused && !a.userPaused) {
          a.userPaused = true; a.interrupted = true; a.controlEpoch = (a.controlEpoch ?? 0) + 1;
          if (a.threadId) this.pausedThreads.add(a.threadId);
          a.userControlStatus = this.treeBusy(a) ? 'unconfirmed' : 'stopped';
        }
        a.pauseDurable = this.persist();
        await a.pauseDurable;
        if (a.userPaused && this.treeBusy(a)) await this.stopTree(a);
        throw error;
      }
    } finally { if (a.userResumeToken === resumeToken) a.userResumeToken = null; }
  }

  treeBusy(a) {
    return a.status === 'unknown' || ACTIVE.has(a.status) || !!a.turnId || !!a.startingTurn || !!a.spawning || !!a.resuming || !!a.sending || !!a.recovery || this.hasActiveDescendant(a);
  }

  async reconcileDescendants(a) {
    for (const [threadId, root] of this.descendants) {
      const knownTurn = this.descendantTurns.get(threadId);
      if (root !== a || !knownTurn) continue;
      try {
        let status = (await this.rpc('thread/read', { threadId, includeTurns: false }))?.thread?.status?.type;
        if (this.descendantTurns.get(threadId) !== knownTurn) continue;
        if (status === 'active') {
          status = (await this.rpc('thread/resume', { threadId, excludeTurns: true, ...permissionParams(this.settings) }))?.thread?.status?.type;
          if (this.descendantTurns.get(threadId) !== knownTurn) continue;
          if (status === 'active') {
            const page = await this.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
            const turn = page?.data?.[0];
            if (this.descendantTurns.get(threadId) === knownTurn && turn?.status === 'inProgress' && nonempty(turn.id)) this.descendantTurns.set(threadId, turn.id);
          }
        }
        if (['idle', 'notLoaded'].includes(status)) this.descendantTurns.delete(threadId);
      } catch { /* Preserve the last known turn until native state can be confirmed. */ }
    }
  }

  updateStopStatus(a) {
    if (!a.userPaused) return;
    const busy = this.treeBusy(a);
    if (!busy) a.stopError = null;
    const status = busy ? (a.stopError ? 'unconfirmed' : 'stopping') : 'stopped';
    if (status !== a.userControlStatus) {
      a.userControlStatus = status;
      this.persist().then(() => this.emit('state')).catch(() => {});
    }
    this.settleUserPause(this.pauseOperations.get(a.userPauseId));
  }

  async stopTree(a) {
    if (a.stopPromise) return a.stopPromise;
    a.stopError = null;
    const stop = async () => {
      await this.reconcileUnknown(a);
      if (a.status === 'unknown') a.stopError = this.unknownError(a).message;
      if (a.status !== 'unknown' && !a.turnId && !a.startingTurn && !a.spawning && !a.resuming && ACTIVE.has(a.status)) this.finish(a, 'interrupted', { reason: 'interrupt' });
      const turns = [];
      if (a.turnId) turns.push([a.threadId, a.turnId]);
      for (const [id, root] of this.descendants) if (root === a && this.descendantTurns.has(id)) turns.push([id, this.descendantTurns.get(id)]);
      const results = await Promise.allSettled(turns.map(([id, turn]) => this.requestTreeInterrupt(a, id, turn)));
      const failure = results.find((r, i) => r.status === 'rejected' && this.isCurrentTreeTurn(a, ...turns[i]));
      if (failure) a.stopError = failure.reason.message;
      this.updateStopStatus(a);
      await this.persist();
      return this.stopResult(a);
    };
    a.stopPromise = stop();
    try { return await a.stopPromise; } finally { a.stopPromise = null; this.updateStopStatus(a); }
  }

  stopResult(a) {
    return { agent_id: a.id, status: a.userPaused ? a.userControlStatus : (this.treeBusy(a) ? 'interrupting' : 'not_running'), ...(a.stopError ? { error: a.stopError } : {}) };
  }

  async requestTreeInterrupt(a, threadId, turnId) {
    if (a.userPaused && a.pauseDurable) await a.pauseDurable;
    if (!a.interrupted || !this.isCurrentTreeTurn(a, threadId, turnId)) return;
    a.interruptSent ??= new Map();
    if (a.interruptSent.get(threadId) === turnId) return;
    a.interruptSent.set(threadId, turnId);
    try { await this.rpc('turn/interrupt', { threadId, turnId }, a.userPaused ? USER_PAUSE_CONFIRMATION_MS : undefined); }
    catch (error) { if (a.interruptSent.get(threadId) === turnId) a.interruptSent.delete(threadId); throw error; }
  }

  isCurrentTreeTurn(a, threadId, turnId) {
    return (threadId === a.threadId ? a.turnId : this.descendantTurns.get(threadId)) === turnId;
  }

  interruptUnconfirmed(a, turnId, error) {
    if (this.closed || this.closing || a.turnId !== turnId) return;
    if (a.status === 'interrupted') a.status = 'unknown';
    a.activity = 'interrupt not confirmed';
    a.stopError = error.message;
    this.updateStopStatus(a);
    a.error = { code: 'interrupt_unconfirmed', message: error.message, turn_id: a.turnId };
    if (!a.userPaused) this.publish(a, 'message', { code: 'interrupt_unconfirmed', message: 'Interruption was not confirmed. This agent may still be running; retry interrupt_agent for this agent.' });
  }

  threadId(params = {}) { return params.threadId ?? params.thread?.id; }
  linkDescendants() {
    let changed, linked = false;
    do {
      changed = false;
      for (const [id, parentId] of this.unlinkedThreads) {
        const root = this.threads.get(parentId) ?? this.descendants.get(parentId);
        if (!root || id === root.threadId) continue;
        this.descendants.set(id, root); this.unlinkedThreads.delete(id); changed = true; linked = true;
        if (root.userPaused) { this.pausedThreads.add(id); root.pauseDurable = this.persist(); root.pauseDurable.catch(() => {}); }
        const turnId = this.unlinkedTurns.get(id);
        if (turnId) { this.unlinkedTurns.delete(id); this.observeDescendant(root, { method: 'turn/started' }, { threadId: id, turn: { id: turnId } }); }
      }
    } while (changed);
    if (linked) this.persist().catch(() => {});
  }

  observeDescendant(a, message, p) {
    if (!['turn/started', 'turn/completed', 'serverRequest/resolved'].includes(message.method)) return;
    if (message.method !== 'serverRequest/resolved') a.lastActivityAtMs = now();
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
    if (message.method === 'turn/started' && a.interrupted) {
      this.requestTreeInterrupt(a, sourceId, p.turn.id).catch((error) => {
        if (this.isCurrentTreeTurn(a, sourceId, p.turn.id)) { a.stopError = error.message; this.updateStopStatus(a); }
      });
    }
    this.updateStopStatus(a);
    this.persist().then(() => this.emit('state')).catch(() => {});
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
      if (sourceId && message.method === 'turn/started' && p.turn?.id) {
        this.unlinkedTurns.set(sourceId, p.turn.id);
        if (this.unlinkedTurns.size > 1000) this.unlinkedTurns.delete(this.unlinkedTurns.keys().next().value);
        this.persist().catch(() => {});
      } else if (sourceId && message.method === 'turn/completed' && this.unlinkedTurns.get(sourceId) === p.turn?.id) {
        this.unlinkedTurns.delete(sourceId); this.persist().catch(() => {});
      }
      if (this.starting && this.important(message)) this.early.push({ message: copy(message) });
      return;
    }
    if (a.startingTurn && ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'error', 'serverRequest/resolved'].includes(message.method)) {
      const buffered = copy(message);
      if (buffered.params.item && buffered.params.item.type !== 'agentMessage') buffered.params.item = { id: p.item.id, type: p.item.type };
      a.startEvents.push({ message: buffered });
      return;
    }
    if (a.status === 'unknown' && a.replacementAttempt && ['turn/started', 'turn/completed'].includes(message.method)) {
      this.reconcileUnknown(a).catch(() => {});
      return;
    }
    // A restarted subscription can replay another native turn on this thread.
    // Its messages and terminal notification do not belong to the saved job.
    const sourceTurnId = p.turnId ?? p.turn?.id;
    if (a.reconcileTurnId && sourceTurnId && a.reconcileTurnId !== sourceTurnId) return;
    if (a.awaitingTurnId && sourceTurnId && sourceTurnId === a.lastTurnId) return;
    switch (message.method) {
      case 'turn/started':
        if (a.completedTurns.has(p.turn.id)) return;
        if (a.terminalEmitted && a.lastTurnId === p.turn.id && a.status !== 'unknown') return;
        if (a.settlingTurn) return;
        if (a.turnId && a.turnId !== p.turn.id) return;
        if (a.terminalEmitted && a.status !== 'unknown') {
          if (a.interrupted) {
            a.turnId = p.turn.id;
            this.requestTreeInterrupt(a, a.threadId, p.turn.id).catch((error) => this.interruptUnconfirmed(a, p.turn.id, error));
            this.updateStopStatus(a); this.persist().catch(() => {});
          }
          return;
        }
        a.turnId = p.turn.id;
        a.awaitingTurnId = false;
        a.lastTurnId = p.turn.id;
        if (a.status === 'unknown') { a.pauseReconcileTurnId = null; a.terminalEmitted = false; a.error = null; a.status = 'running'; }
        if (!a.recovery && !a.terminalEmitted) { a.status = a.pending.length ? 'waiting' : 'running'; a.activity = a.pending.length ? 'waiting for parent' : 'working'; }
        if (a.interrupted) this.requestTreeInterrupt(a, a.threadId, p.turn.id).catch((error) => this.interruptUnconfirmed(a, p.turn.id, error));
        this.updateStopStatus(a);
        break;
      case 'thread/tokenUsage/updated': a.tokenUsage = copy(p.tokenUsage); break;
      case 'error':
        if (a.terminalEmitted || (p.turnId && (a.completedTurns.has(p.turnId) || a.turnId && a.turnId !== p.turnId))) return;
        if (isOverflow(p.error)) a.overflow = true;
        if (p.willRetry === false && p.turnId && providerModelUnavailable(p.error)) a.modelUnavailableTurnId = p.turnId;
        a.lastError = p.error ? { message: p.error.message, codexErrorInfo: p.error.codexErrorInfo } : null;
        break;
      case 'item/started': case 'item/completed': {
        if (a.terminalEmitted && !(a.status === 'unknown' && p.turnId && p.turnId === a.reconcileTurnId && p.item?.type === 'agentMessage')) return;
        const item = p.item ?? {};
        if (p.turnId && a.completedTurns.has(p.turnId)) return;
        if (a.turnId && p.turnId && a.turnId !== p.turnId) return;
        if (item.type === 'agentMessage' && message.method === 'item/completed' && p.turnId && p.turnId === (a.turnId ?? a.reconcileTurnId)) {
          bindAnswer(a, p.turnId);
          if (['final_answer', 'finalAnswer'].includes(item.phase)) a.result = item.text;
          else if (item.phase == null) a.unclassifiedResult = item.text;
        }
        if (item.type === 'contextCompaction') {
          if (!a.compactItems.has(item.id)) {
            a.compactItems.add(item.id);
            this.publish(a, 'compacting', { item_id: item.id, ...(a.overflow || a.recovery ? { reason: 'contextWindowExceeded' } : {}) });
          }
          if (a.recovery && message.method === 'item/completed') a.recovery.compacted = true;
          a.activity = message.method === 'item/started' ? 'compacting context' : a.pending.length ? 'waiting for parent' : 'working';
        } else if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') a.activity = 'delegated to subagent';
        else if (item.type !== 'agentMessage' && item.type !== 'reasoning' && item.type !== 'userMessage') a.activity = item.type ?? 'working';
        break;
      }
      case 'thread/compacted':
        if (a.recovery) a.recovery.compacted = true;
        if (a.activity === 'compacting context') a.activity = a.pending.length ? 'waiting for parent' : 'working';
        break;
      case 'serverRequest/resolved':
        a.pending = a.pending.filter((r) => r.wireId !== p.requestId);
        this.pruneRequestEvents(a);
        if (!a.pending.length && a.status === 'waiting') {
          a.status = 'running';
          a.activity = 'working';
        }
        break;
      case 'turn/completed':
        if (!p.turn?.id || a.completedTurns.has(p.turn.id) || a.turnId && a.turnId !== p.turn.id) return;
        if (a.reconcileTurnId === p.turn.id && !a.userPaused) {
          if (a.settlingTurn) return;
          if (p.turn.status === 'completed' && !a.interrupted && !a.liveAnswerOnly && (a.result == null || a.answerTurnId !== p.turn.id) && answerFromItems(p.turn.items).final === undefined) {
            this.settleRecoveredTurn(a, p.turn).catch(error => {
              a.error = { reconciliation_error: error.message };
              this.scheduleTurnReconciliation(a);
              this.persist().then(() => this.emit('state')).catch(() => {});
            });
            break;
          }
          a.terminalEmitted = false; a.error = null;
        }
        if (a.terminalEmitted && a.turnId !== p.turn.id) {
          if (!a.userPaused || a.status !== 'unknown' || a.pauseReconcileTurnId !== p.turn.id) return;
          a.pauseReconcileTurnId = null; a.terminalEmitted = false; a.error = null;
        }
        this.turnCompleted(a, p.turn); break;
      default: return;
    }
    if (['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/compacted', 'error'].includes(message.method)) a.lastActivityAtMs = now();
    this.persist().catch(() => {});
  }

  important(message) {
    return ['thread/started', 'turn/started', 'turn/completed', 'error', 'thread/tokenUsage/updated', 'thread/compacted', 'serverRequest/resolved'].includes(message.method)
      || (['item/started', 'item/completed'].includes(message.method) && ['agentMessage', 'contextCompaction'].includes(message.params?.item?.type));
  }

  turnCompleted(a, turn) {
    if (!turn?.id || a.completedTurns.has(turn.id)) return;
    if (a.terminalEmitted) {
      if (a.turnId === turn.id) { a.completedTurns.add(turn.id); a.turnId = null; a.lastTurnId = turn.id; this.updateStopStatus(a); this.persist().then(() => this.emit('state')).catch(() => {}); }
      return;
    }
    if (a.turnId && a.turnId !== turn.id) return;
    a.completedTurns.add(turn.id); a.lastTurnId = turn.id; a.turnId = null;
    a.awaitingTurnId = false;
    a.reconcileTurnId = null;
    clearTimeout(a.reconcileTimer); a.reconcileTimer = null; a.reconcileDelay = null;
    a.pending = a.pending.filter((request) => request.params.threadId !== a.threadId || request.params.turnId !== turn.id);
    this.pruneRequestEvents(a);
    if (this.closing || a.interrupted || turn.status === 'interrupted') { a.recovery = null; this.finish(a, 'interrupted', {}); return; }
    const action = a.startAction?.turnId === turn.id ? a.startAction.action : undefined;
    if (turn.status === 'failed' && nonempty(a.model) && (providerModelUnavailable(turn.error) || !turn.error?.codexErrorInfo && a.modelUnavailableTurnId === turn.id)) {
      this.recordRejectedTurnModel(a, turn.id);
      const chatgptLoginUnsupported = unsupportedChatGPTLogin(turn.error) || a.modelUnavailableTurnId === turn.id && unsupportedChatGPTLogin(a.lastError);
      this.finish(a, 'failed', modelRecoveryDetails(a, null, true, { turnId: turn.id, duringCompaction: !!a.recovery, chatgptLoginUnsupported }), action);
      return;
    }
    if (a.recovery) {
      if (turn.status !== 'completed' || !a.recovery.compacted) {
        a.recovery = null;
        this.finish(a, 'failed', { message: turn.error?.message ?? 'Context compaction did not complete.' });
      } else {
        a.recovery = null;
        this.continueAfterCompaction(a).catch(() => {});
      }
      return;
    }
    if (turn.status === 'failed' && (a.overflow || isOverflow(turn.error)) && !a.recoveryUsed) {
      a.recoveryUsed = true; a.overflow = true; a.recovery = { compacted: false }; a.status = 'compacting';
      a.activity = 'compacting context';
      this.startCompaction(a).catch(() => {});
      return;
    }
    if (turn.status === 'completed') {
      bindAnswer(a, turn.id);
      const answer = a.liveAnswerOnly ? {} : answerFromItems(turn.items);
      a.result = answer.final ?? a.result ?? answer.legacy ?? a.unclassifiedResult ?? '';
      this.finish(a, 'completed', { result: a.result });
    }
    else this.finish(a, 'failed', { message: turn.error?.message ?? a.lastError?.message ?? 'Codex turn failed.', codexErrorInfo: turn.error?.codexErrorInfo ?? a.lastError?.codexErrorInfo }, action);
  }

  async startCompaction(a) {
    try {
      if (nonempty(a.model)) await this.prepareTurnModel(a, undefined, { duringCompaction: true });
      if (a.recovery && !a.interrupted && !this.closing) await this.rpc('thread/compact/start', { threadId: a.threadId });
    } catch (error) {
      if (!a.recovery || a.interrupted || this.closing) return;
      if (nonempty(a.model) && providerModelUnavailable(error)) {
        a.modelRecovery = pendingModelRecovery(a.model, 'provider_model_unavailable');
        this.finish(a, 'failed', modelRecoveryDetails(a, null, false, { duringCompaction: true, chatgptLoginUnsupported: unsupportedChatGPTLogin(error) }));
      } else this.finishCompactionError(a, error);
    }
  }

  async continueAfterCompaction(a) {
    try {
      const plan = nonempty(a.model) ? await this.prepareTurnModel(a, undefined, { duringCompaction: true }) : { effort: a.effort };
      if (!a.interrupted && !this.closing && a.status === 'compacting') await this.startTurn(a, CONTINUE, { plan });
    } catch (error) {
      if (a.status === 'compacting' && !a.interrupted && !this.closing) this.finishCompactionError(a, error);
    }
  }

  finishCompactionError(a, error) {
    const details = ['agent_model_unavailable', 'model_catalog_unavailable'].includes(error.code) ? { ...error, message: error.message } : { message: `Context compaction failed: ${error.message}` };
    this.finish(a, 'failed', details);
  }

  markActionFailureReported(action, details, outcome) {
    if (details && action?.failureDetails === details) action.outcome = outcome;
  }

  finish(a, kind, details, action) {
    if (a.terminalEmitted) return;
    a.lastActivityAtMs = now();
    a.terminalEmitted = true;
    a.status = kind; a.activity = kind; a.turnId = null; a.recovery = null;
    if (kind !== 'completed') resetAnswer(a);
    if (kind === 'completed' && a.turnOrigin !== 'user') a.parentContinuationPending = false;
    // Descendants can outlive the root turn. Their wire IDs remain answerable
    // until their own turn ends, the server resolves them, or the controller closes.
    a.pending = a.pending.filter((request) => request.params.threadId !== a.threadId);
    this.pruneRequestEvents(a);
    if (kind === 'failed' || kind === 'unknown') a.error = details;
    const event = this.publish(a, kind, details);
    if (event && action) { action.failureDetails = details; action.trackFailure(event); }
    this.updateStopStatus(a);
  }

  pruneRequestEvents(a) {
    this.pendingEvents = this.pendingEvents.filter((event) => event.agent_id !== a.id || !['question', 'approval'].includes(event.kind)
      || (!a.userPaused && a.pending.some((request) => request.id === event.request_id && request.params.threadId === (event.source_thread_id ?? a.threadId))));
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
    if (message.method === 'item/tool/call') {
      if (!activeTurnId || activeTurnId !== p.turnId) { await this.client.reject(message.id, -32602, 'Dynamic tool call has no confirmed active turn.'); return; }
      if (isParentNotificationCall(p)) {
        const limitation = parentNotificationLimitation(parentNotificationCapability(a));
        const problem = !direct ? 'Send your update to your Codex parent agent, which can coordinate with Claude.' :
          a.userPaused ? 'The agent is paused. Resume it with a direct user message before notifying Claude.' :
          activeTurnId && a.parentReportTurnId === activeTurnId ? 'The user selected your final reply to share with Claude. Put the report in that reply.' :
          limitation ?? (!nonempty(p.arguments?.message) ? 'A nonempty message is required.' : undefined);
        if (problem) {
          await this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: problem }], success: false });
          return;
        }
        a.lastActivityAtMs = now();
        this.publish(a, 'message', { message: p.arguments.message });
        await this.persist();
        await this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: 'Queued for delivery to Claude.' }], success: true });
        return;
      }
      if (a.externalThread || a.externalAdopted) {
        const name = nonempty(p.tool) ? p.tool : '(unknown)';
        const tool = nonempty(p.namespace) ? `${p.namespace}.${name}` : name;
        if (direct && a.turnOrigin !== 'user') {
          a.unavailableTools ??= [];
          if (!a.unavailableTools.includes(tool)) {
            a.unavailableTools.push(tool);
            this.publish(a, 'message', { code: 'client_tools_unavailable', message: `Original client dynamic tool ${tool} is unavailable here. Continue the thread in its original Codex client if needed.` });
          }
        }
        await this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: 'This dynamic tool belongs to the original client and is unavailable here. Continue this thread in its original Codex client if the tool is needed.' }], success: false });
        return;
      }
    }
    const kind = message.method === 'item/tool/requestUserInput' ? 'question' : APPROVALS.has(message.method) ? 'approval' : null;
    if (!kind) { await this.client.reject(message.id, -32601, 'Unsupported server request.'); return; }
    if (a.userPaused) { await this.client.reject(message.id, -32000, 'Agent is paused by the user.'); return; }
    const id = String(message.id);
    const existing = [...this.agents.values()].flatMap((agent) => agent.pending).find((r) => r.id === id);
    if (existing) {
      if (existing.wireId !== message.id || existing.params.threadId !== sourceId) await this.client.reject(message.id, -32600, 'Request id collides after string normalization.');
      return;
    }
    if (direct && !a.turnId && p.turnId) a.turnId = p.turnId;
    a.pending.push({ id, wireId: message.id, method: message.method, params: copy(p) });
    a.lastActivityAtMs = now();
    if (ACTIVE.has(a.status)) a.status = 'waiting';
    a.activity = `${direct ? '' : 'subagent '}waiting for parent ${kind}`;
    this.publish(a, kind, { method: message.method, ...copy(p), request_id: id,
      reply_format: replyFormat(message.method, p), ...(direct ? {} : { source_thread_id: sourceId }) });
  }

  async answer(a, id, answer) {
    if (a.userPaused || a.userResumeToken) throw new Error('Agent is paused by the user; pending requests cannot be answered until the user resumes it.');
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
    a.lastActivityAtMs = now();
    this.pruneRequestEvents(a);
    if (!a.pending.length) {
      if (a.status === 'waiting') a.status = 'running';
      a.activity = ACTIVE.has(a.status) ? 'working' : a.status;
    }
    await this.persist();
    return { agent_id: a.id, request_id: pending.id, answered: true };
  }

  async models() {
    const catalog = await this.visibleModels();
    return { models: [...catalog].map(([id, model]) => ({ id, name: model.displayName, description: model.description, default: model.isDefault,
          efforts: (model.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort), default_effort: model.defaultReasoningEffort,
          ...(this.guidance.models?.[id]?.selection_note ? { selection_note: this.guidance.models[id].selection_note } : {}) })) };
  }

  publish(a, kind, details) {
    if (isUserSend({ kind, ...details })) return;
    const turnId = details.model_turn_started === false ? null : details.turnId ?? a.turnId ?? a.reconcileTurnId ?? (a.awaitingTurnId ? null : a.lastTurnId ?? null);
    const shareFinal = kind === 'completed' && turnId && a.parentReportTurnId === turnId && nonempty(details.result);
    if (isCompactionStatus({ kind }) || AUTOMATIC_TURN_EVENTS.has(kind) && a.turnOrigin === 'user' && !shareFinal
      || a.userPaused && ['interrupted', 'unknown'].includes(kind)) { this.persist().then(() => this.emit('state')).catch(() => {}); return; }
    return this.enqueueParentEvent({ agent_id: a.id, name: a.name ?? null, turn_id: turnId, kind, ...details });
  }

  enqueueParentEvent(details) {
    const event = { seq: this.nextSeq++, ...details };
    this.pendingEvents.push(event);
    // Keep every important event until a future explicit retention policy exists.
    // No tool output, thinking, or input prompt enters this durable journal.
    this.persist().then(() => {
      if (this.keepsParentEvent(event) && this.pendingEvents.some((pending) => pending.seq === event.seq)) this.emit('event', copy(event));
    }).catch(() => {});
    return event;
  }

  persist() {
    if (!this.statePath) return Promise.resolve();
    if (this.persistScheduled) return this.persistScheduled;
    // Snapshot once per microtask batch, then serialize disk writes. All callers
    // await the batch containing their mutation; failed writes still reject them.
    const write = this.persistTail.then(() => {
      this.persistScheduled = null;
      const pauseOperations = [...this.pauseOperations.values()].map(({ timer, ...operation }) => operation);
      const data = { version: 1, nextSeq: this.nextSeq, retiredThreads: [...this.retiredThreads], pausedThreads: [...this.pausedThreads], pauseOperations, unlinkedThreads: [...this.unlinkedThreads], unlinkedTurns: [...this.unlinkedTurns], descendants: [...this.descendants].map(([id, root]) => [id, root.id]), descendantTurns: [...this.descendantTurns], pendingEvents: copy(this.pendingEvents), agents: [...this.agents.values()].map((a) => ({
      id: a.id, threadId: a.threadId, name: a.name, threadName: a.threadName, cwd: a.cwd, model: a.model, modelProvider: a.modelProvider, modelRecovery: a.modelRecovery, replacementAttempt: a.replacementAttempt, lastModelRecovery: a.lastModelRecovery, effort: a.effort, effortPinned: a.effortPinned, role: a.role, status: a.status,
      activity: a.activity, createdAtMs: a.createdAtMs, lastActivityAtMs: a.lastActivityAtMs, turnId: a.turnId, lastTurnId: a.lastTurnId, turnOrigin: a.turnOrigin, pendingUserSteer: a.pendingUserSteer, result: a.result, error: a.error, tokenUsage: a.tokenUsage, pauseReconcileTurnId: a.pauseReconcileTurnId,
      parentContinuationPending: a.parentContinuationPending, reconcileTurnId: a.reconcileTurnId, awaitingTurnId: a.awaitingTurnId, answerTurnId: a.answerTurnId, liveAnswerOnly: a.liveAnswerOnly, unclassifiedResult: a.unclassifiedResult, recovery: a.recovery,
      adoptedParentNotification: a.adoptedParentNotification, parentReportTurnId: a.parentReportTurnId,
      snapshot: a.snapshot, injected: a.injected, contextSource: a.contextSource, recoveryUsed: a.recoveryUsed, externalAdopted: a.externalAdopted, externalConflict: a.externalConflict, externalThread: a.externalThread, unavailableTools: a.unavailableTools, userPaused: a.userPaused, userControlStatus: a.userControlStatus, userPauseId: a.userPauseId,
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
      if (!this.markPauseConnectionLost(a) && ACTIVE.has(a.status)) {
        this.markTransportLost(a, 'connection_closed');
      }
    }
  }

  markTransportLost(a, reason) {
    // Even an accepted interrupt RPC can race a successful native completion.
    a.reconcileTurnId = a.turnId ?? a.reconcileTurnId;
    if (a.turnOrigin !== 'user') a.parentContinuationPending = true;
    a.turnId = null; a.status = 'unknown'; a.activity = 'connection closed'; a.terminalEmitted = true;
    this.publish(a, 'unknown', a.replacementAttempt ? this.unknownReplacementDetails(a) : { reason });
  }

  markPauseConnectionLost(a) {
    if (!a.userPaused || !this.treeBusy(a)) return false;
    if (ACTIVE.has(a.status)) { a.status = 'unknown'; a.activity = 'connection closed; interruption unconfirmed'; }
    a.stopError = 'App-server connection closed before interruption was confirmed.';
    this.updateStopStatus(a);
    return true;
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
          if (a.turnOrigin !== 'user' && !a.userPaused) a.parentContinuationPending = true;
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
        if (!this.markPauseConnectionLost(a) && ACTIVE.has(a.status)) {
          this.markTransportLost(a, 'controller_closed');
        }
      }
    }
    this.client.off('notification', this.onNotification);
    this.client.off('request', this.onRequest);
    this.client.off('closed', this.onClosed);
    for (const a of this.agents.values()) clearTimeout(a.reconcileTimer);
    for (const threadId of this.descendantTurns.keys()) if (!this.descendants.get(threadId)?.userPaused) this.descendantTurns.delete(threadId);
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
