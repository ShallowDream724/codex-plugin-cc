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
