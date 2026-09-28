// Core contract kernel (NeuLegion V2.0, `docs/ARCHITECTURE-v2.md` §4).
//
// This is the shared vocabulary of the V2 architecture: a *contract* is a named
// set of methods a swappable part must expose, and a *plugin* is an object that
// satisfies one. Nothing here imports anything — the contract layer is the root
// of the import law (`docs/MIGRATION-V2.md` §2):
//
//     contracts <- 0 deps
//     primitives <- contracts
//     plugins    <- contracts + primitives (+ the one legacy adapter)
//     lab        <- contracts + primitives + the legacy repo (read-only)
//     core never imports plugins; plugins never import each other.
//
// Grounding: the modularity lesson is Parnas' information hiding (Parnas,
// "On the Criteria To Be Used in Decomposing Systems into Modules", CACM 1972) —
// a module boundary is a *decision that may change*, so the boundary must be a
// declared interface rather than a file split. This repo's own evidence for the
// cost of getting that wrong is `docs/COMPONENTS.md` (the 22 prototype-mixin bags
// are separable but not substitutable) and `docs/ARCHITECTURE-v2.md` §3.3 (the
// whole-engine lock made the one experiment the design exists for economically
// forbidden). `COMPONENTS.md` rule 4 ("don't touch the hot math") stays true for
// the legacy engine; the contract layer is additive and touches nothing there.
//
// The `capability` tag is mandatory and is the R27-2 lesson made first-class: an
// arm that cannot act on the scored path is `not-applicable`, not a quiet
// baseline (`docs/PLAN-round31.md` §0.5 A2; `BUGS.md` #44).

export const CONTRACT_VERSION = 'v2.0';

// What a plugin is allowed to claim about itself. `not-applicable` exists so a
// structurally-off-path arm is registered and *seen* to be off-path instead of
// being scored as a null result.
export const CAPABILITIES = Object.freeze({
    MODEL: 'model',                     // acts on the scored directional path (a learner)
    CONTROLLER: 'controller',           // a controller-shaped arm (legacy HiveMindController)
    AGNOSTIC: 'agnostic',               // acts regardless of the arm (a mechanic / port)
    SLEEVE: 'sleeve',                   // allocates capital across a cross-section
    RISK: 'risk',                       // sizing / position / turnover policy
    EVALUATOR: 'evaluator',             // measurement only, never traded
    NOT_APPLICABLE: 'not-applicable',   // cannot act on the scored path
});

export const CAPABILITY_VALUES = Object.freeze(Object.values(CAPABILITIES));

// The register's state taxonomy, mirroring `src/lineage.js` (the plugin's own
// state, not the A/B arm's): a plugin lands UNTESTED and only a run promotes it.
export const PLUGIN_STATES = Object.freeze(['LIVE', 'KEEP', 'PARK', 'DROPPED', 'UNTESTED']);

// Plugin ids are slugs so they can be used as registry keys, CLI ids and lineage
// branch names (`NL-<LINEAGE>-<branch>@<version>`).
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Contract: `requires`/`optional` name METHODS only. A plugin may carry extra DATA
// fields (`spec`, `defaults`, `family`, `speed`, `constraints`, …) — the contract
// constrains behaviour, not metadata, so a data field is never a contract gap.
//
// `stateful` switches the plugin shape: a stateful kind (a learner, a memory
// bank, a retriever, a data source) owns per-instance state, so the registered
// object is a FACTORY that must implement `create(options)` and the returned
// instance must implement `requires`/`optional` (checked by `validateInstance`).
// Stateless kinds (a feature, a sleeve, a book, a risk policy, an evaluator) keep
// their methods on the plugin object itself. One mechanism, two shapes — the
// alternative (a second contract type) would let the two drift.
export function defineContract({ kind, purpose, requires = [], optional = [], stateful = false }) {
    if (typeof kind !== 'string' || !ID_PATTERN.test(kind)) throw new Error(`contract kind must be a slug, got ${JSON.stringify(kind)}`);
    if (typeof purpose !== 'string' || purpose.length < 8) throw new Error(`contract "${kind}" needs a purpose`);
    // A non-array `requires`/`optional` (e.g. the string 'fit') is spread into its
    // CHARACTERS by `[...requires]`, silently declaring methods 'f'/'i'/'t' and
    // rejecting every conforming plugin with a baffling message — require an array.
    if (!Array.isArray(requires) || !Array.isArray(optional)) {
        throw new Error(`contract "${kind}" requires/optional must be arrays of method names`);
    }
    const seen = new Set();
    for (const method of [...requires, ...optional]) {
        if (typeof method !== 'string' || !method) throw new Error(`contract "${kind}" has a bad method name`);
        if (seen.has(method)) throw new Error(`contract "${kind}" lists "${method}" twice`);
        seen.add(method);
    }
    if (stateful && seen.has('create')) throw new Error(`contract "${kind}" is stateful; "create" is implicit and must not be listed`);
    return Object.freeze({
        kind,
        purpose,
        stateful,
        requires: Object.freeze([...requires]),
        optional: Object.freeze([...optional]),
    });
}

