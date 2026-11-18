import { createHmac, randomUUID } from 'node:crypto';

const PROVIDER_UNAVAILABLE = 'provider_model_unavailable';
const MODEL_NOT_LISTED = 'model_not_listed';
export const MODEL_RECOVERY_TARGET_PREFIX = 'codex-recovery:';

export function providerModelUnavailable(error) {
  return error?.reason === PROVIDER_UNAVAILABLE || error?.codexErrorInfo === 'modelNotFound';
}

export function pendingModelRecovery(model, reason) {
  return { model, reason: reason === PROVIDER_UNAVAILABLE ? PROVIDER_UNAVAILABLE : MODEL_NOT_LISTED, ticket: randomUUID() };
}

function recoveryTarget(ticket, model) {
  const signature = createHmac('sha256', ticket).update(model).digest('base64url');
  return `${MODEL_RECOVERY_TARGET_PREFIX}${signature}/${encodeURIComponent(model)}`;
}

export function selectModelRecovery(agents, target) {
  const encoded = target.slice(MODEL_RECOVERY_TARGET_PREFIX.length);
  const match = /^[0-9A-Za-z_-]{43}\/([^/]+)$/.exec(encoded);
  if (!match) return;
  let model;
  try { model = decodeURIComponent(match[1]); } catch { return; }
  for (const agent of agents) {
    const ticket = agent.modelRecovery?.ticket;
    if (ticket && recoveryTarget(ticket, model) === target) return { agent, model, ticket };
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
  let best;
  for (const id of ids) {
    const candidate = versionedModel(id);
    if (candidate?.prefix === old.prefix && candidate.suffix === old.suffix && (!best || compareVersions(candidate.version, best.version) > 0)) {
      best = { id, version: candidate.version };
    }
  }
  return best?.id;
}

export function modelRecoveryDetails(agent, catalog, modelTurnStarted, { invalidReplacement, rejectedReplacement, duringCompaction } = {}) {
  const { model, reason, ticket } = agent.modelRecovery;
  const available_models = [...(catalog?.keys() ?? [])].filter(id => id !== model && id !== rejectedReplacement);
  const recommended_model = recommendedModel(model, available_models);
  const recovery_choices = available_models.map(id => ({ model: id, target: recoveryTarget(ticket, id) }));
  let recovery;
  if (!catalog) {
    recovery = `If list_agents shows model_recovery for agent ${agent.id} and its status is failed, interrupted, or completed, call followup_task with that agent ID and your intended message to check the current replacement choices.`;
  } else if (available_models.length) {
    recovery = 'To continue on the same thread, call followup_task with target set to the recovery target for your chosen model in recovery_choices and message set to your original followup message.';
  } else {
    recovery = `No eligible replacement is visible. Once the model catalog changes, check list_agents. If agent ${agent.id} still shows model_recovery and its status is failed, interrupted, or completed, retry followup_task with that agent ID and the same message.`;
  }
  let explanation;
  if (invalidReplacement === model) explanation = `The requested replacement ${model} is the same as the unavailable model. No turn was started.`;
  else if (invalidReplacement !== undefined) explanation = `The requested replacement ${invalidReplacement} is absent from the visible Codex model catalog. No turn was started.`;
  else if (rejectedReplacement) explanation = `Codex rejected replacement model ${rejectedReplacement} as unavailable for this thread. No turn was started.`;
  else if (duringCompaction) {
    explanation = reason === PROVIDER_UNAVAILABLE
      ? `Context recovery stopped because Codex rejected model ${model} as unavailable.`
      : `Context recovery stopped because model ${model} is absent from the visible Codex model catalog.`;
  }
  else if (modelTurnStarted) explanation = `The turn failed because Codex rejected model ${model} as unavailable.`;
  else if (reason === PROVIDER_UNAVAILABLE) explanation = `Codex rejected model ${model} as unavailable for this thread. No turn was started.`;
  else explanation = `Model ${model} is absent from the visible Codex model catalog. No turn was started.`;
  const message = `${explanation} ${recovery}`;
  return { code: 'agent_model_unavailable', message, reason, agent_id: agent.id, thread_id: agent.threadId, model, available_models,
    ...(recommended_model ? { recommended_model } : {}), ...(recovery_choices.length ? { recovery_choices } : {}), model_turn_started: modelTurnStarted };
}

export function modelRecoveryError(agent, catalog, modelTurnStarted, context) {
  const details = modelRecoveryDetails(agent, catalog, modelTurnStarted, context);
  return Object.assign(new Error(details.message), details);
}

export function replacementEffort(model, currentEffort) {
  if (currentEffort && model.supportedReasoningEfforts?.some(option => option.reasoningEffort === currentEffort)) return currentEffort;
  return model.defaultReasoningEffort ?? currentEffort;
}
