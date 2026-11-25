// Desktop resizes a Client when its slotted holder changes size. A tall,
// shrinkable empty child makes that holder fill the measured prefix. It has
// no paint, hit targets, timer, or effect on the surrounding transcript flow.
export default function historySize(props, surface) {
  const rows = surface.rows;
  const prior = surface.state?.key === props.key ? surface.state : null;
  // The slot holder has automatic height, so a percentage child resolves
  // to its intrinsic one row. Start from the measured pane height and leave
  // headroom; expand the preferred height only if the prefix ever fills it.
  const extent = prior ? (rows >= prior.extent ? rows * 4 : prior.extent) : Math.max(32, props.contentRows * 2);
  if (!prior) {
    // Before this first child is laid out a new holder can be one row tall.
    surface.setState({ key: props.key, rows: 0, extent });
  } else if (rows > 0 && (prior.rows !== rows || prior.extent !== extent)) {
    surface.setState({ key: props.key, rows, extent });
    if (props.scale) surface.post({ action: 'history-band-part-size', key: props.key, part: props.part, rows: rows / props.scale });
    else surface.post({ action: props.band ? 'history-band-size' : 'history-size', key: props.key, rows });
  }
  return surface.elements.Box({ width: 1, height: extent, children: [] });
}
