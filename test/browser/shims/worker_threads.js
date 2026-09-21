// `node:worker_threads` shim for the browser harness.
//
// The constructor delegates to `globalThis.__workerFactory(url, workerData)`,
// which a test can register to run the worker's logic inline. Without a
// registered factory the Worker emits an error, mirroring a real failure.

export class Worker {
    constructor(url, opts = {}) {
        this._listeners = {};
        this._workerData = opts.workerData;
        const factory = globalThis.__workerFactory;

        Promise.resolve()
            .then(() => {
                if (!factory) throw new Error('worker_threads shim: no __workerFactory registered');
                return factory(url, this._workerData);
            })
            .then(
                (result) => { this._emit('message', result); this._emit('exit', 0); },
                (err) => { this._emit('error', err); this._emit('exit', 1); },
            );
    }

    on(evt, cb) { (this._listeners[evt] ||= []).push(cb); return this; }
    once(evt, cb) { const wrap = (a) => { this.off(evt, wrap); cb(a); }; return this.on(evt, wrap); }
    off(evt, cb) { this._listeners[evt] = (this._listeners[evt] || []).filter((f) => f !== cb); return this; }
    postMessage(msg) { if (this._onMessage) this._onMessage(msg); }
    terminate() { return Promise.resolve(0); }
    _emit(evt, arg) { (this._listeners[evt] || []).slice().forEach((cb) => cb(arg)); }
}

export const parentPort = {
    postMessage() { throw new Error('worker_threads shim: parentPort used outside a factory-provided worker'); },
    on() { return parentPort; },
};

// `workerData` is a live binding so a test can install the payload a worker
// module destructures at its top level, then import the worker. (A real worker
// receives it via the Worker constructor; the shim cannot intercept the
// module-scope import binding, so it is set explicitly instead.)
export let workerData = undefined;
export function __setWorkerData(value) { workerData = value; }

const api = { Worker, parentPort, workerData, __setWorkerData };
export default api;
