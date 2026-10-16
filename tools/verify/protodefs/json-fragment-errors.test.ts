import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  classifyProtoDefFragment,
  normalizeProtoDefFragments,
} from '../../../src/protodefs/jsonFragments';
import { AppError, ERROR_CODES } from '../../../src/errors';

function importBroken(text: string): AppError {
  try {
    normalizeProtoDefFragments([{ name: 'broken_DEF.json', text }]);
  } catch (cause) {
    assert.ok(cause instanceof AppError);
    return cause;
  }
  assert.fail('Expected definition import to fail.');
}

test('unterminated strings and other malformed JSON get distinct codes', () => {
  assert.equal(importBroken('{"header":{"defindex":123},"name":"unfinished}').code, ERROR_CODES.definitionJsonUnterminatedString);
  assert.equal(importBroken('{"header":{"defindex":123},,}').code, ERROR_CODES.definitionJsonSyntax);
});

test('syntax diagnostics use parser offsets across LF and CRLF lines', () => {
  for (const newline of ['\n', '\r\n']) {
    const error = importBroken(`{${newline}  "operation_node": [{}]${newline}  "header": {"defindex": 123}${newline}}`);
    assert.equal(error.code, ERROR_CODES.definitionJsonSyntax);
    assert.deepEqual(error.location, { line: 3, column: 3 });
    assert.match(error.technicalDetail ?? '', /Parser: CommaExpected/);
  }
});

test('diagnostics do not accept JSONC syntax or recover partial fragments', () => {
  for (const text of [
    '{"operation_node": [{}], /* comment */ "header": {"defindex": 123}}',
    '{"operation_node": [{}], "header": {"defindex": 123,}}',
    '{"operation_node": [{}]} {"operation_node": [{}]}',
    '{"operation_node": [{}], "value": 01}',
    '{"operation_node": [{}], "value": "bad\\xescape"}',
  ]) {
    assert.equal(importBroken(text).code, ERROR_CODES.definitionJsonSyntax);
    assert.equal(classifyProtoDefFragment(text), null);
  }
  const truncated = '{"operation_node": [{}]';
  assert.equal(importBroken(truncated).code, ERROR_CODES.definitionJsonIncomplete);
  assert.equal(classifyProtoDefFragment(truncated), null);
});

test('community placeholders and outer trailing commas retain native JSON values', () => {
  const text = '  {"operation_node": [{}], "header": {"defindex": ###}, "type": "DEF_TYPE_PAINTKIT_OPERATION", "__proto__": {"kept": true}},\n';
  const [fragment] = normalizeProtoDefFragments([{ name: 'operation.json', text }]);
  assert.equal(classifyProtoDefFragment(text), 'operation');
  assert.equal(fragment.kind, 'operation');
  assert.deepEqual(fragment.value.header, { defindex: 900_000_001 });
  assert.equal(fragment.value.type, 7);
  assert.equal(Object.hasOwn(fragment.value, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(fragment.value), Object.prototype);
});
