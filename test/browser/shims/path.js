// Minimal POSIX `path` shim for running NeuLegion in a browser Worker.

function normalize(p) {
    p = String(p);
    const abs = p.startsWith('/');
    const out = [];
    for (const part of p.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!abs) out.push('..');
        } else {
            out.push(part);
        }
    }
    const joined = out.join('/');
    return (abs ? '/' : '') + joined || (abs ? '/' : '.');
}

function join(...parts) {
    return normalize(parts.filter((p) => p !== undefined && p !== null).join('/'));
}

function dirname(p) {
    p = normalize(p);
    const i = p.lastIndexOf('/');
    if (i < 0) return '.';
    if (i === 0) return '/';
    return p.slice(0, i);
}

function basename(p, ext) {
    p = String(p);
    let b = p.slice(p.lastIndexOf('/') + 1);
    if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
    return b;
}

function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i) : '';
}

function resolve(...parts) {
    let p = '';
    for (const part of parts) {
        if (!part) continue;
        p = String(part).startsWith('/') ? String(part) : `${p}/${part}`;
    }
    return normalize(p);
}

const posix = { join, dirname, basename, extname, normalize, resolve, sep: '/' };
const api = { ...posix, posix };

export default api;
export { join, dirname, basename, extname, normalize, resolve };
export const sep = '/';
