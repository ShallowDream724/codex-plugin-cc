const terminal = new Set(['completed', 'failed', 'interrupted']);
export const finishedTurn = turn => terminal.has(turn?.status);
export const inputItem = type => ['userMessage', 'directUserMessage', 'parentMessage'].includes(type);

// Older unphased assistant messages can contain the answer. Keep them visible
// without relabelling them or adding final-answer actions.
export function processItem(type, phase, isSteer = false) {
  if (inputItem(type)) return isSteer;
  return type !== 'agentMessage' || phase === 'commentary' || phase === 'partial_answer';
}
