// Minimal `Buffer` shim (just enough of the node Buffer API used by NeuLegion).
// Injected as a global by the esbuild harness so `Buffer.from(...)` etc. work.

function toUint8(x) {
    if (x instanceof Uint8Array) return x.slice();
    if (Array.isArray(x)) return Uint8Array.from(x);
    if (typeof x === 'string') return new TextEncoder().encode(x);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    throw new TypeError(`Unsupported Buffer.from input: ${Object.prototype.toString.call(x)}`);
}

const Buffer = {
    from(x, byteOffset, length) {
        if (x instanceof ArrayBuffer) {
            const off = byteOffset || 0;
            const len = length !== undefined ? length : x.byteLength - off;
            return new Uint8Array(x, off, len);
        }
        return toUint8(x);
    },
    allocUnsafe(n) { return new Uint8Array(n); },
    alloc(n) { return new Uint8Array(n); },
    isBuffer(v) { return v instanceof Uint8Array; },
    concat(list) {
        let total = 0;
        for (const b of list) total += b.length;
        const out = new Uint8Array(total);
        let o = 0;
        for (const b of list) { out.set(b, o); o += b.length; }
        return out;
    },
};

export { Buffer };
export default Buffer;
