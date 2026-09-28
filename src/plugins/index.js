// The plugin composition root — the ONLY file under `src/plugins/` that imports
// other plugin files.
//
// Design: no plugin registers itself at module-eval (the audit's complaint about
// `legion/database.js` is precisely a module-eval side effect, §3.2), and
// nothing under `src/core/` imports a plugin (the bridge is one-directional).
// The composition root is where the two meet: it imports the plugin objects and
// pushes them into the registry. That keeps every plugin isolation-testable (a
// test can import one plugin module and call its methods with no registry) and
// makes the stack a value a test can assemble differently.
//
// `defaultStack` is deliberately NARROW: only `legacy-hivemind` is the shipped
// default trajectory (V2.0's acceptance condition is "the default stack
// reproduces the legacy goldens"). The sleeves and the risk layer are registered
// but NOT default — a plugin becomes default only by clearing its gate (G2 for a
// sleeve book, G4 for a learner; `docs/PLAN-round31.md`). Scoring every
// registered arm is how K gets inflated (the R27-2 / round-30 lesson).
//
// Import law (enforced by `contracts.test.js`): every file here except this one
// may import only `core/contracts`, `core/primitives`, Node built-ins and the
// single legacy adapter; no plugin imports another plugin.

import { registerPlugin } from '../core/registry.js';
import { legacyHivemindLearner } from './learners/legacy-hivemind.js';
import { baseRateLearner } from './learners/base-rate.js';
import { ridgeLearner } from './learners/ridge.js';
import { mlpLearner } from './learners/mlp.js';
import { carryDispersionSleeve } from './sleeves/carry-dispersion.js';
import { toptraderFadeSleeve } from './sleeves/toptrader-fade.js';
import { oiChangeSleeve } from './sleeves/oi-change.js';
import { capBandRisk } from './risk/cap-band.js';
import { singleBook } from './books/single.js';
import { fixedSplitBook } from './books/fixed-split.js';

// The canonical plugin list. `state` mirrors `src/lineage.js`/`PLUGIN_STATES`:
// UNTESTED lands, and only the repo's own gate promotes.
export const DEFAULT_STACK = Object.freeze([
    { kind: 'learner', plugin: legacyHivemindLearner, state: 'LIVE', defaultStack: true },
    { kind: 'learner', plugin: baseRateLearner, state: 'UNTESTED', defaultStack: false },
    { kind: 'learner', plugin: ridgeLearner, state: 'UNTESTED', defaultStack: false },
    { kind: 'learner', plugin: mlpLearner, state: 'UNTESTED', defaultStack: false },
    { kind: 'risk', plugin: capBandRisk, state: 'LIVE', defaultStack: false },
    { kind: 'sleeve', plugin: carryDispersionSleeve, state: 'UNTESTED', defaultStack: false },
    { kind: 'sleeve', plugin: toptraderFadeSleeve, state: 'UNTESTED', defaultStack: false },
    { kind: 'sleeve', plugin: oiChangeSleeve, state: 'UNTESTED', defaultStack: false },
    { kind: 'book', plugin: singleBook, state: 'LIVE', defaultStack: false },
    { kind: 'book', plugin: fixedSplitBook, state: 'UNTESTED', defaultStack: false },
]);

export function installDefaultStack({ replace = true } = {}) {
    const installed = [];
    for (const entry of DEFAULT_STACK) {
        registerPlugin(entry.kind, entry.plugin, { state: entry.state, defaultStack: entry.defaultStack, replace });
        installed.push(`${entry.kind}:${entry.plugin.id}`);
    }
    return installed;
}

export const PLUGIN_IDS = Object.freeze(DEFAULT_STACK.map((entry) => `${entry.kind}:${entry.plugin.id}`));
