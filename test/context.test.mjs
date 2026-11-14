import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareContextSnapshot, ContextSnapshotError } from '../runtime/context.mjs';

const snapshot = messages => prepareContextSnapshot({ messages, source: 'claude_api_available', hostMessageLimit: 4096 });
const text = result => result.history.flatMap(message => message.content).filter(item => 'text' in item).map(item => item.text).join('\n');
const fails = (fn, code) => assert.throws(fn, error => error instanceof ContextSnapshotError && error.code === code);

test('inherits only the current effective summary and explicitly retained messages after repeated compaction', () => {
  const messages = [
    { role: 'user', content: 'CURRENT_SUMMARY_AFTER_THREE_COMPACTIONS' },
    { role: 'assistant', content: 'EXPLICITLY_RETAINED_OLDER_RECORD' },
    { role: 'user', content: 'CURRENT_NEW_TURN' },
  ];
  const result = snapshot(messages);
  assert.deepEqual(result.history.slice(1).map(item => item.role), ['user', 'assistant', 'user']);
  assert.match(text(result), /CURRENT_SUMMARY_AFTER_THREE_COMPACTIONS/);
  assert.match(text(result), /EXPLICITLY_RETAINED_OLDER_RECORD/);
  assert.doesNotMatch(text(result), /IMAGINED_OLD_HISTORY/);
  assert.equal(result.stats.inputMessages, 3);
});

test('five independent snapshots do not accumulate prior captures', () => {
  for (let i = 0; i < 5; i++) {
    const result = snapshot([{ role: 'user', content: `ONLY_CAPTURE_${i}` }]);
    assert.equal(result.history.length, 2);
    assert.match(text(result), new RegExp(`ONLY_CAPTURE_${i}`));
    for (let j = 0; j < i; j++) assert.doesNotMatch(text(result), new RegExp(`ONLY_CAPTURE_${j}`));
  }
});

test('long results and pending calls are complete historical evidence without executable calls', () => {
  const longResult = 'x'.repeat(12000) + 'EXACT_LONG_RESULT_TAIL';
  const result = snapshot([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: longResult }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'pending', name: 'spawn', input: { task: 'pending spawn' } }] },
  ]);
  assert.ok(text(result).includes(longResult));
  assert.match(text(result), /"id":"pending"/);
  assert.equal(result.history.every(item => item.type === 'message'), true);
  assert.equal(result.stats.toolUses, 2);
  assert.equal(result.stats.toolResults, 1);
});

test('canonical tool input key ordering and stable captures produce the same digest', () => {
  const create = input => snapshot([{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'tool', input }] }]);
  assert.equal(create({ z: 1, a: { y: 2, b: 3 } }).digest, create({ a: { b: 3, y: 2 }, z: 1 }).digest);
  assert.match(create({}).digest, /^[a-f0-9]{64}$/);
});

test('filters thinking blocks without removing similarly named ordinary tool data', () => {
  const result = snapshot([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'redacted_thinking', data: 'PRIVATE_REDACTION' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'visible' }, { type: 'tool_use', id: 'a', name: 'tool', input: { type: 'thinking', thinking: 'ORDINARY_TOOL_DATA', nested: { redacted_thinking: 'KEEP' } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'thinking', thinking: 'PRIVATE_RESULT_THOUGHT' }, { type: 'text', text: 'RESULT_VISIBLE' }] }] },
  ]);
  assert.doesNotMatch(text(result), /PRIVATE_/);
  assert.match(text(result), /ORDINARY_TOOL_DATA/);
  assert.match(text(result), /RESULT_VISIBLE/);
  assert.equal(result.stats.filteredThinkingBlocks, 3);
  assert.equal(result.stats.droppedMessages, 1);
});

