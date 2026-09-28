// The `MemoryBank` plugin registry (round 46, W4a — DESIGN ONLY).
//
// Companion to `memory/contract.js`: registration with validation on the way
// in, no silent duplicates, deterministic stack snapshots, and the default
// stack — exactly today's 4 banks, so resolving it reproduces current
// behavior by construction. Like the contract, nothing here is on the scored
// path: the engine keeps installing its method bags directly (see
// `internal/mixins.js`), and the V2.3 binding will resolve the active stack
// through HERE with the gate that the default resolution is byte-identical
// to today's engine (golden suite, not this module, proves that).

import { BANK_IDS, validateBank } from './contract.js';

export const DEFAULT_STACK = Object.freeze([...BANK_IDS]);

const _banks = new Map();

export function registerBank(impl) {
    const v = validateBank(impl);
    if (!v.ok) throw new Error(`registerBank: ${v.reasons.join('; ')}`);
    if (_banks.has(impl.id)) throw new Error(`registerBank: duplicate bank id "${impl.id}"`);
    _banks.set(impl.id, impl);
    return impl.id;
}

export function hasBank(id) {
    return _banks.has(id);
}

export function ids() {
    return [..._banks.keys()];
}

// Resolve a stack of bank ids to their implementations. Unknown ids throw
// (never null — a silently missing bank would run a different engine than
// the report claims, the R27 lesson).
export function resolveStack(stack = DEFAULT_STACK) {
    if (!Array.isArray(stack) || !stack.length) throw new Error('resolveStack: a non-empty id list is required');
    return stack.map((id) => {
        const b = _banks.get(id);
        if (!b) throw new Error(`resolveStack: unknown bank id "${id}" (registered: ${[..._banks.keys()].join(', ') || 'none'})`);
        return b;
    });
}

// Deterministic snapshot of a resolved stack (id@version in order). The
// default stack's digest is pinned in `modules.test.js`: a silent change to
// the default composition fails there, not in a golden diff.
export function stackDigest(stack = DEFAULT_STACK) {
    return resolveStack(stack).map((b) => `${b.id}@${b.version}`).join('+');
}

// Test seam: the registry is module state, so suites reset it explicitly.
// Production code never calls this (banks register once at startup).
export function _clearRegistryForTests() {
    _banks.clear();
}
