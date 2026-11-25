const terminal = new Set(['completed', 'failed', 'interrupted']);
export const finishedTurn = turn => terminal.has(turn?.status);
export const foldableTurn = turn => finishedTurn(turn) || turn?.superseded === true;
export const inputItem = type => ['userMessage', 'directUserMessage', 'parentMessage'].includes(type);
const phases = new Map([
  ['commentary', 'commentary'], ['partial_answer', 'partial_answer'], ['final_answer', 'final_answer'],
  ['partialAnswer', 'partial_answer'], ['finalAnswer', 'final_answer'],
]);
export const messagePhase = phase => phases.get(phase) ?? null;
// Codex can deliver asynchronous messages with a final-answer phase while
// the owning native turn is still running.
export const finalAnswer = item => item?.type === 'agentMessage' && messagePhase(item.phase) === 'final_answer'
  && item.delivery !== 'async' && typeof item.text === 'string' && item.text.trim().length > 0;

export function mergeTurnMetadata(previous, incoming, preferPrevious) {
  const next = preferPrevious ? { ...incoming, ...previous } : { ...previous, ...incoming };
  if (finishedTurn(incoming)) next.status = incoming.status;
  else if (finishedTurn(previous)) next.status = previous.status;
  if (previous?.history_start_loaded || incoming.history_start_loaded) next.history_start_loaded = true;
  if (previous?.superseded || incoming.superseded) next.superseded = true;
  return next;
}

// Preserve unphased previews until the timeline can distinguish a sole
// legacy reply from the rest of a complete turn.
export function processItem(type, phase, isSteer = false) {
  if (inputItem(type)) return isSteer;
  return type !== 'agentMessage' || phase === 'commentary' || phase === 'partial_answer';
}
