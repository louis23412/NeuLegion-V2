// `MemoryBank` — one associative memory, per bank.
//
// Split from retrieval by audit A12 (`docs/AUDIT-round31-v2.md`): the shipped
// retrieval is global (it mixes episodic + adaptive + semantic, ranks entries,
// applies an exploration rate and draws `Math.random()`), so it cannot be a
// method of one bank. A bank owns only its own content: write / decay / merge /
// consolidate / stats. Grounding: Kanerva 1988 (sparse distributed memory) for
// the associative core, `docs/COMPONENTS.md` for why the shipped banks are
// coupled to the ensemble through `_updateHiveState`.

import { defineContract, validatePlugin } from './base.js';

export const MEMORY_CONTRACT = defineContract({
    kind: 'memory',
    purpose: 'own a prototype/associative memory: write, decay, merge, stats',
    stateful: true,
    requires: ['write', 'decay', 'stats'],
    optional: ['merge', 'consolidate', 'entries', 'fingerprint'],
});

export const isMemoryPlugin = (impl) => validatePlugin(MEMORY_CONTRACT, impl).ok;
