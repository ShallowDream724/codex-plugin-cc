import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessageMarkdown as normalize } from '../hooks/message-markdown.js';

test('repairs malformed prose strong delimiters while preserving visible characters', () => {
  assert.equal(normalize('**第一，市场开始减速。 **令投资者担忧。'), '**第一，市场开始减速。** 令投资者担忧。');
  assert.equal(normalize('**标题： **说明\n**第二。**后文'), '**标题：** 说明\n**第二**。后文');
  assert.equal(normalize('**一： **内容\n\n**二。**后文'), '**一：** 内容\n\n**二**。后文');
});

test('preserves valid emphasis, unfinished streams, ambiguous operators and nested emphasis', () => {
  for (const input of [
    '**标题**后文', '**标题。** 后文', '**第一，内容。**', '**unfinished',
    'x**2 + y**3', '**一 *二* 三。 **后文', '***标题。 ***后文',
    String.raw`\**标题。 **后文`, '**标题**和**内容**',
  ]) assert.equal(normalize(input), input, input);
});

test('protects code, links, raw HTML and math across lines', () => {
  const input = [
    '```markdown', '**标题。 **内容', '```',
    '> ```', '> **标题。 **内容', '> ```',
    '- ~~~', '  **标题。 **内容', '  ~~~',
    '    **标题。 **内容',
    '`**标题。 **内容`', '``unfinished', '**标题。 **内容', '``',
    '[link](https://example.test/**标题。 **内容)',
    '[link](https://example.test/', '**标题。 **内容)',
    '<https://example.test/**标题。 **内容>', '<div>', '**标题。 **内容', '</div>', '',
    '$**标题。 **内容$', '$$\n**标题。 **内容\n$$',
    String.raw`\(**标题。 **内容\)`, String.raw`\[\begin{matrix}a \[3pt] **标题。 **内容\end{matrix}\]`,
    String.raw`\[unfinished`, '**标题。 **内容',
  ].join('\n');
  assert.equal(normalize(input), input);
});

test('native block and inline math normalization is limited to the desktop renderer', () => {
  const input = String.raw`Text \(x\) before \[a \[3pt] b\]`;
  assert.equal(normalize(input), input);
  assert.equal(normalize(input, { nativeMath: true }), 'Text $x$ before \n$$\na \\[3pt] b\n$$');
});

test('handles many unmatched delimiters and long prose in linear work', () => {
  const input = Array(20000).fill('**标题。 **后文\n').join('') + '`'.repeat(20000);
  const output = normalize(input);
  assert.ok(output.startsWith('**标题。** 后文\n'));
  assert.ok(output.endsWith('`'.repeat(20000)));
});
