import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
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
  assert.deepEqual(error.location, { line: 1, column: 47 });
  assert.equal(error.path, 'broken_DEF.json');
  const detail = error.technicalDetail;
  assert.ok(detail);
  assert.match(detail, /broken_DEF\.json/);
  assert.match(detail, /unterminated string|unexpected end/i);
  assert.match(detail, /actual mistake can be earlier/i);
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
