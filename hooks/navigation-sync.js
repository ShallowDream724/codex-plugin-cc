// A surface message starts a registered host dispatch after the tree is drawn.
// No polling, DOM access or scroll handling runs on the surface.
export default function navigationSync(props, surface) {
  const token = Number.isSafeInteger(props?.token) ? props.token : 0;
  const attempt = Number.isSafeInteger(props?.attempt) ? props.attempt : 0;
  const tail = Number.isSafeInteger(props?.tailToken) ? props.tailToken : 0;
  const edge = typeof props?.edgeToken === 'string' ? props.edgeToken : '';
  const exposure = props?.exposure || '';
  if (exposure && exposure !== surface.state?.exposure) {
    surface.setState({ ...surface.state, exposure });
    surface.post({ action: 'expose-band', token: exposure });
  } else if (token > 0 && (token !== surface.state?.navigation || attempt !== (surface.state?.attempt || 0))) {
    surface.setState({ ...surface.state, navigation: token, attempt });
    surface.post({ action: 'navigate', token });
  } else if (tail > 0 && tail !== surface.state?.tail) {
    surface.setState({ ...surface.state, tail });
    surface.post({ action: 'tail', token: tail });
  } else if (edge && edge !== surface.state?.edge) {
    surface.setState({ ...surface.state, edge });
    surface.post({ action: 'edge', token: edge, direction: props.edgeDirection });
  } else if (!edge && surface.state?.edge) {
    surface.setState({ ...surface.state, edge: '' });
  }
  return surface.elements.Box({ width: 1, height: 1, children: [] });
}
