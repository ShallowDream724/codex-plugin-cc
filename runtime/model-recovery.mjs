import { createHmac, randomUUID } from 'node:crypto';

const PROVIDER_UNAVAILABLE = 'provider_model_unavailable';
const MODEL_NOT_LISTED = 'model_not_listed';
export const MODEL_RECOVERY_TARGET_PREFIX = 'codex-recovery:';

export function unsupportedChatGPTLogin(error) {
  return error?.accessHint === 'unsupported_chatgpt_login' || (typeof error?.message === 'string' &&
    /^The '[\w.:/-]+' model is not supported when using Codex with a ChatGPT account\.?$/i.test(error.message));
}

export function providerModelUnavailable(error) {
  return error?.reason === PROVIDER_UNAVAILABLE || error?.codexErrorInfo === 'modelNotFound' || unsupportedChatGPTLogin(error);
}

export function pendingModelRecovery(model, reason) {
  return { model, reason: reason === PROVIDER_UNAVAILABLE ? PROVIDER_UNAVAILABLE : MODEL_NOT_LISTED, ticket: randomUUID() };
}

function recoveryTarget(ticket, model, retryAfterFix = false) {
  const signature = createHmac('sha256', retryAfterFix ? `${ticket}/retry` : ticket).update(model).digest('base64url');
  return `${MODEL_RECOVERY_TARGET_PREFIX}${signature}/${retryAfterFix ? 'retry/' : ''}${encodeURIComponent(model)}`;
}

export function selectModelRecovery(agents, target) {
  const encoded = target.slice(MODEL_RECOVERY_TARGET_PREFIX.length);
  const match = /^[0-9A-Za-z_-]{43}\/(?:(retry)\/)?([^/]+)$/.exec(encoded);
  if (!match) return;
  const retryAfterFix = match[1] === 'retry';
  let model;
  try { model = decodeURIComponent(match[2]); } catch { return; }
  for (const agent of agents) {
    const ticket = agent.modelRecovery?.ticket;
    if (ticket && recoveryTarget(ticket, model, retryAfterFix) === target) return { agent, model, ticket, retryAfterFix };
    const accepted = agent.lastModelRecovery;
    if (accepted?.ticket && recoveryTarget(accepted.ticket, model, retryAfterFix) === target) return { agent, consumed: true };
  }
}

