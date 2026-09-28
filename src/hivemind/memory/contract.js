// The `MemoryBank` plugin contract (round 46, W4a — DESIGN ONLY).
//
// PLAN-round31 §4: change the lock model from "whole engine bit-exact" to
// "interface contract per component", so memory styles can be swapped and
// tested cheaply. This module is the contract half of that change: the shape
// every memory bank must implement, a validator, and the engine grounding —
// each of the 4 current banks mapped to the engine methods that implement it,
// so the interface is fitted to reality, not sketched in a vacuum.
//
// DESIGN-ONLY scope (deliberate): nothing here rewires the engine. The 4
// banks stay exactly where they are (`memory/banks.js` + retrieval /
// consolidation / protos, installed on `HiveMind.prototype`); the default
// stack resolves to today's behavior by construction. The engine binding
// (V2.3) lands separately with its own gate: the default stack must
// reproduce today's goldens byte-for-byte, and each plugin then earns its
// OWN fingerprint. Until then, adding/removing a non-default plugin cannot
// move any existing fingerprint because no scored path imports this module.
//
// Interface (one bank):
//   write(entry)      store a {mean, variance, size, key, meta} prototype
//   read(query, k)    return candidate prototypes (may consult the index)
//   decay()           age/forget
//   merge(a, b)       combine two prototypes
//   consolidate()     promote/evict between tiers
//   stats()           diagnostics (counts, variance, LSH consistency)

export const BANK_CONTRACT_METHODS = Object.freeze(
    ['write', 'read', 'decay', 'merge', 'consolidate', 'stats'],
);

// The 4 current banks, in default-stack order. The ids name the engine state
// they own (`hiveMind.js` fields): episodic -> `_attentionMemory`, adaptive
// -> `_adaptiveContext`, semantic -> `_semanticProtos`, core -> `_coreEpisodic`.
export const BANK_IDS = Object.freeze(['episodic', 'adaptive', 'semantic', 'core']);

// Engine grounding: the shipped methods behind each bank id. A V2.3 plugin
// must cover AT LEAST these call sites to be a faithful replacement; the
// `modules.test.js` W4a section asserts every named method exists on
// `HiveMind.prototype`, so engine drift fails loudly here first.
export const ENGINE_BANK_METHODS = Object.freeze({
    episodic: Object.freeze({
        state: '_attentionMemory',
        methods: Object.freeze(['_updateMemoryBanks', '_pruneMemory', '_retrieveTopRelevantProtos']),
    }),
    adaptive: Object.freeze({
        state: '_adaptiveContext',
        methods: Object.freeze(['_updateMemoryBanks']),
    }),
    semantic: Object.freeze({
        state: '_semanticProtos',
        methods: Object.freeze(['_updateSemanticProtos', '_consolidateSemanticProtos', '_decayProtos']),
    }),
    core: Object.freeze({
        state: '_coreEpisodic',
        methods: Object.freeze(['_createNewProto', '_finalizeSemanticProto']),
    }),
});

// Tournament targets, in evidence order (PLAN-round31 §4 / W4b): volatility
// first (the only documented predictability — L09/F-16), then regime, then
// sleeve P&L (gated on F-35 being re-opened by a new feature family).
// Directional next-bar prediction is NOT a target (NL-MECH/NL-BENCH closed it).
export const TOURNAMENT_TARGETS = Object.freeze(['realised-vol', 'regime', 'sleeve-pnl']);

export function validateBank(impl) {
    const reasons = [];
    if (!impl || typeof impl !== 'object') {
        return { ok: false, reasons: ['a bank implementation object is required'] };
    }
    if (typeof impl.id !== 'string' || !impl.id) reasons.push('id must be a non-empty string');
    if (typeof impl.version !== 'string' || !impl.version) reasons.push('version must be a non-empty string');
    for (const m of BANK_CONTRACT_METHODS) {
        if (typeof impl[m] !== 'function') reasons.push(`missing contract method "${m}"`);
    }
    return { ok: reasons.length === 0, reasons };
}

export function assertBank(impl) {
    const v = validateBank(impl);
    if (!v.ok) throw new Error(`MemoryBank contract violation: ${v.reasons.join('; ')}`);
    return impl;
}

// The tournament protocol, made mechanical (PLAN-round31 §4): a bank promotes
// only if it beats the best zero-parameter reference out of sample, at matched
// exposure, with positive skill — otherwise it is recorded and parked. This
// validates the CONFIGURATION; running it needs the V2.3 swappable engine.
export function validateTournament({ target, baseline = 'zero-parameter', alpha = 0.05 } = {}) {
    const reasons = [];
    if (!TOURNAMENT_TARGETS.includes(target)) {
        reasons.push(`target must be one of ${TOURNAMENT_TARGETS.join(', ')} (directional prediction is closed)`);
    }
    if (typeof baseline !== 'string' || !baseline) reasons.push('baseline must name the zero-parameter reference');
    if (!(alpha > 0) || !(alpha < 1)) reasons.push('alpha must be in (0, 1)');
    return { ok: reasons.length === 0, reasons };
}
