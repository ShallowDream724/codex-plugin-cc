export function nativeGraphicButton({ Box, Button }, { key, label, onPress, children, width, height = 1, gap, dimColor }) {
  // Desktop draws Button.label as text. The leading space fills the clipped
  // region while keeping the native control named and above the graphics.
  const labelIndent = '\u2003'.repeat(width ?? (label.length * 2 + 4));
  // Leave room for the full accessible label so its ellipsis stays out of view.
  return Box({ key: `${key}_graphic`, position: 'relative', width, height, flexShrink: 0, alignSelf: 'flex-start', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap, children: [
    ...children,
    Box({ position: 'absolute', left: 0, top: 0, bottom: 0, width: 128, children: [Button({ key, plain: true, label: labelIndent + label, dimColor, onPress })] }),
  ] });
}

// Desktop dispatches a physical press by native handle as well as by key.
// Reconstructing a Button between pointer-down and dispatch releases that
// handle, even when the new Button has the same key and callback.
function copyBinding(page, generation, Button, props) {
  const { key, label } = props;
  const binding = { generation, label, action: props.onPress };
  binding.node = Button({ ...props, onPress: event => {
    if (page.copyButtons?.get(key) === binding) return binding.action(event);
  } });
  return binding;
}

export function retainedCopyButtons(page, generation, Button, budget) {
  const previous = page.copyButtons;
  const visible = page.copyButtons = new Map();
  return props => budget.buttonWith(props, nativeProps => {
    let binding = visible.get(nativeProps.key) ?? previous?.get(nativeProps.key);
    if (binding?.generation === generation && binding.label === nativeProps.label) binding.action = nativeProps.onPress;
    else binding = copyBinding(page, generation, Button, nativeProps);
    visible.set(nativeProps.key, binding);
    return binding.node;
  });
}
