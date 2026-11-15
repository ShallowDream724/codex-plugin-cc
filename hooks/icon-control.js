/** Transparent pointer/keyboard region over a public native SVG. */
export default function IconControl(props, surface) {
  const { Box } = surface.elements;
  const expanded = props.expanded === true;
  const action = typeof props.action === 'string' ? props.action : 'toggle';
  const inside = event => {
    const x = event.fine?.x ?? event.x, y = event.fine?.y ?? event.y;
    return x >= 0 && y >= 0 && x < surface.columns && y < surface.rows;
  };
  surface.onPointer(event => {
    if (event.button !== 'left') return;
    if (event.type === 'down') surface.setState({ pressed: inside(event), expanded });
    else if (event.type === 'up') {
      const activate = surface.state?.pressed && surface.state.expanded === expanded && inside(event);
      if (surface.state?.pressed) surface.setState({ pressed: false, expanded });
      if (activate) surface.post({ action, expanded });
    }
  });
  surface.onKey(event => {
    if (!event.ctrl && !event.meta && !event.shift && (event.key === 'return' || event.key === ' ')) surface.post({ action, expanded });
  });
  return Box({ key: 'icon-hit', width: '100%', height: props.rows === 2 ? 2 : 1, children: [] });
}
