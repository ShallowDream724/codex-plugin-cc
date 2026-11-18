// The parent journal contains coordination, not display-only activity or private conversations.
export const AUTOMATIC_TURN_EVENTS = new Set(['completed', 'failed', 'interrupted', 'unknown', 'compacting']);
export const isCompactionStatus = event => ['compacting', 'compacted'].includes(event?.kind);
export const isUserSend = event => event?.origin === 'user' && event.action === 'send'
  && ['message', 'user_action_receipt'].includes(event.kind);
const turnKey = event => event.turn_id ? JSON.stringify([event.agent_id, event.turn_id]) : null;

const oldStopReceipt = event => event.kind === 'message' && event.origin === 'user' && event.action === 'interrupt';

export function agentPauseSummary(name, confirmed) {
  return confirmed ? `用户暂停了 Codex 代理 ${name} 及其所有子代理。` : `Codex 代理 ${name} 及其所有子代理的暂停状态尚未确认。可在代理列表查看状态。`;
}

// Old journals recorded several phases per agent and did not give bulk
// actions an identity. Only combine phases and interruptions we can attribute.
export function restoreParentEvents(events, agents = []) {
  if (!events.some(oldStopReceipt)) return parentDeliveryEvents(events);
  const last = new Map(), superseded = new Set(), stoppedTurns = new Set();
  for (const e of events) {
    if (!oldStopReceipt(e)) continue;
    const previous = last.get(e.agent_id);
    if (previous && e.phase !== 'requested') superseded.add(previous.seq);
    last.set(e.agent_id, e);
    if (turnKey(e)) stoppedTurns.add(turnKey(e));
  }
  const states = new Map(agents.map(a => [a.id, a]));
  const migrated = [];
  for (const e of events) {
    if (superseded.has(e.seq)) continue;
    if ((e.kind === 'interrupted' || e.code === 'interrupt_unconfirmed') && stoppedTurns.has(turnKey(e))) continue;
    if (!oldStopReceipt(e)) { migrated.push(e); continue; }
    const saved = states.get(e.agent_id);
    const confirmed = e.phase === 'confirmed' || (last.get(e.agent_id) === e && saved?.userPaused && saved.userControlStatus === 'stopped');
    migrated.push({ seq: e.seq, agent_id: e.agent_id, name: e.name ?? null, scope: 'agent',
      kind: 'user_action_receipt', action: 'interrupt', origin: 'user', phase: confirmed ? 'confirmed' : 'unconfirmed',
      summary: agentPauseSummary(e.name || e.agent_id, confirmed) });
  }
  return parentDeliveryEvents(migrated);
}

export function parentDeliveryEvents(events) {
  // Older versions journalled the send receipt after the final result. Match
  // exact agent/turn identities, not sequence order or an agent-wide cutoff.
  const privateTurns = new Set(events.filter(event => isUserSend(event) && event.phase === 'delivered').map(turnKey).filter(Boolean));
  return events.filter(event => !isCompactionStatus(event) && !isUserSend(event) && !(AUTOMATIC_TURN_EVENTS.has(event.kind)
    && (event.turn_origin === 'user' || privateTurns.has(turnKey(event)))));
}
