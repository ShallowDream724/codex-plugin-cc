// Desktop resizes a Client when its slotted holder changes size. A tall,
// shrinkable empty child makes that holder fill the measured prefix. It has
// no paint, hit targets, timer, or effect on the surrounding transcript flow.
const maxBoxRows = 10_000;
const maxExtent = maxBoxRows * 32;

export default function historySize(props, surface) {
  const rows = surface.rows;
  const prior = surface.state?.key === props.key ? surface.state : null;
  // The slot holder has automatic height, so a percentage child resolves
  // to its intrinsic one row. Start from the measured pane height and leave
  // headroom; expand the preferred height only if the prefix ever fills it.
  const contentRows = Number.isFinite(props.contentRows) ? props.contentRows : 0;
  const extent = Math.min(maxExtent, prior ? Math.max(prior.extent, rows >= prior.extent ? rows * 4 : 0) : Math.max(32, contentRows * 2));
  if (!prior) {
    // Before this first child is laid out a new holder can be one row tall.
    surface.setState({ key: props.key, rows: 0, extent });
  } else if (rows > 0 && rows < prior.extent && prior.rows !== rows) {
    surface.setState({ key: props.key, rows, extent });
    if (props.scale) surface.post({ action: 'history-band-part-size', key: props.key, part: props.part, rows: rows / props.scale });
    else surface.post({ action: props.band ? 'history-band-size' : 'history-size', key: props.key, rows });
  } else if (prior.extent !== extent) {
    // A holder that fills the sensor may be taller. Wait for the larger
    // sensor to offer headroom before reporting a measurement.
    surface.setState({ key: props.key, rows: prior.rows, extent });
  }
  const { Box } = surface.elements;
  if (extent <= maxBoxRows) return Box({ width: 1, height: extent, children: [] });
  const children = [];
  for (let remaining = extent; remaining > 0; remaining -= maxBoxRows) {
    children.push(Box({ height: Math.min(remaining, maxBoxRows), flexShrink: 1, children: [] }));
  }
  return Box({ width: 1, flexDirection: 'column', flexShrink: 1, children });
}
