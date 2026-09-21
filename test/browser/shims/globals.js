// Globals injected into the bundled project so Node-only globals resolve in
// the browser Worker. `process.exit` throws (rather than silently stopping)
// so tests surface hard-failure paths instead of hanging.

import { Buffer } from './buffer.js';

export { Buffer };

export const process = {
    exit(code) { throw new Error(`process.exit(${code ?? 0}) called`); },
    env: {},
    argv: [],
    platform: 'browser',
    version: 'v0.0.0',
    nextTick(fn, ...args) { return Promise.resolve().then(() => fn(...args)); },
    stdout: { write() {} },
    stderr: { write() {} },
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
};

export const global = globalThis;