// Validate an implementation against a contract. Returns every problem rather
// than the first, so a suite failure names the whole gap in one pass.
export function validatePlugin(contract, impl) {
    const errors = [];
    if (!contract || typeof contract !== 'object' || !contract.kind) {
        return { ok: false, errors: ['no contract given'] };
    }
    if (impl === null || (typeof impl !== 'object' && typeof impl !== 'function')) {
        return { ok: false, errors: [`${contract.kind} plugin must be an object`] };
    }
    if (typeof impl.id !== 'string' || !ID_PATTERN.test(impl.id)) {
        errors.push(`${contract.kind} plugin id must match ${ID_PATTERN}, got ${JSON.stringify(impl.id)}`);
    }
    if (!CAPABILITY_VALUES.includes(impl.capability)) {
        errors.push(`${contract.kind} plugin "${impl.id}" needs a capability in {${CAPABILITY_VALUES.join(', ')}}, got ${JSON.stringify(impl.capability)}`);
    }
    if (contract.stateful) {
        if (typeof impl.create !== 'function') errors.push(`${contract.kind} plugin "${impl.id}" is stateful and must implement create(options)`);
    } else {
        for (const method of contract.requires) {
            if (typeof impl[method] !== 'function') errors.push(`${contract.kind} plugin "${impl.id}" must implement ${method}()`);
        }
        for (const method of contract.optional) {
            if (impl[method] !== undefined && typeof impl[method] !== 'function') {
                errors.push(`${contract.kind} plugin "${impl.id}" declares ${method} but it is not a function`);
            }
        }
    }
    return { ok: errors.length === 0, errors };
}

// Validate the instance a stateful plugin's `create()` returned: it must
// implement the contract's method list (it has no id/capability of its own — the
// plugin's identity is the registration).
export function validateInstance(contract, instance) {
    const errors = [];
    if (!contract || typeof contract !== 'object' || !contract.kind) return ['no contract given'];
    if (instance === null || typeof instance !== 'object') return [`${contract.kind} instance must be an object`];
    for (const method of contract.requires) {
        if (typeof instance[method] !== 'function') errors.push(`${contract.kind} instance must implement ${method}()`);
    }
    for (const method of contract.optional) {
        if (instance[method] !== undefined && typeof instance[method] !== 'function') {
            errors.push(`${contract.kind} instance declares ${method} but it is not a function`);
        }
    }
    return errors;
}

export function assertInstance(contract, instance) {
    const errors = validateInstance(contract, instance);
    if (errors.length) throw new Error(`[${contract && contract.kind}] invalid instance: ${errors.join('; ')}`);
    return instance;
}

export function assertPlugin(contract, impl) {
    const result = validatePlugin(contract, impl);
    if (!result.ok) throw new Error(`[${contract && contract.kind}] invalid plugin: ${result.errors.join('; ')}`);
    return impl;
}

// One-line contract description for docs/reports (`registry.report()`).
export function describeContract(contract) {
    return `${contract.kind}: requires[${contract.requires.join(', ')}] optional[${contract.optional.join(', ')}]`;
}
