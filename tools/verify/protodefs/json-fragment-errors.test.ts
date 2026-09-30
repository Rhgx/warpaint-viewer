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

test('unterminated definition strings have a stable, helpful error', () => {
  const error = importBroken('{"header":{"defindex":123},"name":"unfinished}');
  assert.equal(error.code, ERROR_CODES.definitionJsonUnterminatedString);
  assert.match(error.userMessage, /missing closing quotation mark/i);
  assert.deepEqual(error.location, { line: 1, column: 35 });
  assert.equal(error.path, 'broken_DEF.json');
  const detail = error.technicalDetail;
  assert.ok(detail);
  assert.match(detail, /broken_DEF\.json/);
  assert.match(detail, /UnexpectedEndOfString/);
  assert.match(detail, /actual mistake can be earlier/i);
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

test('truncated definition JSON is not misreported as an unfinished string', () => {
  const error = importBroken('{"header":{"defindex":123}');
  assert.equal(error.code, ERROR_CODES.definitionJsonIncomplete);
  assert.match(error.userMessage, /incomplete json/i);
  assert.doesNotMatch(error.userMessage, /quotation mark/i);
  assert.equal(error.location?.line, 1);
  assert.ok(error.location?.column);
});

test('other malformed definition JSON uses the generic syntax code', () => {
  const error = importBroken('{"header":{"defindex":123},,}');
  assert.equal(error.code, ERROR_CODES.definitionJsonSyntax);
  assert.match(error.userMessage, /missing comma, quotation mark, bracket, or brace/i);
  const detail = error.technicalDetail;
  assert.ok(detail);
  assert.match(detail, /Parser:/);
});
