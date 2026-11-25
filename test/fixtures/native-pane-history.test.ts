import { expect, mock, test } from 'claude-code/testing';

const paneKey = 'codex_subagent_activity';

for (const count of [0, 1, 120]) {
  test(`desktop opens a completed agent with ${count} saved messages`, async ($, on) => {
    mock.env(on, {});
    mock.clock(on);
    on('session.id', () => ({ value: 'offline-pane-history' }));
    on('session.cwd', () => ({ value: 'C:/offline-pane-test' }));

    const agent = { agent_id: 'history-agent', name: 'History agent', status: 'completed' };
    const entries = Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      turn_id: `turn-${index}`,
      type: 'agentMessage',
      data: { text: `Saved message ${index + 1}\n\n${'paragraph section '.repeat(22).trimEnd()}` },
    }));
    on('process.run', (_$, event) => {
      const { operation } = JSON.parse(event.init.stdin);
      const response = operation === 'ui_list' ? { agents: [agent] } :
        operation === 'ui_history' ? { revision: 1, entries, next_cursor: count > 1 ? 'older' : null } :
        { revision: 1, entries: [], next_cursor: null };
      return { value: { exitCode: 0, stdout: JSON.stringify(response), stderr: '' } };
    });
    on('ui.open', { id: paneKey }, () => ({ value: { isPlaced: true } }));

    await $.command.run({ command: 'codex-agents' });
    const pane = await $.ui.mount({
      plugin: 'codex-subagents', surface: 'desktop', component: 'Pane', requestId: paneKey,
      props: { title: 'Codex', isFocused: true, bodyColumns: 80, placement: 'dock',
        scroll: { offset: 0, by: 0, bodyRows: 24, contentRows: 24, origin: { kind: 'person' } } },
      viewport: { columns: 80, rows: 26, isFullscreen: true },
    });
    try {
      const openKey = `directory_open_${agent.agent_id}`;
      expect(await pane.press({ key: openKey })).toEqual({ element: openKey });
      const composerKey = `codex_message_${agent.agent_id}_0`;
      const composer = await pane.findAll({ type: 'Input' });
      expect(composer.some(input => input.key === composerKey)).toBe(true);

      const markdown = await pane.findAll({ type: 'Markdown' });
      if (count) expect(markdown.some(node => node.props.text.includes(`Saved message ${count}\n`))).toBe(true);
      else expect(markdown).toHaveLength(0);

      const clients = await pane.findAll({ type: 'Client' });
      const sensors = clients.filter(node => node.key?.startsWith(`codex_band_part_${agent.agent_id}_`));
      if (count > 1) expect(sensors.length).toBeGreaterThan(1);
      else expect(sensors).toHaveLength(0);
    } finally {
      await pane.unmount();
    }
  });
}
