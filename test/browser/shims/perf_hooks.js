// `node:perf_hooks` shim — browsers already expose a global `performance`.

export const performance = globalThis.performance;
const api = { performance };
export default api;
