// One coalesced request per visible buffer boundary. No timer or wheel handler.
export default function fileStreamControl(props, surface) {
  if (props.token && surface.state?.token !== props.token) {
    surface.setState({ token: props.token });
    surface.post({ action: 'file-load', token: props.token });
  }
  return surface.elements.Box({ width: 1, height: 0, children: [] });
}
