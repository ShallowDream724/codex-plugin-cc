// The native Image is a non-interactive leaf; this transparent region handles
// pointer and keyboard activation without carrying file paths in messages.
export default function ImageControl(props, surface) {
  const { Box } = surface.elements;
  const inside = event => {
    const x = event.fine?.x ?? event.x, y = event.fine?.y ?? event.y;
    return x >= 0 && y >= 0 && x < surface.columns && y < surface.rows;
  };
  const point = event => ({ x: event.fine?.x ?? event.x, y: event.fine?.y ?? event.y });
  const moved = event => {
    const p = point(event), start = surface.state?.start;
    return !start || Math.hypot(p.x - start.x, p.y - start.y) > 1;
  };
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') surface.setState({ pressed: inside(event), start: point(event), cancelled: false });
    else if (event.type === 'move' && surface.state?.pressed && moved(event)) surface.setState({ ...surface.state, cancelled: true });
    else if (event.type === 'up') {
      const activate = event.button === 'left' && surface.state?.pressed && !surface.state.cancelled && inside(event) && !moved(event);
      surface.setState({ pressed: false });
      if (activate) surface.post({ action: 'preview' });
    }
  });
  surface.onKey(event => {
    if (!event.ctrl && !event.meta && !event.shift && (event.key === 'return' || event.key === ' ')) surface.post({ action: 'preview' });
  });
  return Box({ key: 'image-hit', width: '100%', height: props.rows, children: [] });
}
