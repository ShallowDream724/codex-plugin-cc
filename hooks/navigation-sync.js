// A surface message starts a registered host dispatch after the tree is drawn.
// No polling, DOM access or scroll handling runs on the surface.
export default function navigationSync(props, surface) {
  const token = Number.isSafeInteger(props?.token) ? props.token : 0;
  const tail = Number.isSafeInteger(props?.tailToken) ? props.tailToken : 0;
  if (token > 0 && token !== surface.state?.navigation) {
    surface.setState({ ...surface.state, navigation: token });
    surface.post({ action: 'navigate', token });
  } else if (tail > 0 && tail !== surface.state?.tail) {
    surface.setState({ ...surface.state, tail });
    surface.post({ action: 'tail', token: tail });
  }
  return surface.elements.Box({ width: 1, height: 1, children: [] });
}