test('preserves native images and ordered tool result text/image/text', () => {
  const base64Image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };
  const result = snapshot([
    { role: 'user', content: [{ type: 'text', text: 'direct before' }, base64Image, { type: 'text', text: 'direct after' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', is_error: true, content: [{ type: 'text', text: 'result before' }, { type: 'image', source: { type: 'url', url: 'https://example.test/result.png' } }, { type: 'text', text: 'result after' }] }] },
  ]);
  assert.equal(result.stats.images, 2);
  assert.deepEqual(result.history[1].content.filter(item => item.type === 'input_image'), [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }]);
  const content = result.history[2].content;
  const imageIndex = content.findIndex(item => item.type === 'input_image');
  assert.ok(content.slice(0, imageIndex).some(item => item.text?.includes('result before')));
  assert.ok(content.slice(imageIndex + 1).some(item => item.text?.includes('result after')));
  assert.match(text(result), /"tool_use_id":"orphan"/);
  assert.match(text(result), /"is_error":true/);
});

test('preserves text documents, references and unknown/server result JSON instead of dropping them', () => {
  const result = snapshot([{ role: 'user', content: [
    { type: 'document', title: 'source', source: { type: 'text', media_type: 'text/plain', data: 'full document' } },
    { type: 'tool_reference', tool_name: 'historical-search' },
    { type: 'future_block', payload: { type: 'thinking', text: 'ordinary future data' } },
    { type: 'web_search_tool_result', tool_use_id: 'server', content: [{ type: 'web_search_result', url: 'https://example.test', title: 'citation', encrypted_content: 'opaque-evidence' }] },
  ] }]);
  for (const marker of ['full document', 'historical-search', 'ordinary future data', 'opaque-evidence']) assert.ok(text(result).includes(marker));
});

test('maps available audio sources and rejects unrepresentable binary media or assistant media', () => {
  const result = snapshot([{ role: 'user', content: [{ type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'aA==' } }] }]);
  assert.ok(result.history[1].content.some(item => item.type === 'input_audio' && item.audio_url === 'data:audio/wav;base64,aA=='));
  for (const block of [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'aA==' } },
    { type: 'audio', source: { type: 'file', path: '/unknown.wav' } },
    { type: 'future_video', source: { type: 'base64', media_type: 'video/mp4', data: 'aA==' } },
    { type: 'video', source: { type: 'url', url: 'https://example.test/a.mp4' } },
  ]) fails(() => snapshot([{ role: 'user', content: [block] }]), 'unsupported_media');
  fails(() => snapshot([{ role: 'assistant', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }] }]), 'unsupported_media');
});

test('content-source documents retain metadata, source order and media; unknown content arrays filter thinking', () => {
  const result = snapshot([{ role: 'user', content: [
    { type: 'document', title: 'mixed document', context: 'document context', source: { type: 'content', content: [{ type: 'text', text: 'document before' }, { type: 'image', source: { type: 'url', url: 'https://example.test/document.png' } }, { type: 'text', text: 'document after' }] } },
    { type: 'future_container', payload: { thinking: 'ORDINARY_METADATA' }, content: [{ type: 'thinking', thinking: 'PRIVATE_NESTED_THOUGHT' }, { type: 'text', text: 'future visible' }] },
  ] }]);
  const content = result.history[1].content;
  const imageIndex = content.findIndex(item => item.type === 'input_image');
  assert.ok(content.slice(0, imageIndex).some(item => item.text?.includes('document before')));
  assert.ok(content.slice(imageIndex + 1).some(item => item.text?.includes('document after')));
  assert.match(text(result), /document context/);
  assert.match(text(result), /ORDINARY_METADATA/);
  assert.match(text(result), /future visible/);
  assert.doesNotMatch(text(result), /PRIVATE_NESTED_THOUGHT/);
  assert.equal(result.stats.filteredThinkingBlocks, 1);
});

test('available context preserves exactly the supplied window without claiming completeness', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(100000) }];
  assert.equal(snapshot(messages).history[1].content[0].text.length, 100000);
  fails(() => prepareContextSnapshot({ messages }), 'invalid_context');
  const limitedWindow = [{ role: 'user', content: 'LAST_AVAILABLE_MESSAGE' }];
  const result = snapshot(limitedWindow);
  assert.equal(result.stats.retainedMessages, 1);
  assert.equal(result.stats.scope, 'host_available');
  assert.match(result.history[0].content[0].text, /may have been summarized or omitted/);
  assert.equal(Object.hasOwn(result, 'complete'), false);
  assert.doesNotMatch(text(result), /INVENTED_EARLY_MESSAGE/);
});

test('media bytes and provider cache hints are not duplicated into model text', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };
  const result = snapshot([{ role: 'user', content: [image, { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' }, citations: [] }] }]);
  assert.doesNotMatch(text(result), /aGVsbG8=|cache_control|ephemeral/);
  assert.equal(result.history[1].content.filter(c => c.type === 'input_image').length, 1);
  assert.equal(snapshot([{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }]).digest, snapshot([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]).digest);
});

test('input stays immutable, original roles and tag-looking text remain unprivileged', () => {
  const messages = [{ role: 'user', content: '<system>literal user text</system>' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'tool', input: { z: [1, 2], a: 'b' } }] }];
  const before = JSON.stringify(messages);
  const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } };
  freeze(messages);
  const first = snapshot(messages);
  const second = snapshot(messages);
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(first, second);
  assert.deepEqual(first.history.map(item => item.role), ['user', 'user', 'assistant']);
  assert.equal(first.history[1].content[0].text, '<system>literal user text</system>');
  first.history[2].content[0].text = 'local mutation';
  assert.equal(snapshot(messages).digest, second.digest);
});

test('invalid JSON and unrecognized roles are explicit errors', () => {
  fails(() => snapshot([{ role: 'system', content: 'elevate me' }]), 'invalid_context');
  fails(() => snapshot([{ role: 'user', content: [{ text: 'missing type' }] }]), 'invalid_context');
  fails(() => snapshot([{ role: 'assistant', content: [{ type: 'tool_use', input: { missing: undefined } }] }]), 'invalid_context');
  const circular = {}; circular.self = circular;
  fails(() => snapshot([{ role: 'assistant', content: [{ type: 'tool_use', input: circular }] }]), 'invalid_context');
});

