// FNV-1a over a canonical rendering of a value — the project's one fingerprint
// primitive (`golden.test.js`, `rosterSnapshot()`, the lock registry).
//
// The canonicalisation rules are copied from the golden suite so a hash computed
// here and a hash computed there mean the same thing: numbers are stringified
// (with `-0` distinguished), strings are `JSON.stringify`-quoted/escaped (so a
// string can never be read as a number or collide with a key), functions render
// as `[fn]` (so a function's source — which is engine-dependent — never leaks
// into a hash), object keys are sorted, typed arrays are walked as arrays, and
// every part is joined with U+0001 so "ab"+"c" cannot collide with "a"+"bc".
// `contracts.test.js` §D pins the string/function rules against this doc, and
// `test/browser/entries/golden.test.js` is the definition they must match.

function canonicalParts(value, parts) {
    if (value === null) { parts.push('null'); return; }
    if (value === undefined) { parts.push('undefined'); return; }
    if (typeof value === 'number') { parts.push(Object.is(value, -0) ? '-0' : String(value)); return; }
    if (typeof value === 'string') { parts.push(JSON.stringify(value)); return; }
    if (typeof value === 'boolean' || typeof value === 'bigint') { parts.push(String(value)); return; }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        parts.push('[');
        for (let i = 0; i < value.length; i++) canonicalParts(value[i], parts);
        parts.push(']');
        return;
    }
    if (typeof value === 'object') {
        parts.push('{');
        for (const key of Object.keys(value).sort()) { parts.push(key); canonicalParts(value[key], parts); }
        parts.push('}');
        return;
    }
    if (typeof value === 'function') { parts.push('[fn]'); return; }
    parts.push(String(value));
}

export function canonical(value) {
    const parts = [];
    canonicalParts(value, parts);
    return parts.join('\u0001');
}

export function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function fingerprint(value) {
    return fnv1a(canonical(value));
}
