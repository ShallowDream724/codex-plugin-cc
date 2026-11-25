import { isDeepStrictEqual } from 'node:util';

const previousDescription = 'Send a necessary coordination message to Claude without waiting for a reply.';
export const parentNotificationTool = {
  type: 'function',
  name: 'notify_parent',
  description: 'Send a requested report or a necessary coordination message to Claude without waiting for a reply. Share only content intended for Claude.',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
};

export function isParentNotificationCall({ namespace, tool }) {
  return namespace == null && tool === parentNotificationTool.name;
}

export function isParentNotificationSpec(tool) {
  return (tool.type === 'function' || tool.type === undefined) && tool.namespace == null
    && tool.name === parentNotificationTool.name
    && [parentNotificationTool.description, previousDescription].includes(tool.description)
    && isDeepStrictEqual(tool.inputSchema, parentNotificationTool.inputSchema);
}

export function parentNotificationCapability(agent) {
  if (agent.role === 'default') return { status: 'unavailable', reason: 'default_role' };
  if (!(agent.externalThread || agent.externalAdopted) || agent.adoptedParentNotification === true) return { status: 'available' };
  if (agent.adoptedParentNotification === false) return { status: 'unavailable', reason: 'native_tool_missing' };
  return { status: 'unknown', reason: 'metadata_unverified' };
}

export function parentReportPending(agent) {
  return agent.turnOrigin === 'user' && !agent.userPaused && !!agent.turnId && agent.parentReportTurnId === agent.turnId;
}

export function parentNotificationLimitation(capability) {
  if (capability.reason === 'default_role') return 'The read-only default role has no notify_parent tool. Use the sidebar option to share the final reply with Claude.';
  const hint = 'Use the sidebar option to share the final reply with Claude.';
  if (capability.reason === 'native_tool_missing') return `This Codex thread was created without the plugin’s notify_parent tool. Codex cannot add it when resuming a thread. ${hint}`;
  if (capability.reason === 'metadata_unverified') return `The plugin could not verify the notify_parent tool in this Codex thread’s original metadata. ${hint}`;
  return undefined;
}