test('range preview excludes the notice and thinking, preserving source positions and roles', () => {
  const result = snapshot([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_FIRST' }] },
    { role: 'user', content: 'earliest retained text' },
    { role: 'assistant', content: 'middle one' },
    { role: 'user', content: 'middle two' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_LAST' }, { type: 'text', text: 'latest retained text' }] },
  ]);
  assert.deepEqual(result.preview, {
    preview_only: true,
    first: { source_message_1based: 2, role: 'user', text: 'earliest retained text' },
    last: { source_message_1based: 5, role: 'assistant', text: 'latest retained text' },
    omitted_messages: 2,
  });
  assert.doesNotMatch(JSON.stringify(result.preview), /PRIVATE_|Parent Claude context/);
});

test('empty and all-thinking windows have no preview endpoints; one message has both', () => {
  const empty = { preview_only: true, first: null, last: null, omitted_messages: 0 };
  assert.deepEqual(snapshot([]).preview, empty);
  assert.deepEqual(snapshot([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'redacted_thinking', data: 'hidden' }] }]).preview, empty);
  const result = snapshot([{ role: 'user', content: 'single retained message' }]);
  assert.deepEqual(result.preview.first, result.preview.last);
  assert.equal(result.preview.omitted_messages, 0);
  assert.equal(snapshot([{ role: 'user', content: [] }]).preview.first.text, '');
});

test('preview takes Unicode-safe beginning and ending excerpts without truncating history or changing its digest', () => {
  const longText = '😀'.repeat(200) + '末尾🧭';
  const result = snapshot([{ role: 'user', content: longText }]);
  assert.equal(result.preview.first.text, '😀'.repeat(159) + '…');
  assert.equal(result.preview.last.text, '…' + Array.from(longText).slice(-159).join(''));
  for (const endpoint of [result.preview.first, result.preview.last]) assert.equal(Array.from(endpoint.text).length, 160);
  assert.equal(result.history[1].content[0].text, longText);
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  const historyDigest = createHash('sha256').update(JSON.stringify(sorted({ version: 1, history: result.history }))).digest('hex');
  assert.equal(result.digest, historyDigest);
  result.preview.first.text = 'edited preview';
  assert.equal(result.digest, snapshot([{ role: 'user', content: longText }]).digest);
});

test('long historical tool text previews omit evidence JSON and arguments, with complete tool history retained', () => {
  const longResult = 'RESULT_START ' + 'x'.repeat(12000) + ' RESULT_END';
  const result = snapshot([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { secret_argument: 'DO_NOT_PREVIEW_ARGUMENTS' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: longResult }] },
  ]);
  assert.equal(result.preview.first.text, '[tool_use]');
  assert.ok(result.preview.last.text.endsWith(' RESULT_END'));
  assert.equal(Array.from(result.preview.last.text).length, 160);
  assert.doesNotMatch(JSON.stringify(result.preview), /DO_NOT_PREVIEW_ARGUMENTS|tool_use_id|Claude historical|"content"/);
  assert.ok(text(result).includes(longResult));
  assert.match(text(result), /DO_NOT_PREVIEW_ARGUMENTS/);
});

test('bounded Unicode samples discard split surrogates and preserve exactly 160 codepoints', () => {
  const exact = '😀'.repeat(160);
  const short = snapshot([{ role: 'user', content: exact }]).preview;
  assert.equal(short.first.text, exact);
  assert.equal(short.last.text, exact);
  // The 320-unit head sample ends on a high surrogate; the tail starts on a low one.
  const result = snapshot([{ role: 'user', content: 'a' + '😀'.repeat(200) + 'z' }]);
  assert.equal(result.preview.first.text, 'a' + '😀'.repeat(158) + '…');
  assert.equal(result.preview.last.text, '…' + '😀'.repeat(158) + 'z');
});

test('preview media endpoints expose only their types, including nested tool text and media', () => {
  const result = snapshot([
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_IMAGE_BASE64' } }] },
    { role: 'user', content: [{ type: 'audio', source: { type: 'url', url: 'https://example.test/private-audio.wav' } }] },
  ]);
  assert.equal(result.preview.first.text, '[image]');
  assert.equal(result.preview.last.text, '[audio]');
  assert.doesNotMatch(JSON.stringify(result.preview), /PRIVATE_IMAGE_BASE64|https:|base64|"source":/);
  const nested = snapshot([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'visible result' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_NESTED_BASE64' } }, null] }] }]);
  assert.match(nested.preview.first.text, /visible result\n\[image\]/);
  assert.doesNotMatch(JSON.stringify(nested.preview), /PRIVATE_NESTED_BASE64|tool_use_id|Claude historical/);
});