export async function readVisibleModels(rpc, modelProvider) {
  const models = new Map(), seen = new Set();
  let cursor;
  do {
    const page = await rpc('model/list', { includeHidden: false, ...(modelProvider ? { modelProvider } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data) || page.nextCursor != null && typeof page.nextCursor !== 'string') {
      throw new Error('model/list returned an invalid page.');
    }
    for (const model of page.data) {
      if (model?.hidden === true) continue;
      const id = model?.model || model?.id;
      if (typeof id !== 'string' || !id.trim() || !id.isWellFormed()) throw new Error('model/list returned an invalid model ID.');
      models.set(id, model);
    }
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('model/list returned a repeated cursor.');
    seen.add(cursor);
  } while (cursor);
  return models;
}

function versionedModel(id) {
  const match = /^([a-z][a-z0-9-]*?)(\d+(?:\.\d+)*)(-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(id);
  if (!match) return null;
  const [, prefix, version, suffix = ''] = match;
  return { prefix, suffix, version: version.split('.').map(Number) };
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function recommendedModel(oldId, ids) {
  const old = versionedModel(oldId);
  if (!old) return undefined;
  let bestVersion = old.version;
  let bestId;
  for (const id of ids) {
    const candidate = versionedModel(id);
    if (candidate?.prefix === old.prefix && candidate.suffix === old.suffix && compareVersions(candidate.version, bestVersion) > 0) {
      bestVersion = candidate.version;
      bestId = id;
    }
  }
  return bestId;
}

export function modelRecoveryOptions(agent, catalog) {
  if (!catalog) {
    return { message: `Could not verify the model catalog. Use list_agents to refresh recovery choices for agent ${agent.id}.` };
  }

  const { model, reason, ticket, rejectedModels = [] } = agent.modelRecovery;
  const available_models = [...catalog.keys()];
  if (reason === MODEL_NOT_LISTED && catalog.has(model)) {
    return { available_models, recovery_choices: [],
      message: `Model ${model} is visible again. Call followup_task with agent ID ${agent.id} as target and your original message.` };
  }

  const rejected = new Set(rejectedModels);
  if (reason === PROVIDER_UNAVAILABLE) rejected.add(model);
  const eligible = available_models.filter(id => id !== model && !rejected.has(id));
  const recommended_model = recommendedModel(model, eligible);
  const recovery_choices = eligible.map(id => ({ model: id, target: recoveryTarget(ticket, id) }));
  const retry_after_access_fix = available_models.filter(id => rejected.has(id)).map(id => ({ model: id, target: recoveryTarget(ticket, id, true) }));
  const guidance = [];
  if (eligible.length) {
    if (recommended_model) guidance.push(`${recommended_model} is a possible successor.`);
    guidance.push("Use the user's choice from recovery_choices, or ask them to choose.");
  } else {
    guidance.push(available_models.length ? 'No replacement is available.' : 'The visible model catalog is empty.');
    guidance.push('Use list_agents after the catalog changes.');
  }
  if (retry_after_access_fix.length) {
    guidance.push('To retry a rejected model, use retry_after_access_fix only after the user confirms restored access or a verified compatibility fix.');
  }
  if (eligible.length || retry_after_access_fix.length) {
    guidance.push('Call followup_task with the chosen target and the original message.');
  }
  return { available_models, recovery_choices, ...(recommended_model ? { recommended_model } : {}),
    ...(retry_after_access_fix.length ? { retry_after_access_fix } : {}), message: guidance.join(' ') };
}

export function modelRecoveryDetails(agent, catalog, modelTurnStarted, { invalidReplacement, rejectedReplacement, duringCompaction, turnId, chatgptLoginUnsupported } = {}) {
  const { model, reason, rejectedModels = [] } = agent.modelRecovery;
  const { message: recovery, ...options } = modelRecoveryOptions(agent, catalog);
  let explanation;
  const previouslyRejected = invalidReplacement !== undefined && rejectedModels.includes(invalidReplacement);
  if (invalidReplacement === model) explanation = `The requested replacement ${model} is the same as the unavailable model.`;
  else if (previouslyRejected) explanation = `Codex previously rejected replacement model ${invalidReplacement} as unavailable.`;
  else if (invalidReplacement !== undefined) explanation = `The requested replacement ${invalidReplacement} is absent from the visible Codex model catalog.`;
  else if (rejectedReplacement) explanation = `Codex rejected replacement model ${rejectedReplacement} as unavailable.`;
  else if (modelTurnStarted) {
    const turn = duringCompaction ? `Context recovery turn${turnId ? ` ${turnId}` : ''}` : turnId ? `Turn ${turnId}` : 'The turn';
    explanation = `${turn} failed because Codex rejected model ${model} as unavailable.`;
  } else if (duringCompaction) {
    explanation = reason === PROVIDER_UNAVAILABLE
      ? `Context recovery stopped because Codex rejected model ${model} as unavailable.`
      : `Context recovery stopped because model ${model} is absent from the visible Codex model catalog.`;
  } else if (reason === PROVIDER_UNAVAILABLE) explanation = `Codex rejected model ${model} as unavailable for this thread.`;
  else explanation = `Model ${model} is absent from the visible Codex model catalog.`;
  if (!modelTurnStarted) explanation += ' No turn was started.';
  const troubleshoot = chatgptLoginUnsupported
    ? " This model does not support ChatGPT account login. Check the CLI session's account type."
    : reason === PROVIDER_UNAVAILABLE || rejectedReplacement || previouslyRejected
    ? ` Verify that the thread's provider${agent.modelProvider ? ` (${agent.modelProvider})` : ''} offers this exact model ID to the configured account.`
    : '';
  const message = `${explanation}${troubleshoot} ${recovery}`;
  return { code: 'agent_model_unavailable', message, reason, agent_id: agent.id, thread_id: agent.threadId, model, ...options,
    ...(chatgptLoginUnsupported ? { access_hint: 'unsupported_chatgpt_login' } : {}),
    ...(modelTurnStarted && turnId ? { turn_id: turnId } : {}), ...(duringCompaction ? { during_compaction: true } : {}), model_turn_started: modelTurnStarted };
}

export function modelRecoveryError(agent, catalog, modelTurnStarted, context) {
  const details = modelRecoveryDetails(agent, catalog, modelTurnStarted, context);
  return Object.assign(new Error(details.message), details);
}

export function replacementEffort(model, currentEffort) {
  if (currentEffort && model.supportedReasoningEfforts?.some(option => option.reasoningEffort === currentEffort)) return currentEffort;
  return model.defaultReasoningEffort ?? currentEffort;
}
