// Minimal `node:url` shim for the browser harness.
//
// Only the pieces the project's CLI guards use: `pathToFileURL` (to compare
// against `import.meta.url`) and `fileURLToPath`. There is no real filesystem
// here, so absolute POSIX-style hrefs are enough.

export function pathToFileURL(p) {
    const s = String(p).split('\\').join('/');
    const abs = s.startsWith('/') ? s : `/${s}`;
    const href = `file://${abs}`;
    return { href, pathname: abs, protocol: 'file:', toString() { return href; } };
}

export function fileURLToPath(u) {
    return String(u).replace(/^file:\/\//, '').split('\\').join('/');
}

const api = { pathToFileURL, fileURLToPath };
export default api;
