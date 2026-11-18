const PROVIDER_UNAVAILABLE = 'provider_model_unavailable';
const MODEL_NOT_LISTED = 'model_not_listed';

export function providerModelUnavailable(error) {
  return error?.reason === PROVIDER_UNAVAILABLE || error?.codexErrorInfo === 'modelNotFound';
}

export function pendingModelRecovery(model, reason) {
  return { model, reason: reason === PROVIDER_UNAVAILABLE ? PROVIDER_UNAVAILABLE : MODEL_NOT_LISTED };
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
      if (typeof id !== 'string' || !id.trim()) throw new Error('model/list returned a model without an ID.');
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

export function modelRecoveryDetails(agent, catalog, modelTurnStarted, rejectedReplacement) {
  const { model, reason } = agent.modelRecovery;
  const available_models = [...(catalog?.keys() ?? [])].filter(id => id !== model && id !== rejectedReplacement);
  const recommended_model = recommendedModel(model, available_models);
  const target = `agent ${agent.id} (native thread ${agent.threadId})`;
  let recovery;
  if (!catalog) {
    recovery = `When ready to continue, call followup_task on ${target} to check its current model choices.`;
  } else if (available_models.length) {
    recovery = `Retry followup_task on ${target} with replacement_model set to an ID from available_models.`;
  } else {
    recovery = `No eligible replacement is currently visible. Retry followup_task on ${target} after its model catalog changes.`;
  }
  const message = rejectedReplacement ? `Codex rejected replacement model ${rejectedReplacement}. ${recovery}` : `Model ${model} is unavailable for this Codex thread. ${recovery}`;
  return { code: 'agent_model_unavailable', message, reason, agent_id: agent.id, thread_id: agent.threadId, model, available_models,
    ...(recommended_model ? { recommended_model } : {}), model_turn_started: modelTurnStarted, recovery };
}

export function modelRecoveryError(agent, catalog, modelTurnStarted, rejectedReplacement) {
  const details = modelRecoveryDetails(agent, catalog, modelTurnStarted, rejectedReplacement);
  return Object.assign(new Error(details.message), details);
}

export function replacementEffort(model, currentEffort) {
  if (currentEffort && model.supportedReasoningEfforts?.some(option => option.reasoningEffort === currentEffort)) return currentEffort;
  return model.defaultReasoningEffort ?? currentEffort;
}
