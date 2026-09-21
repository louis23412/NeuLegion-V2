// Worker-pool fault injection (ROADMAP P0-1). Node-only: it drives the real
// `runWorkerThread` dispatcher with an INJECTED fake worker, so every failure
// mode — an explicit `{error}` payload, a thrown `error` event, a non-zero
// exit, a malformed message, a spawn failure and a watchdog timeout — can be
// asserted without spawning a real thread or touching the DB.
//
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { runWorkerThread, WORKER_TIMEOUT, WORKER_ERROR, WORKER_EXIT, WORKER_MESSAGE } from '../../src/legion/workers.js';

// A stand-in for a worker_threads Worker: an EventEmitter with `terminate()`.
class FakeWorker extends EventEmitter {
    constructor() {
        super();
        this.terminated = false;
    }
    terminate() {
        this.terminated = true;
        return Promise.resolve(0);
    }
}

// `script(worker)` schedules whatever the fake worker should do (emit a
// message, an error, an exit, or nothing).
const dispatch = ({ script, accept = (m) => m && m.ok, onSuccess = (m) => m.value, timeoutMs = 1000 }) => {
    let worker = null;
    return {
        promise: runWorkerThread({
            url: new URL('file:///fake-worker.js'),
            label: 'fake',
            workerData: {},
            accept,
            onSuccess,
            timeoutMs,
            spawn: () => { worker = new FakeWorker(); script(worker); return worker; },
        }),
        get worker() { return worker; },
    };
};

const rejectsWith = (code) => (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
};

test('resolves an accepted message through onSuccess', async () => {
    const d = dispatch({ script: (w) => queueMicrotask(() => w.emit('message', { ok: true, value: 7 })) });
    assert.equal(await d.promise, 7);
    assert.equal(d.worker.terminated, true, 'worker should always be terminated');
});

test('rejects an explicit {error} payload with WORKER_ERROR', async () => {
    const d = dispatch({ script: (w) => queueMicrotask(() => w.emit('message', { error: 'controller blew up' })) });
    await assert.rejects(d.promise, (err) => {
        assert.equal(err.code, WORKER_ERROR);
        assert.match(err.message, /controller blew up/);
        return true;
    });
});

test('rejects a malformed message with WORKER_MESSAGE', async () => {
    const d = dispatch({ script: (w) => queueMicrotask(() => w.emit('message', { nope: true })) });
    await assert.rejects(d.promise, rejectsWith(WORKER_MESSAGE));
});

test('rejects an error event with WORKER_ERROR', async () => {
    const d = dispatch({ script: (w) => queueMicrotask(() => w.emit('error', new Error('thread exploded'))) });
    await assert.rejects(d.promise, rejectsWith(WORKER_ERROR));
});

test('rejects a non-zero exit with WORKER_EXIT (and ignores exit 0)', async () => {
    const bad = dispatch({ script: (w) => queueMicrotask(() => w.emit('exit', 1)) });
    await assert.rejects(bad.promise, rejectsWith(WORKER_EXIT));
    // A clean exit after a resolved message is a no-op.
    const ok = dispatch({ script: (w) => queueMicrotask(() => { w.emit('message', { ok: true, value: 1 }); w.emit('exit', 0); }) });
    assert.equal(await ok.promise, 1);
});

test('rejects a spawn failure with WORKER_ERROR', async () => {
    const promise = runWorkerThread({
        url: new URL('file:///fake-worker.js'), label: 'fake', workerData: {},
        accept: () => true, onSuccess: (m) => m,
        spawn: () => { throw new Error('resource limit'); },
    });
    await assert.rejects(promise, (err) => {
        assert.equal(err.code, WORKER_ERROR);
        assert.match(err.message, /failed to spawn/);
        return true;
    });
});

test('a silent worker is killed by the watchdog with WORKER_TIMEOUT', async () => {
    const d = dispatch({ script: () => {}, timeoutMs: 25 });
    await assert.rejects(d.promise, rejectsWith(WORKER_TIMEOUT));
    assert.equal(d.worker.terminated, true, 'a timed-out worker must be terminated');
});

test('a zero/absent timeout disables the watchdog', async () => {
    const d = dispatch({ script: (w) => setTimeout(() => w.emit('message', { ok: true, value: 9 }), 20), timeoutMs: 0 });
    assert.equal(await d.promise, 9);
});

test('dispatch settles exactly once', async () => {
    const d = dispatch({ script: (w) => queueMicrotask(() => w.emit('message', { ok: true, value: 'first' })) });
    assert.equal(await d.promise, 'first');
    // Later events must not re-settle (a late exit/error would otherwise reject
    // an already-resolved dispatch or surface as an unhandled rejection).
    d.worker.emit('message', { ok: true, value: 'second' });
    d.worker.emit('exit', 3);
    d.worker.emit('error', new Error('late'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(d.worker.terminated, true, 'the worker stays terminated');
});
