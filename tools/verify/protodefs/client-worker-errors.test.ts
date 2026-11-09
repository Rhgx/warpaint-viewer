import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createProtoDefSource } from '../../../src/protodefs/client';
import { AppError, ERROR_CODES } from '../../../src/errors';
import { shippedProtoDefs } from '../fixtures';

interface WorkerRequest { id: number; kind: string }
type WorkerReply = { ok: true; result: unknown } | { ok: false; message: string; appError?: object } | 'crash';

// Stands in for protodefs.worker.ts: records each request and answers it with whatever the test queued.
class FakeWorker {
  static created: FakeWorker[] = [];
  static answer: (request: WorkerRequest) => WorkerReply = () => ({ ok: true, result: null });
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: WorkerRequest[] = [];
  terminated = false;

  constructor() { FakeWorker.created.push(this); }

  postMessage(request: WorkerRequest): void {
    this.requests.push(request);
    const reply = FakeWorker.answer(request);
    queueMicrotask(() => {
      if (reply === 'crash') this.onerror?.();
      else this.onmessage?.({ data: { id: request.id, ...reply } });
    });
  }

  terminate(): void { this.terminated = true; }
}

beforeEach(() => {
  FakeWorker.created = [];
  FakeWorker.answer = () => ({ ok: true, result: null });
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => vi.unstubAllGlobals());

const EMPTY_INDEX = { kits: [], countsByType: {} };
const OPTIONS = { weaponsByItemDef: {}, builtInIds: [] };

test('a request the worker rejects fails on its own and later requests still use the worker', async () => {
  FakeWorker.answer = (request) => {
    if (request.kind === 'open') return { ok: true, result: EMPTY_INDEX };
    return request.id === 2 ? { ok: false, message: 'kit 7 has no operation' } : { ok: true, result: null };
  };
  const source = createProtoDefSource();
  await source.open(new Uint8Array([1, 2, 3]), OPTIONS);
  await assert.rejects(source.resolveRecipe(7, 'c_scattergun', 'red', 0), /kit 7 has no operation/);
  assert.equal(await source.resolveRecipe(8, 'c_scattergun', 'red', 0), null);
  const [worker] = FakeWorker.created;
  assert.deepEqual(worker.requests.map((request) => request.kind), ['open', 'resolveRecipe', 'resolveRecipe']);
  assert.equal(worker.terminated, false);
  source.dispose();
});

test('an AppError thrown in the worker reaches the caller with its code and location', async () => {
  FakeWorker.answer = () => ({
    ok: false,
    message: 'Parser: CommaExpected',
    appError: {
      code: ERROR_CODES.definitionJsonSyntax,
      userMessage: 'This file contains invalid JSON.',
      technicalDetail: 'Parser: CommaExpected',
      path: 'paint_DEF.json',
      location: { line: 3, column: 3 },
    },
  });
  const source = createProtoDefSource();
  const failure = await source.openJsonFragments(new Uint8Array(0), [], OPTIONS).then(() => null, (cause: unknown) => cause);
  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, ERROR_CODES.definitionJsonSyntax);
  assert.equal(failure.userMessage, 'This file contains invalid JSON.');
  assert.equal(failure.path, 'paint_DEF.json');
  assert.deepEqual(failure.location, { line: 3, column: 3 });
  source.dispose();
});

test('a worker that dies is replaced by the in-process decoder', async () => {
  FakeWorker.answer = () => 'crash';
  const { fullBytes, options } = shippedProtoDefs();
  const source = createProtoDefSource();
  const index = await source.open(fullBytes, options);
  assert.ok(index.kits.length > 0, 'the in-process fallback decoded the container');
  assert.equal(FakeWorker.created[0].terminated, true);
  source.dispose();
});
