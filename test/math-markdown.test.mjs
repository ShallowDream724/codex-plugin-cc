import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplayMath, parseMathSpans } from '../hooks/math-markdown.js';

test('converts paired display formulas to separate Markdown math blocks', () => {
  const input = 'First:\n\\[\nE=mc^2\n\\]\nSecond: \\[a + b = c\\] done';
  assert.equal(normalizeDisplayMath(input), 'First:\n$$\nE=mc^2\n$$\nSecond: \n$$\na + b = c\n$$\n done');
  assert.equal(normalizeDisplayMath('\\[\r\nx\r\n\\]'), '$$\r\nx\r\n$$');
});

test('extracts formulas while preserving matrix row spacing and nested TeX', () => {
  const input = String.raw`Matrix:
\[
\begin{pmatrix}
  1 & \begin{array}{c} a \\[3pt] b \end{array} \\*[3pt]
  0 & 2
\end{pmatrix} + \text{\$5}
\]
Inline \(f(x) = \begin{matrix}1 \\[3pt] 2\end{matrix}\) remains in its paragraph.`;
  const spans = parseMathSpans(input);
  assert.deepEqual(spans.map(s => s.type), ['display', 'inline']);
  assert.equal(spans[0].content, input.slice(spans[0].start + 2, spans[0].end - 2));
  assert.equal(spans[1].content, String.raw`f(x) = \begin{matrix}1 \\[3pt] 2\end{matrix}`);
  const rendered = normalizeDisplayMath(input);
  assert.ok(rendered.includes('$$\n' + spans[0].content.slice(1, -1) + '\n$$'));
  assert.ok(rendered.includes(String.raw`Inline \(f(x) = \begin{matrix}1 \\[3pt] 2\end{matrix}\) remains`));
});

test('does not discover delimiters inside existing math or code, including escaped dollars', () => {
  const input = [
    String.raw`$\text{\$5} + \begin{matrix} a \\[3pt] b \end{matrix} + \(x\)$`,
    String.raw`$$\text{\$5} + \begin{array}{c} a \\*[3pt] b \end{array} + \[x\]$$`,
    '`' + String.raw`code \\[3pt] \(hidden\)` + '`',
    String.raw`\(visible\)`,
  ].join('\n');
  const spans = parseMathSpans(input);
  assert.deepEqual(spans.map(s => [s.type, s.content]), [['inline', 'visible']]);
  assert.equal(normalizeDisplayMath(input), input);
});

test('leaves incomplete math alone and resumes after fenced code', () => {
  const input = ['\\(unfinished', '```tex', '\\[not math\\]', '```', '\\[complete\\]'].join('\n');
  assert.deepEqual(parseMathSpans(input).map(s => [s.type, s.content]), [['display', 'complete']]);
  assert.equal(normalizeDisplayMath(input), ['\\(unfinished', '```tex', '\\[not math\\]', '```', '$$', 'complete', '$$'].join('\n'));
  assert.deepEqual(parseMathSpans(String.raw`unfinished \(x`), []);
  assert.deepEqual(parseMathSpans(String.raw`escaped \\(x\) and \\\\[3pt]`), []);
});

test('keeps backticks and escaped dollars inside TeX opaque', () => {
  const display = '\\[\\text{`price`} + \\$5 + \\begin{matrix}a \\\\[3pt] b\\end{matrix}\\]';
  const inline = '\\(\\text{`inline`} + \\$1\\)';
  const input = `${display} and ${inline}`;
  const spans = parseMathSpans(input);
  assert.deepEqual(spans.map(s => s.type), ['display', 'inline']);
  assert.equal(spans[0].content, display.slice(2, -2));
  assert.equal(spans[1].content, inline.slice(2, -2));
  assert.equal(normalizeDisplayMath(input), `$$\n${display.slice(2, -2)}\n$$\n and ${inline}`);
});

test('leaves fenced and inline code, existing math, and inline delimiters unchanged', () => {
  const input = [
    '```tex', '\\[x\\]', '```', '~~~', '\\[y\\]', '~~~',
    '`\\[z\\]` and ``code ` \\[q\\]``',
    '$$\n\\[a\\]\n$$ and $\\[b\\]$ and \\(c\\)',
  ].join('\n');
  assert.equal(normalizeDisplayMath(input), input);
});

test('leaves escaped or incomplete delimiters and unclosed fences unchanged', () => {
  for (const input of ['\\\\[x\\]', '\\[x\\\\]', '\\[unfinished', '```\n\\[x\\]']) {
    assert.equal(normalizeDisplayMath(input), input);
  }
  assert.equal(normalizeDisplayMath('\\\\\\[x\\]'), '\\\\\n$$\nx\n$$');
  assert.equal(normalizeDisplayMath('\\[x `code` y\\]'), '$$\nx `code` y\n$$');
});
