const terminal = new Set(['completed', 'failed', 'interrupted']);
export const finishedTurn = turn => terminal.has(turn?.status);

// Older unphased assistant messages can contain the answer. Keep them visible
// without relabelling them or adding final-answer actions.
export function processItem(type, phase) {
  if (['userMessage', 'directUserMessage', 'parentMessage'].includes(type)) return false;
  return type !== 'agentMessage' || phase === 'commentary' || phase === 'partial_answer';
}
