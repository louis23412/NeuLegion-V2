// `DataSource` — a panel of aligned series (candles, funding, positioning).
//
// Absorbs `candle_fetcher` / `funding_fetcher` / the manifests
// (`docs/ARCHITECTURE-v2.md` §4.2). A source is responsible for the *integrity*
// of its own rows: the repo's existing pure auditor (`candles_audit.js`) and the
// read-time winsorizer (`candle_quality.js`) carry over unchanged behind it.

import { defineContract, validatePlugin } from './base.js';

export const SOURCE_CONTRACT = defineContract({
    kind: 'source',
    purpose: 'load a causal, aligned panel of series and describe its identity',
    stateful: true,
    requires: ['load'],
    optional: ['fingerprint'],
});

export const isSourcePlugin = (impl) => validatePlugin(SOURCE_CONTRACT, impl).ok;
