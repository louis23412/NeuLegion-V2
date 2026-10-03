// The plugin registry — the single source of truth for every swappable thing.
//
// `analyze.js#VARIANTS` is already the right shape (a candidate is one object with
// an id, a note and an injected effect) and is the one real plugin seam the
// architecture audit found (`docs/ARCHITECTURE-v2.md` §3.1). V2 promotes it to the
// contract layer, with the three rules the audit made mandatory:
//
//   1. `capability` is MANDATORY (R27-2: an arm that cannot act on the scored path
//      is `not-applicable`, never a quiet baseline);
//   2. the roster is pinned by a content hash (`rosterSnapshot()`, the
//      `rosterSnapshot` lesson from round 30 — a silent roster edit is the way a
//      deflated Sharpe gets inflated);
//   3. the registry holds CODE + IDS only. Proofs live with the plugin, in
//      `test/node/contracts.test.js` — a test asserts the two do not drift.
//
// The registry is pure in-memory state and imports only contracts + primitives.
// It never imports a plugin: the composition root (`src/plugins/index.js`) pushes
// plugins in, so `npm test` can construct any registry state it likes.

import { CONTRACTS, CONTRACT_KINDS } from './contracts/index.js';
import { assertPlugin, assertInstance, PLUGIN_STATES, describeContract, CONTRACT_VERSION } from './contracts/base.js';
import { fingerprint } from './primitives/fingerprint.js';

export const KINDS = CONTRACT_KINDS;
export { PLUGIN_STATES };

const store = new Map();

function clearStore() {
    store.clear();
    for (const kind of KINDS) store.set(kind, new Map());
}
clearStore();

const kindOf = (kind) => {
    if (!CONTRACTS[kind]) throw new Error(`unknown plugin kind "${kind}" (known: ${KINDS.join(', ')})`);
    return CONTRACTS[kind];
};

// Register a plugin. Validates against its contract, rejects a duplicate id
// unless `replace` is explicitly asked for, and freezes the registry entry.
export function registerPlugin(kind, impl, { state = 'UNTESTED', defaultStack = false, replace = false } = {}) {
    const contract = kindOf(kind);
    assertPlugin(contract, impl);
    if (!PLUGIN_STATES.includes(state)) throw new Error(`unknown plugin state "${state}" (known: ${PLUGIN_STATES.join(', ')})`);
    const byId = store.get(kind);
    if (byId.has(impl.id) && !replace) throw new Error(`${kind} plugin "${impl.id}" is already registered (pass {replace:true} to override)`);
    const entry = Object.freeze({
        kind,
        id: impl.id,
        capability: impl.capability,
        state,
        defaultStack: !!defaultStack,
        impl,
    });
    byId.set(impl.id, entry);
    return entry;
}

export function hasPlugin(kind, id) {
    kindOf(kind);
    return store.get(kind).has(id);
}

export function resolve(kind, id) {
    kindOf(kind);
    const entry = store.get(kind).get(id);
    if (!entry) {
        const available = [...store.get(kind).keys()].sort();
        throw new Error(`no ${kind} plugin "${id}" registered (available: ${available.length ? available.join(', ') : 'none'})`);
    }
    return entry;
}

export function resolveOrNull(kind, id) {
    kindOf(kind);
    return store.get(kind).get(id) || null;
}

export function ids(kind) {
    kindOf(kind);
    return Object.freeze([...store.get(kind).keys()].sort());
}

export function entries(kind) {
    kindOf(kind);
    return Object.freeze([...store.get(kind).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

export function capabilityOf(kind, id) {
    return resolve(kind, id).capability;
}

// Instantiate a STATEFUL plugin: call its factory and validate the returned
// instance against the same contract. A stateless plugin has no instance — its
// methods are called directly on the plugin object.
export function instantiate(kind, id, options = {}) {
    const contract = kindOf(kind);
    const { impl } = resolve(kind, id);
    if (!contract.stateful) throw new Error(`${kind} plugin "${id}" is stateless; call its methods on the plugin object directly`);
    return assertInstance(contract, impl.create(options));
}

export function stateOf(kind, id) {
    return resolve(kind, id).state;
}

// Kinds with at least one registration — what the engine's `activeRoster` loop
// iterates.
export function registeredKinds() {
    return Object.freeze(KINDS.filter((kind) => store.get(kind).size > 0));
}

// The pre-registered DEFAULT STACK for a kind: the ids flagged `defaultStack`
// when the plugin was registered. If nothing is flagged the kind has no default
// (an explicit empty roster, not "everything"), because silently scoring every
// registered arm is how K is inflated.
export function activeRoster(kind) {
    kindOf(kind);
    return Object.freeze([...store.get(kind).values()]
        .filter((e) => e.defaultStack)
        .map((e) => e.id)
        .sort());
}

// A deterministic snapshot of the ACTIVE stack (kind, id, capability, state) —
// the "engine compose fingerprint" seed of audit A14. It reads no plugin
// internals, so a new non-default plugin cannot move it.
export function stackSnapshot() {
    const rows = [];
    for (const kind of KINDS) {
        for (const entry of entries(kind)) {
            if (entry.defaultStack) rows.push([kind, entry.id, entry.capability, entry.state]);
        }
    }
    return fingerprint(rows);
}

// A deterministic snapshot of EVERYTHING registered — the roster pin. Sorted by
// (kind, id) so registration order can never matter.
export function rosterSnapshot() {
    const rows = [];
    for (const kind of KINDS) {
        for (const entry of entries(kind)) {
            rows.push([kind, entry.id, entry.capability, entry.state, entry.defaultStack]);
        }
    }
    return fingerprint(rows);
}

export function report() {
    const kinds = {};
    let count = 0;
    for (const kind of KINDS) {
        const list = entries(kind);
        count += list.length;
        if (list.length) kinds[kind] = list.map((e) => `${e.id}[${e.capability}${e.defaultStack ? ',default' : ''}]`);
    }
    return {
        contractVersion: CONTRACT_VERSION,
        count,
        kinds,
        contracts: KINDS.map((kind) => describeContract(CONTRACTS[kind])),
        stackSnapshot: stackSnapshot(),
        rosterSnapshot: rosterSnapshot(),
    };
}

// Test/bootstrap hook: empty the registry. Nothing inside the registry calls it.
export function resetRegistry() {
    clearStore();
}
