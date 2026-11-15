/** A small Client surface; the hooks module owns action routing and validation. */
export default function ActionControl(props, surface) {
  const { Box, Text } = surface.elements;
  const mode = props?.mode === 'stop' ? 'stop' : 'send';
  const disabled = props?.disabled === true;
  const label = typeof props?.label === 'string' ? props.label : '';
  const inside = (event) => {
    const x = event.fine?.x ?? event.x, y = event.fine?.y ?? event.y;
    return x >= 0 && y >= 0 && x < surface.columns && y < surface.rows;
  };
  const press = (pressed) => {
    if (Boolean(surface.state?.pressed) !== pressed || (pressed && surface.state?.mode !== mode)) {
      surface.setState({ pressed, mode });
    }
  };
  surface.onPointer((event) => {
    if (event.type === 'down' && event.button === 'left') {
      press(!disabled && inside(event));
    } else if (event.type === 'up' && event.button === 'left') {
      const activate = !disabled && surface.state?.pressed && surface.state.mode === mode && inside(event);
      press(false);
      if (activate) surface.post({ action: 'activate' });
    }
  });
  surface.onKey((event) => {
    if (!disabled && !event.ctrl && !event.meta && !event.shift && (event.key === 'return' || event.key === ' ')) {
      press(false);
      surface.post({ action: 'activate' });
    }
  });

  const pressed = !disabled && surface.state?.pressed && surface.state.mode === mode;
  return Box({
    key: 'action-control', position: 'relative', width: '100%', height: '100%',
    alignItems: 'center', justifyContent: 'center',
    children: [
      Text({ size: 'title', color: '#171717', dimColor: disabled || Boolean(pressed), children: '⬤' }),
      Box({
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        alignItems: 'center', justifyContent: 'center',
        children: Text({ size: 'caption', weight: 'semibold', color: '#ffffff', children: mode === 'stop' ? '■' : '↑' }),
      }),
      ...(label ? [Box({
        position: 'absolute', top: -1, right: 0, paddingX: 1,
        display: 'none', hover: { display: 'flex' }, backgroundColor: '#171717',
        children: Text({ size: 'caption', color: '#ffffff', wrap: 'truncate', children: label }),
      })] : []),
    ],
  });
}
