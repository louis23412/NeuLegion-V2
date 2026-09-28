// `Retriever` — the policy over banks (audit A12 / A20).
//
// The contract takes an INJECTED RNG and it is not optional: the shipped read
// path (`_retrieveTopRelevantProtos`) draws `Math.random()`, so two same-seed
// runs are only byte-identical when `legion/rng.js#installSeededRandom` is
// installed. Making the stream a parameter is what lets a retrieval experiment be
// reproducible (`docs/AUDIT-round31-v2.md` A20, finding P12).

import { defineContract, validatePlugin } from './base.js';

export const RETRIEVE_CONTRACT = defineContract({
    kind: 'retrieve',
    purpose: 'read a candidate/neighbour set from banks with an injected RNG',
    stateful: true,
    requires: ['read'],
    optional: ['fingerprint'],
});

export const isRetrievePlugin = (impl) => validatePlugin(RETRIEVE_CONTRACT, impl).ok;
