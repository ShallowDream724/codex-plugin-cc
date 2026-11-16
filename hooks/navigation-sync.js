// A surface message starts a registered host dispatch after the tree is drawn.
// No polling, DOM access or scroll handling runs on the surface.
export default function navigationSync(props, surface) {
  const token = Number.isSafeInteger(props?.token) ? props.token : 0;
  if (token > 0 && token !== surface.state) {
    surface.setState(token);
    surface.post({ action: 'navigate', token });
  }
  return surface.elements.Box({ width: 1, height: 1, children: [] });
}
