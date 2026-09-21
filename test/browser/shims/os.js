// Minimal `os` shim for the browser harness.

export function availableParallelism() {
    return Math.max(1, (globalThis.navigator && globalThis.navigator.hardwareConcurrency) || 4);
}
export function cpus() { return [{ model: 'browser-worker' }]; }
export function networkInterfaces() { return { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }; }
export function hostname() { return 'browser'; }

const api = { availableParallelism, cpus, networkInterfaces, hostname };
export default api;
