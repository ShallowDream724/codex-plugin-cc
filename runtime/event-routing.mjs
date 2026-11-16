// The parent journal contains coordination, not display-only activity or private conversations.
export const AUTOMATIC_TURN_EVENTS = new Set(['completed', 'failed', 'interrupted', 'unknown', 'compacting']);
export const isCompactionStatus = event => ['compacting', 'compacted'].includes(event?.kind);
export const isUserSend = event => event?.origin === 'user' && event.action === 'send'
  && ['message', 'user_action_receipt'].includes(event.kind);
const turnKey = event => event.turn_id ? JSON.stringify([event.agent_id, event.turn_id]) : null;

export function parentDeliveryEvents(events) {
  // Older versions journalled the send receipt after the final result. Match
  // exact agent/turn identities, not sequence order or an agent-wide cutoff.
  const privateTurns = new Set(events.filter(event => isUserSend(event) && event.phase === 'delivered').map(turnKey).filter(Boolean));
  return events.filter(event => !isCompactionStatus(event) && !isUserSend(event) && !(AUTOMATIC_TURN_EVENTS.has(event.kind)
    && (event.turn_origin === 'user' || privateTurns.has(turnKey(event)))));
}
