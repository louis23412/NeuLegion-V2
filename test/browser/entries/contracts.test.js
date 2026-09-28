// The V2.0 contract layer — proof suite for `src/core/**` and `src/plugins/**`.
//
// Grounding: `docs/ARCHITECTURE-v2.md` §4 (the contract-first architecture) and
// `docs/MIGRATION-V2.md` (the migration map). The section split is deliberate so a
// failure names the tier:
//
//   A. THE CONTRACT KERNEL   `defineContract` / `validatePlugin` / `validateInstance`
//                            accept, reject and throw exactly as declared.
//   B. THE CONTRACT TABLE    ten kinds, each well-formed and distinct.
//   C. THE REGISTRY          validate-on-register, no duplicate, no silent K,
//                            deterministic snapshots, roster = defaultStack only.
//   D. PRIMITIVES            exact reference vectors for the ported book hygiene
//                            (`clipWeights`/`bandWeights`/`cleanBook`, order matters),
//                            the row weighting, the masked cross-sectional target,
//                            the policy, turnover, and the two book shells — plus
//                            the absent-data masks (a `null` signal column and a
//                            non-finite leg, which must not throw or inject NaN).
//   E. THE SLEEVES           the three pinned lab specs, as *structure*: the fade's
//                            sign, the cap, the band, the 50/50 blend, causality.
//   F. THE RISK/B OOK LAYER  the position clamp + the cap/band specs + composition.
//   G. THE COMPOSITION ROOT  `installDefaultStack()` registers the stack, the default
//                            roster is exactly the legacy learner, snapshots stable.
//   H. THE IMPORT LAW        contracts <- 0 deps; primitives <- contracts;
//                            plugins <- contracts+primitives (+ the ONE legacy
//                            adapter); no plugin imports a plugin; core never
//                            imports plugins or the legacy engine; the legacy tree
//                            never imports core (so the locked paths are unmoved).
//   I. THE ONE-VIEW RULE     the scoring view and the audit view must be identical.
//   K. THE SLEEVE COMPOSITION the driver-side sleeve -> book -> risk -> gate chain
//                            (sleeve weights through the pinned risk spec, scored
//                            by the gate's own arithmetic + A2/A18 readouts).
//
// Section H is the modulariy guarantee made mechanical; sections D/E are the port's
// arithmetic (the lab's `e73_port_verify.js` re-derives the same numbers from the
// real data and reproduces `e52`'s stored books).

import {
    CAPABILITIES,
    CAPABILITY_VALUES,
    PLUGIN_STATES,
    CONTRACT_VERSION,
    defineContract,
    validatePlugin,
    validateInstance,
    assertPlugin,
    assertInstance,
} from '../../../src/core/contracts/base.js';
import { CONTRACTS, CONTRACT_KINDS, SOURCE_CONTRACT, LEARNER_CONTRACT } from '../../../src/core/contracts/index.js';
import {
    registerPlugin,
    resolve,
    resolveOrNull,
    hasPlugin,
    ids,
    entries,
    capabilityOf,
    stateOf,
    instantiate,
    registeredKinds,
    activeRoster,
    stackSnapshot,
    rosterSnapshot,
    report,
    resetRegistry,
    KINDS,
} from '../../../src/core/registry.js';
import {
    canonical,
    fingerprint,
    viewIdentity,
    viewFingerprint,
    sameView,
    assertOneView,
    MIN_TRAIN_PERIODS,
    clipWeights,
    saturateWeights,
    bandWeights,
    cleanBook,
    sumAbs,
    maxAbs,
    normalizeL1,
    turnoverSeries,
    ewmaUpdate,
    blendRows,
    rowRankWeights,
    rowLevelWeights,
    crossSectionalTarget,
    applyWeightPolicy,
    dlogPositive,
    firstCommonIndex,
    buildFundingBook,
    buildCrossSectionalBook,
    dlogMatrix,
    blendBooks,
} from '../../../src/core/primitives/index.js';
import { carryDispersionSleeve, CARRY_DISPERSION_SPEC } from '../../../src/plugins/sleeves/carry-dispersion.js';
import { toptraderFadeSleeve, TOPTRADER_FADE_SPEC } from '../../../src/plugins/sleeves/toptrader-fade.js';
import { oiChangeSleeve, OI_CHANGE_SPEC } from '../../../src/plugins/sleeves/oi-change.js';
import { capBandRisk, CAP_BAND_SPECS } from '../../../src/plugins/risk/cap-band.js';
import { singleBook } from '../../../src/plugins/books/single.js';
import { fixedSplitBook, commonTimeIndexes } from '../../../src/plugins/books/fixed-split.js';
import { legacyHivemindLearner, LEGACY_HIVEMIND_DEFAULTS } from '../../../src/plugins/learners/legacy-hivemind.js';
import { DEFAULT_STACK, PLUGIN_IDS, installDefaultStack } from '../../../src/plugins/index.js';
import { SLEEVE_IDS, resolveSleeve, scoreSleeve, buildCarrySleeveView, parseSleeveInputs, runSleeveReport, formatSleeveReport } from '../../../src/sleeve_score.js';
import { bookReturns, bookTurnover, scoreBook, scoreBookReturns } from '../../../src/analysis/portfolio.js';

// The lock register's V2 section (`test/lock-registry.js`) and the module-by-module
// export contract it is validated against (the analysis/support pattern: both
// directions, so a silent un-locked entry point is a failure).
import {
    CORE_MODULES,
    CORE_REGISTRY,
    PLUGIN_REGISTRY,
    validateRegistry,
    LOCK_LEVELS,
    CITATIONS,
    KNOWN_TESTS,
} from '../../lock-registry.js';
import * as baseMod from '../../../src/core/contracts/base.js';
import * as contractsIndexMod from '../../../src/core/contracts/index.js';
import * as sourceMod from '../../../src/core/contracts/source.js';
import * as featureMod from '../../../src/core/contracts/feature.js';
import * as labelMod from '../../../src/core/contracts/label.js';
import * as learnerMod from '../../../src/core/contracts/learner.js';
import * as memoryMod from '../../../src/core/contracts/memory.js';
import * as retrieveMod from '../../../src/core/contracts/retrieve.js';
import * as sleeveMod from '../../../src/core/contracts/sleeve.js';
import * as bookMod from '../../../src/core/contracts/book.js';
import * as riskContractMod from '../../../src/core/contracts/risk.js';
import * as evaluatorMod from '../../../src/core/contracts/evaluator.js';
import * as fingerprintMod from '../../../src/core/primitives/fingerprint.js';
import * as viewsMod from '../../../src/core/primitives/views.js';
import * as weightsMod from '../../../src/core/primitives/weights.js';
import * as seriesMod from '../../../src/core/primitives/series.js';
import * as booksMod from '../../../src/core/primitives/books.js';
import * as primitivesIndexMod from '../../../src/core/primitives/index.js';
import * as registryMod from '../../../src/core/registry.js';
import * as pluginsIndexMod from '../../../src/plugins/index.js';
import * as legacyMod from '../../../src/plugins/learners/legacy-hivemind.js';
import * as carryMod from '../../../src/plugins/sleeves/carry-dispersion.js';
import * as fadeMod from '../../../src/plugins/sleeves/toptrader-fade.js';
import * as oiMod from '../../../src/plugins/sleeves/oi-change.js';
import * as capBandMod from '../../../src/plugins/risk/cap-band.js';
import * as singleBookMod from '../../../src/plugins/books/single.js';
import * as fixedSplitMod from '../../../src/plugins/books/fixed-split.js';

const CORE_IMPORTS = {
    'contracts/base.js': baseMod,
    'contracts/index.js': contractsIndexMod,
    'contracts/source.js': sourceMod,
    'contracts/feature.js': featureMod,
    'contracts/label.js': labelMod,
    'contracts/learner.js': learnerMod,
    'contracts/memory.js': memoryMod,
    'contracts/retrieve.js': retrieveMod,
    'contracts/sleeve.js': sleeveMod,
    'contracts/book.js': bookMod,
    'contracts/risk.js': riskContractMod,
    'contracts/evaluator.js': evaluatorMod,
    'primitives/fingerprint.js': fingerprintMod,
    'primitives/views.js': viewsMod,
    'primitives/weights.js': weightsMod,
    'primitives/series.js': seriesMod,
    'primitives/books.js': booksMod,
    'primitives/index.js': primitivesIndexMod,
    'registry.js': registryMod,
    'plugins/index.js': pluginsIndexMod,
    'plugins/learners/legacy-hivemind.js': legacyMod,
    'plugins/sleeves/carry-dispersion.js': carryMod,
    'plugins/sleeves/toptrader-fade.js': fadeMod,
    'plugins/sleeves/oi-change.js': oiMod,
    'plugins/risk/cap-band.js': capBandMod,
    'plugins/books/single.js': singleBookMod,
    'plugins/books/fixed-split.js': fixedSplitMod,
};

const PROJECT_ROOT = 'src/NeuLegion-master/NeuLegion-master';

// The law's file list: every `.js` under these roots. When the caller supplies a
// listing function the check also asserts the list is COMPLETE (a new leaky file
// cannot hide); otherwise the list is the manifest below.
const LAW_FILES = [
    'src/core/contracts/base.js',
    'src/core/contracts/index.js',
    'src/core/contracts/source.js',
    'src/core/contracts/feature.js',
    'src/core/contracts/label.js',
    'src/core/contracts/learner.js',
    'src/core/contracts/memory.js',
    'src/core/contracts/retrieve.js',
    'src/core/contracts/sleeve.js',
    'src/core/contracts/book.js',
    'src/core/contracts/risk.js',
    'src/core/contracts/evaluator.js',
    'src/core/primitives/fingerprint.js',
    'src/core/primitives/views.js',
    'src/core/primitives/weights.js',
    'src/core/primitives/series.js',
    'src/core/primitives/books.js',
    'src/core/primitives/index.js',
    'src/core/registry.js',
    'src/plugins/index.js',
    'src/plugins/learners/legacy-hivemind.js',
    'src/plugins/sleeves/carry-dispersion.js',
    'src/plugins/sleeves/toptrader-fade.js',
    'src/plugins/sleeves/oi-change.js',
    'src/plugins/risk/cap-band.js',
    'src/plugins/books/single.js',
    'src/plugins/books/fixed-split.js',
];

// The single file allowed to import the legacy engine.
const LEGACY_ADAPTER = 'src/plugins/learners/legacy-hivemind.js';
const LEGACY_ROOTS = ['src/hivemind', 'src/analysis', 'src/legion', 'src/observer', 'src/controller'];
const BARE_ALLOWED = /^(node:)?(fs|path|crypto|os|url|worker_threads|perf_hooks|readline|util|events)$/;
const ENGINE_IMPORT_ALLOWED = 'src/hivemind/hiveMind.js';

function importSpecifiers(text) {
    const specs = [];
    const staticRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = staticRe.exec(text))) specs.push(m[1]);
    const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynamicRe.exec(text))) specs.push(m[1]);
    return specs;
}

function resolveSpecifier(file, spec) {
    if (!spec.startsWith('.')) return spec;
    const parts = file.split('/');
    parts.pop();
    for (const segment of spec.split('/')) {
        if (segment === '.' || segment === '') continue;
        if (segment === '..') parts.pop();
        else parts.push(segment);
    }
    return parts.join('/');
}

const inDir = (path, dir) => path.startsWith(`${dir}/`);
const isCoreContract = (p) => inDir(p, 'src/core/contracts');
const isCorePrimitive = (p) => inDir(p, 'src/core/primitives');
const isCore = (p) => inDir(p, 'src/core');
const isPlugin = (p) => inDir(p, 'src/plugins');
const isLegacy = (p) => LEGACY_ROOTS.some((root) => inDir(p, root));

export async function run(options = {}) {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    const resolveReader = () => {
        if (typeof options.readFile === 'function') return options.readFile;
        if (globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function') {
            return (p) => globalThis.__fs.readTextFile(p.startsWith(PROJECT_ROOT) ? p : `${PROJECT_ROOT}/${p}`);
        }
        return null;
    };
    const resolveLister = () => {
        if (typeof options.listFiles === 'function') return options.listFiles;
        return null;
    };

    const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

    // ---- A. the contract kernel ---------------------------------------------
    try {
        defineContract({ kind: 'Bad Kind', purpose: 'a purpose long enough' });
        check('A: defineContract rejects a non-slug kind', false);
    } catch { check('A: defineContract rejects a non-slug kind', true); }
    try {
        defineContract({ kind: 'good', purpose: 'short' });
        check('A: defineContract rejects a stub purpose', false);
    } catch { check('A: defineContract rejects a stub purpose', true); }
    try {
        defineContract({ kind: 'good', purpose: 'a purpose long enough', requires: ['a', 'a'] });
        check('A: defineContract rejects a duplicate method', false);
    } catch { check('A: defineContract rejects a duplicate method', true); }
    try {
        defineContract({ kind: 'good', purpose: 'a purpose long enough', stateful: true, requires: ['create'] });
        check('A: a stateful contract must not list create as an instance method', false);
    } catch { check('A: a stateful contract must not list create as an instance method', true); }
    try {
        // A string `requires` is spread into its CHARACTERS, silently declaring
        // methods 'f'/'i'/'t' and rejecting every conforming plugin.
        defineContract({ kind: 'good', purpose: 'a purpose long enough', requires: 'fit' });
        check('A: defineContract rejects a non-array requires/optional', false);
    } catch { check('A: defineContract rejects a non-array requires/optional', true); }

    const demo = defineContract({ kind: 'demo', purpose: 'a demonstration contract', requires: ['run'], optional: ['note'] });
    check('A: a well-formed contract freezes its method lists',
        demo.requires.length === 1 && demo.optional.length === 1 && Object.isFrozen(demo) && Object.isFrozen(demo.requires));
    check('A: validatePlugin accepts a conforming plugin',
        validatePlugin(demo, { id: 'ok', capability: CAPABILITIES.AGNOSTIC, run() {} }).ok === true);
    check('A: validatePlugin needs an id', validatePlugin(demo, { capability: 'agnostic', run() {} }).errors.some((e) => e.includes('id')));
    check('A: validatePlugin rejects a bad capability', validatePlugin(demo, { id: 'ok', capability: 'wizard', run() {} }).errors.some((e) => e.includes('capability')));
    check('A: validatePlugin rejects a missing required method', validatePlugin(demo, { id: 'ok', capability: 'agnostic' }).errors.length === 1);
    check('A: validatePlugin rejects a non-function optional method', validatePlugin(demo, { id: 'ok', capability: 'agnostic', run() {}, note: 3 }).errors.length === 1);
    check('A: assertPlugin throws with the kind in the message', (() => { try { assertPlugin(demo, { id: 'ok', capability: 'agnostic' }); return false; } catch (e) { return e.message.includes('[demo]'); } })());
    check('A: a stateful contract validates create() on the plugin, not the instance methods',
        validatePlugin(LEARNER_CONTRACT, { id: 'stateless-claim', capability: 'model' }).errors.length === 1 &&
        validatePlugin(LEARNER_CONTRACT, { id: 'factory', capability: 'model', create() {} }).ok === true);
    check('A: validateInstance checks the created instance',
        validateInstance(LEARNER_CONTRACT, { fit() {}, predict() {} }).length === 0 &&
        validateInstance(LEARNER_CONTRACT, { fit() {} }).length === 1);
    check('A: assertInstance throws on a bare object', (() => { try { assertInstance(LEARNER_CONTRACT, {}); return false; } catch { return true; } })());
    check('A: CAPABILITY_VALUES covers the taxonomy', CAPABILITY_VALUES.length === 7 && CAPABILITY_VALUES.includes('not-applicable'));
    check('A: PLUGIN_STATES mirror the lineage register states', deepEqual([...PLUGIN_STATES], ['LIVE', 'KEEP', 'PARK', 'DROPPED', 'UNTESTED']));
    check('A: CONTRACT_VERSION is v2.0', CONTRACT_VERSION === 'v2.0');

    // ---- B. the contract table ----------------------------------------------
    check('B: ten contract kinds are declared', CONTRACT_KINDS.length === 10, CONTRACT_KINDS.join(','));
    check('B: registry KINDS mirrors the contract table', deepEqual([...KINDS], [...CONTRACT_KINDS]));
    check('B: every contract key matches its kind', CONTRACT_KINDS.every((k) => CONTRACTS[k].kind === k));
    check('B: every contract states a purpose', CONTRACT_KINDS.every((k) => CONTRACTS[k].purpose.length > 8));
    check('B: stateful kinds are factories, stateless kinds expose their methods',
        [SOURCE_CONTRACT, CONTRACTS.learner, CONTRACTS.memory, CONTRACTS.retrieve].every((c) => c.stateful === true) &&
        [CONTRACTS.feature, CONTRACTS.label, CONTRACTS.sleeve, CONTRACTS.book, CONTRACTS.risk, CONTRACTS.evaluator].every((c) => c.stateful === false));
    check('B: the sleeve contract requires signal()', CONTRACTS.sleeve.requires.includes('signal'));
    check('B: the risk contract requires position()', CONTRACTS.risk.requires.includes('position'));
    check('B: the evaluator contract requires score()', CONTRACTS.evaluator.requires.includes('score'));

    // ---- C. the registry -----------------------------------------------------
    resetRegistry();
    check('C: an empty registry has no kinds',
        registeredKinds().length === 0 && activeRoster('sleeve').length === 0);
    const registered = registerPlugin('sleeve', carryDispersionSleeve, { state: 'UNTESTED', defaultStack: false });
    check('C: register returns a frozen entry with capability + state',
        Object.isFrozen(registered) && registered.capability === 'sleeve' && registered.state === 'UNTESTED');
    check('C: hasPlugin / ids / entries reflect the registration',
        hasPlugin('sleeve', 'carry-dispersion') && deepEqual([...ids('sleeve')], ['carry-dispersion']) && entries('sleeve').length === 1);
    check('C: capabilityOf / stateOf read back the entry',
        capabilityOf('sleeve', 'carry-dispersion') === 'sleeve' && stateOf('sleeve', 'carry-dispersion') === 'UNTESTED');
    check('C: a duplicate id is rejected', (() => { try { registerPlugin('sleeve', carryDispersionSleeve); return false; } catch (e) { return e.message.includes('already registered'); } })());
    check('C: replace:true overwrites deliberately',
        registerPlugin('sleeve', carryDispersionSleeve, { state: 'KEEP', replace: true }).state === 'KEEP');
    check('C: an unknown kind throws with the known kinds listed', (() => { try { registerPlugin('wizard', carryDispersionSleeve); return false; } catch (e) { return e.message.includes('unknown plugin kind') && e.message.includes('evaluator'); } })());
    check('C: an invalid plugin is rejected before it enters the registry',
        (() => { try { registerPlugin('sleeve', { id: 'no-signal', capability: 'sleeve' }); return false; } catch (e) { return e.message.includes('invalid plugin'); } })());
    check('C: an unknown state is rejected', (() => { try { registerPlugin('sleeve', carryDispersionSleeve, { state: 'MAYBE', replace: true }); return false; } catch (e) { return e.message.includes('unknown plugin state'); } })());
    check('C: resolve throws with the available ids', (() => { try { resolve('sleeve', 'nope'); return false; } catch (e) { return e.message.includes('carry-dispersion'); } })());
    check('C: resolveOrNull returns null instead of throwing', resolveOrNull('sleeve', 'nope') === null);
    registerPlugin('risk', capBandRisk, { state: 'LIVE', defaultStack: true });
    registerPlugin('sleeve', toptraderFadeSleeve, { state: 'UNTESTED' });
    check('C: activeRoster is exactly the defaultStack set',
        deepEqual([...activeRoster('risk')], ['cap-band']) && deepEqual([...activeRoster('sleeve')], []));
    const snapshotA = rosterSnapshot();
    const stackA = stackSnapshot();
    check('C: snapshots are 8-hex fingerprints', /^[0-9a-f]{8}$/.test(snapshotA) && /^[0-9a-f]{8}$/.test(stackA));
    resetRegistry();
    registerPlugin('sleeve', toptraderFadeSleeve, { state: 'UNTESTED' });
    registerPlugin('risk', capBandRisk, { state: 'LIVE', defaultStack: true });
    registerPlugin('sleeve', carryDispersionSleeve, { state: 'KEEP' });
    check('C: snapshots are registration-order independent', rosterSnapshot() === snapshotA && stackSnapshot() === stackA);
    registerPlugin('book', singleBook, { state: 'UNTESTED' });
    check('C: a non-default plugin moves the roster pin but NOT the active stack',
        rosterSnapshot() !== snapshotA && stackSnapshot() === stackA);
    check('C: report() summarises the registry', (() => { const r = report(); return r.count === 4 && r.contracts.length === 10 && /^[0-9a-f]{8}$/.test(r.rosterSnapshot); })());
    check('C: report() echoes the contract version (no hard-coded drift)', report().contractVersion === CONTRACT_VERSION);
    check('C: instantiate refuses a stateless kind', (() => { try { instantiate('sleeve', 'carry-dispersion'); return false; } catch (e) { return e.message.includes('stateless'); } })());
    resetRegistry();
    check('C: resetRegistry empties the store', registeredKinds().length === 0);

    // ---- D. primitives: exact vectors ---------------------------------------
    check('D: fingerprint is deterministic and 8 hex', fingerprint({ a: 1 }) === fingerprint({ a: 1 }) && /^[0-9a-f]{8}$/.test(fingerprint([1, 2])));
    check('D: canonical sorts object keys', canonical({ b: 2, a: 1 }) === canonical({ a: 1, b: 2 }));
    check('D: canonical distinguishes -0 from 0', canonical(-0) !== canonical(0));
    check('D: canonical walks typed arrays', canonical(new Float64Array([1, 2])) === canonical([1, 2]));
    check('D: part separation prevents collisions', fingerprint(['ab', 'c']) !== fingerprint(['a', 'bc']));
    check('D: canonical quotes/escapes strings exactly as the golden suite (JSON.stringify)',
        canonical('abc') === JSON.stringify('abc') &&
        canonical('a"b\\c\n') === JSON.stringify('a"b\\c\n') &&
        canonical('true') !== canonical(true));
    check('D: canonical renders a function as [fn] (a function\'s source must not leak into a hash)',
        canonical(function () {}) === '[fn]' && canonical({ f: () => {} }) === canonical({ f: function () {} }));

    check('D: MIN_TRAIN_PERIODS is the lab\'s ~2.3y rule (2555 8h-periods)', MIN_TRAIN_PERIODS === 2555);
    check('D: clipWeights clips and holds',
        deepEqual(clipWeights([[0.2, -0.3], [0.05, 0.4]], 0.125), [[0.125, -0.125], [0.05, 0.125]]));
    check('D: clipWeights is the identity when cap is null', deepEqual(clipWeights([[9]], null), [[9]]));
    check('D: bandWeights keeps the held weight inside the band',
        deepEqual(bandWeights([[0.5, 0], [0.52, 0.15], [0.5, 0.16]], 0.1), [[0.5, 0], [0.5, 0.15], [0.5, 0.15]]));
    check('D: bandWeights is the identity when eps is null', deepEqual(bandWeights([[0.5]], null), [[0.5]]));
    check('D: cleanBook applies the CAP first, then the band (order is load-bearing)',
        deepEqual(cleanBook([[0.1, 0], [0.5, 0]], { cap: 0.125, bandEps: 0.1 }), [[0.1, 0], [0.1, 0]]) &&
        deepEqual(bandWeights(clipWeights([[0.1, 0], [0.5, 0]], null), 0.1), [[0.1, 0], [0.5, 0]]));
    check('D: saturateWeights matches tanh at the cap level',
        near(saturateWeights([[0.125]], 0.125)[0][0], 0.125 * Math.tanh(1), 1e-12) &&
        saturateWeights([[0.2]], 0.125)[0][0] < 0.125);
    check('D: normalizeL1 sums |w| to 1 (and leaves a zero row alone)',
        near(sumAbs(normalizeL1([1, -3, 4])), 1) && deepEqual(normalizeL1([0, 0]), [0, 0]));
    check('D: sumAbs / maxAbs read the row',
        sumAbs([1, -2, 0.5]) === 3.5 && maxAbs([1, -2, 0.5]) === 2);
    check('D: turnoverSeries is the L1 change against a zero initial book',
        deepEqual(turnoverSeries([[1, 0], [0.5, 0.5], [-0.5, 0.5]]), [1, 1, 1]));
    check('D: turnoverSeries treats a non-finite / non-numeric weight as 0 (e16#turnoverSeries)',
        deepEqual(turnoverSeries([[Infinity], [1]]), [0, 1]) && deepEqual(turnoverSeries([['2']]), [0]));
    check('D: ewmaUpdate / blendRows treat a non-finite leg as 0 (the lab\'s `fin` guard)',
        deepEqual(ewmaUpdate([0, 0], [1, NaN], 0.1), [0.1, 0]) &&
        deepEqual(blendRows([1, 2], [Infinity, 0], 0.5), [0.5, 1]));

    check('D: rowRankWeights is the centred rank, normalised to sum|w| = 1',
        deepEqual(rowRankWeights([3, 1, 2, 4]), [0.125, -0.375, -0.125, 0.375]));
    check('D: rowRankWeights breaks ties by order and stays antisymmetric',
        deepEqual(rowRankWeights([1, 1, 1]), [-0.5, 0, 0.5]));
    check('D: rowLevelWeights on a symmetric panel is the exact z-normalised row',
        deepEqual(rowLevelWeights([2, 4, 6]), [-0.5, 0, 0.5]));
    check('D: crossSectionalTarget masks missing symbols, demeans and signs the row',
        deepEqual(crossSectionalTarget([1, NaN, 3, 5], -1).target, [0.5, 0, 0, -0.5]) &&
        near(sumAbs(crossSectionalTarget([1, NaN, 3, 5], -1).target), 1));
    check('D: crossSectionalTarget needs 3 present symbols (a 2-point cross-section is flat)',
        deepEqual(crossSectionalTarget([1, 2], 1).target, [0, 0]) &&
        crossSectionalTarget([1, 2], 1).present.length === 2);
    check('D: applyWeightPolicy daily / ewma / hold are exact',
        deepEqual(applyWeightPolicy([9, 9], [1, 0], { kind: 'daily' }, 0), [1, 0]) &&
        deepEqual(applyWeightPolicy([0, 0], [1, 1], { kind: 'ewma', lambda: 0.1 }, 0), [0.1, 0.1]) &&
        deepEqual(applyWeightPolicy([7, 7], [1, 1], { kind: 'hold', N: 3 }, 1), [7, 7]) &&
        deepEqual(applyWeightPolicy([7, 7], [1, 1], { kind: 'hold', N: 3 }, 3), [1, 1]));
    check('D: applyWeightPolicy rejects an unknown policy', (() => { try { applyWeightPolicy([0], [1], { kind: 'zeno' }, 0); return false; } catch (e) { return e.message.includes('zeno'); } })());
    check('D: dlogPositive is guarded to positive levels',
        near(dlogPositive([null, 4, 2], 2), Math.log(0.5), 1e-12) &&
        dlogPositive([0, -1], 1) === null && dlogPositive(null, 1) === null);
    check('D: firstCommonIndex finds the first fully-present cross-section',
        firstCommonIndex([[0, 1, 2], [0, NaN, 2], [0, 1, 2]], 3) === 2 &&
        firstCommonIndex([[0, NaN], [0, NaN]], 2) === -1);
    check('D: firstCommonIndex treats a null column as never present (no crash)',
        firstCommonIndex([[0, 1, 2], null, [0, 1, 2]], 3) === -1 &&
        firstCommonIndex([null, [0, 1, 2], [0, 1, 2]], 3) === -1);
    check('D: dlogMatrix differences each symbol against itself',
        deepEqual(dlogMatrix([[2, 4, 8]]), [[null, Math.log(2), Math.log(2)]]));
    check('D: dlogMatrix yields a null COLUMN for a symbol with no series (never throws)',
        deepEqual(dlogMatrix([null, [2, 4, 8]]), [null, [null, Math.log(2), Math.log(2)]]) &&
        deepEqual(dlogMatrix([undefined]), [null]) &&
        dlogMatrix([[2, 4, 8]])[0].every((v, i) => (i === 0 ? v === null : near(v, dlogPositive([2, 4, 8], i), 1e-12))));

    // buildFundingBook: a hand-computed two-symbol book. The funding row FLIPS
    // between t0 and t1 while t1..t3 agree, so the weights prove the target is
    // read from the previous period (row 0 is [−0.5, 0.5], rows 1+ are its mirror).
    const fundingView = {
        times: ['T0', 'T1', 'T2', 'T3'],
        fRate: [[-1e-3, 1e-3], [1e-3, -1e-3], [1e-3, -1e-3], [1e-3, -1e-3]],
        basisPnl: [[0, 0], [0, 0], [0, 0], [0, 0]],
    };
    const fundingBook = buildFundingBook({ ...fundingView, targetFn: rowRankWeights, policy: { kind: 'daily', normalize: true } });
    check('D: buildFundingBook targets the PREVIOUS period and earns the current one',
        fundingBook.weightRows.length === 3 && deepEqual(fundingBook.weightRows[0], [-0.5, 0.5]) &&
        deepEqual(fundingBook.weightRows[2], [0.5, -0.5]) &&
        deepEqual(fundingBook.rets, [-1e-3, 1e-3, 1e-3]) && deepEqual(fundingBook.bookTimes, ['T1', 'T2', 'T3']));
    check('D: buildFundingBook normalises after the policy (a constant target gives constant rows under EWMA)',
        deepEqual(
            buildFundingBook({ ...fundingView, fRate: [[1e-3, -1e-3], [1e-3, -1e-3], [1e-3, -1e-3], [1e-3, -1e-3]], targetFn: rowRankWeights, policy: { kind: 'ewma', lambda: 0.5, normalize: true } }).weightRows,
            [[0.5, -0.5], [0.5, -0.5], [0.5, -0.5]],
        ));

    // buildCrossSectionalBook: a hand-computed three-symbol book (NEXT = 1).
    const csTimes = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const csSig = [[0, 1, 2, 3, 4, 5, 6, 7], [0, 0, 0, 0, 0, 0, 0, 0], [0, 2, 4, 6, 8, 10, 12, 14]];
    const csSpot = csTimes.map((_, i) => [i * 0.01, 0.02, -0.03]);
    const csBook = buildCrossSectionalBook({ sig: csSig, spotRet: csSpot, times: csTimes, NEXT: 1, from: 1, sign: 1, policy: { kind: 'daily' } });
    check('D: buildCrossSectionalBook maps a demeaned row to a signed book and the forward return',
        csBook.weightRows.length === 6 && deepEqual(csBook.weightRows[0], [0, -0.5, 0.5]) &&
        near(csBook.rets[0], -0.5 * 0.02 + 0.5 * -0.03, 1e-12) && deepEqual(csBook.bookTimes.slice(0, 2), ['T1', 'T2']));
    check('D: buildCrossSectionalBook sign flips the book',
        deepEqual(buildCrossSectionalBook({ sig: csSig, spotRet: csSpot, times: csTimes, NEXT: 1, from: 1, sign: -1, policy: { kind: 'daily' } }).weightRows[0], [0, 0.5, -0.5]));
    check('D: buildCrossSectionalBook holds a partial cross-section flat (fewer than 3 present)',
        deepEqual(buildCrossSectionalBook({ sig: [[1, 1], [2, 2], [NaN, NaN]], spotRet: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], times: ['a', 'b', 'c', 'd'], NEXT: 1, from: 1, sign: 1 }).weightRows[0], [0, 0, 0]));
    check('D: buildCrossSectionalBook masks a `null` signal column like a wholly-missing symbol', (() => {
        const csSpot4 = csTimes.map((_, i) => [i * 0.01, 0.02, -0.03, -i * 0.02]);
        const sig4 = [
            [0, 1, 2, 3, 4, 5, 6, 7],
            null,
            [0, 2, 4, 6, 8, 10, 12, 14],
            [0, 3, 6, 9, 12, 15, 18, 21],
        ];
        const opts = { spotRet: csSpot4, times: csTimes, NEXT: 1, from: 1, sign: 1, policy: { kind: 'daily' } };
        const nullCol = buildCrossSectionalBook({ ...opts, sig: sig4 });
        const nanCol = buildCrossSectionalBook({ ...opts, sig: [sig4[0], new Array(8).fill(NaN), sig4[2], sig4[3]] });
        return nullCol.weightRows.length > 0 && nullCol.weightRows[0][1] === 0 &&
            near(sumAbs(nullCol.weightRows[0]), 1) &&
            deepEqual(nullCol.weightRows, nanCol.weightRows) && deepEqual(nullCol.rets, nanCol.rets);
    })());
    check('D: blendBooks renormalises a 50/50 blend',
        (() => {
            const blended = blendBooks({ weightRows: [[0.5, -0.5, 0]], bookTimes: ['T'] }, { weightRows: [[0.25, 0.25, -0.5]], bookTimes: ['T'] });
            return near(sumAbs(blended.weightRows[0]), 1) && near(blended.weightRows[0][0], 0.5, 1e-12) && near(blended.weightRows[0][2], -1 / 3, 1e-12);
        })());
    check('D: blendBooks treats a non-finite second leg as 0 (the same `fin` guard as blendRows)',
        (() => {
            const b = blendBooks({ weightRows: [[1, 0]], bookTimes: ['T'] }, { weightRows: [[Infinity, 0]], bookTimes: ['T'] });
            const A = [[0.5, -0.5, 0], [0, 0.25, -0.75]];
            const B = [[0.25, 0.25, -0.5], [-0.1, 0.4, 0.1]];
            return b.weightRows[0].every(Number.isFinite) && near(b.weightRows[0][0], 1) && b.weightRows[0][1] === 0 &&
                deepEqual(
                    blendBooks({ weightRows: A, bookTimes: [] }, { weightRows: B, bookTimes: [] }, 0.5).weightRows,
                    A.map((row, i) => normalizeL1(blendRows(row, B[i], 0.5))),
                );
        })());
    check('D: the two book shells phase a `hold` policy on the SAME per-row counter (row 0 rebases, row 1 holds)',
        (() => {
            const fund = buildFundingBook({
                times: ['T0', 'T1', 'T2', 'T3', 'T4'],
                fRate: [[0, 1], [1, 0], [1, 0], [0, 1], [0, 1]],
                basisPnl: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
                targetFn: rowRankWeights,
                policy: { kind: 'hold', N: 2 },
            });
            const xs = buildCrossSectionalBook({
                sig: [[0, 1, 0, 2, 0, 0], [0, 0, 0, 0, 0, 0], [0, 3, 0, 5, 0, 0]],
                spotRet: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
                times: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'], from: 1, NEXT: 1, sign: 1, policy: { kind: 'hold', N: 2 },
            });
            return fund.weightRows.length === 4 && xs.weightRows.length === 4 &&
                deepEqual(fund.weightRows[1], fund.weightRows[0]) && !deepEqual(fund.weightRows[2], fund.weightRows[0]) &&
                deepEqual(xs.weightRows[1], xs.weightRows[0]) && !deepEqual(xs.weightRows[2], xs.weightRows[0]);
        })());

    // ---- E. the sleeves ------------------------------------------------------
    const fadeTimes = ['T0', 'T1', 'T2', 'T3', 'T4'];
    const fadeSpot = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0.01, 0.02, 0.03], [0, 0, 0]];
    const fadeView = {
        times: fadeTimes,
        topLS: [[10, 10, 10, 10, 10], [5, 5, 5, 5, 5], [0, 0, 0, 0, 0]],
        spotRet: fadeSpot,
        from: 1,
    };
    const fadeRows = toptraderFadeSleeve.signal(fadeView);
    check('E: toptrader-fade IMPLEMENTS the sleeve contract', validatePlugin(CONTRACTS.sleeve, toptraderFadeSleeve).ok === true);
    check('E: toptrader-fade FADES the crowded side (the highest ratio is shorted)',
        deepEqual(fadeRows[0], [-0.125, 0, 0.125]));
    check('E: toptrader-fade caps every |w| at 1/8',
        fadeRows.every((row) => maxAbs(row) <= 0.125 + 1e-12) && fadeRows.every((row) => sumAbs(row) <= 1 + 1e-12));
    check('E: toptrader-fade earns the forward return from its own `from` offset',
        near(toptraderFadeSleeve.returns(fadeView, fadeRows)[0], -0.125 * 0.01 + 0.125 * 0.03, 1e-12));
    check('E: toptrader-fade pins lambda at 0.05 with no band', TOPTRADER_FADE_SPEC.policy.lambda === 0.05 && TOPTRADER_FADE_SPEC.bandEps === null && TOPTRADER_FADE_SPEC.cap === 0.125);
    check('E: toptrader-fade needs a topLS panel', (() => { try { toptraderFadeSleeve.signal({}); return false; } catch (e) { return e.message.includes('topLS'); } })());
    check('E: toptrader-fade returns no book when no full cross-section exists',
        deepEqual(toptraderFadeSleeve.signal({ topLS: [[NaN, NaN], [NaN, NaN], [NaN, NaN]], spotRet: fadeSpot, times: fadeTimes }), []));

    const carryView = {
        times: ['T0', 'T1', 'T2', 'T3', 'T4'],
        fRate: [[0, 0, 0], [1e-4, 0, -1e-4], [1e-4, 0, -1e-4], [1e-4, 0, -1e-4], [1e-4, 0, -1e-4]],
        basisPnl: [[0, 0, 0], [0.01, 0.01, 0.01], [0.01, 0.01, 0.01], [0.01, 0.01, 0.01], [0.01, 0.01, 0.01]],
    };
    const carryRows = carryDispersionSleeve.signal(carryView);
    check('E: carry-dispersion IMPLEMENTS the sleeve contract', validatePlugin(CONTRACTS.sleeve, carryDispersionSleeve).ok === true);
    check('E: carry-dispersion ranks the funding cross-section and caps it',
        carryRows.length === 4 && maxAbs(carryRows[0]) <= 0.125 + 1e-12 && sumAbs(carryRows[0]) <= 1 + 1e-12 &&
        carryRows[0][2] > 0 && carryRows[0][0] < 0);
    check('E: carry-dispersion pins the pinned spec (ewma 0.02, cap 1/8, no band)',
        CARRY_DISPERSION_SPEC.policy.lambda === 0.02 && CARRY_DISPERSION_SPEC.cap === 0.125 && CARRY_DISPERSION_SPEC.bandEps === null &&
        CARRY_DISPERSION_SPEC.minTrainPeriods === MIN_TRAIN_PERIODS);
    check('E: carry-dispersion earns basis + funding from the held row',
        near(carryDispersionSleeve.returns(carryView, carryRows)[0], carryRows[0].reduce((a, x, j) => a + x * (0.01 + [1e-4, 0, -1e-4][j]), 0), 1e-12));
    check('E: carry-dispersion needs the funding legs', (() => { try { carryDispersionSleeve.signal({ times: ['a'] }); return false; } catch (e) { return e.message.includes('fRate'); } })());

    const oiView = {
        times: ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'],
        oiValue: [[100, 110, 121, 133.1, 146.41, 161.051], [100, 100, 100, 100, 100, 100], [100, 90, 81, 72.9, 65.61, 59.049]],
        spotRet: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
        from: 1,
    };
    const oiRows = oiChangeSleeve.signal(oiView);
    check('E: oi-change IMPLEMENTS the sleeve contract', validatePlugin(CONTRACTS.sleeve, oiChangeSleeve).ok === true);
    check('E: oi-change is a 50/50 blend of two EWMA books, renormalised, with NO cap',
        oiRows.length === 4 && near(sumAbs(oiRows[0]), 1) && maxAbs(oiRows[0]) > 0.125);
    check('E: oi-change pins eps = 0.03 and no cap', OI_CHANGE_SPEC.bandEps === 0.03 && OI_CHANGE_SPEC.cap === null && OI_CHANGE_SPEC.policies.length === 2);
    check('E: oi-change needs the OI panel', (() => { try { oiChangeSleeve.signal({ times: ['a'] }); return false; } catch (e) { return e.message.includes('oiValue'); } })());
    check('E: the sleeve `returns` uses the SAME clamped start as the builder (a `from: 0` caller is not off by one)',
        (() => {
            const times = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
            const zeros = [0, 0, 0];
            const ones = [1, 1, 1, 1, 1, 1];
            const spotRet = [zeros, zeros, zeros, [1, 0, 0], zeros, zeros];
            const fadeView = { topLS: [[0, 1, 0, 2, 0, 0], zeros, [0, 3, 0, 5, 0, 0]], spotRet, times, from: 0 };
            const fadeRows = toptraderFadeSleeve.signal(fadeView);
            const fadeR = toptraderFadeSleeve.returns(fadeView, fadeRows);
            const oiView = { oiValue: [[1, 10, 10, 100, 100, 100], ones, [1, 1, 100, 100, 100, 100]], spotRet, times, from: 0 };
            const oiRows = oiChangeSleeve.signal(oiView);
            const oiR = oiChangeSleeve.returns(oiView, oiRows);
            return fadeRows.length === 4 && oiRows.length === 4 &&
                Math.abs(fadeRows[0][0]) > 1e-9 && near(fadeR[0], fadeRows[0][0], 1e-12) &&
                Math.abs(oiRows[0][0]) > 1e-9 && near(oiR[0], oiRows[0][0], 1e-12);
        })());

    // ---- F. the risk + book layer -------------------------------------------
    check('F: cap-band IMPLEMENTS the risk contract', validatePlugin(CONTRACTS.risk, capBandRisk).ok === true);
    check('F: cap-band clamps the position to +/-1 and abstains on a non-finite input',
        capBandRisk.position(0.4) === 0.4 && capBandRisk.position(-3) === -1 && capBandRisk.position(3) === 1 && capBandRisk.position(NaN) === 0);
    check('F: cap-band applies a dead zone (no trade below it)',
        capBandRisk.position(0.02, { deadZone: 0.05 }) === 0 && capBandRisk.position(-0.02, { deadZone: 0.05 }) === 0 && capBandRisk.position(0.2, { deadZone: 0.05 }) === 0.2);
    check('F: cap-band carries the per-sleeve specs as data',
        deepEqual(CAP_BAND_SPECS['carry-dispersion'], { cap: 0.125, bandEps: null }) &&
        deepEqual(CAP_BAND_SPECS['toptrader-fade'], { cap: 0.125, bandEps: null }) &&
        deepEqual(CAP_BAND_SPECS['oi-change'], { cap: null, bandEps: 0.03 }));
    check('F: cap-band applyForSleeve uses the registered spec and rejects an unknown sleeve',
        deepEqual(capBandRisk.applyForSleeve([[0.2, 0], [0.5, 0]], 'carry-dispersion'), [[0.125, 0], [0.125, 0]]) &&
        (() => { try { capBandRisk.applyForSleeve([[0]], 'nope'); return false; } catch { return true; } })());
    check('F: cap-band applyToWeights needs a spec', (() => { try { capBandRisk.applyToWeights([[0.2]]); return false; } catch { return true; } })());

    resetRegistry();
    check('F: single book composes exactly one sleeve at weight 1',
        validatePlugin(CONTRACTS.book, singleBook).ok === true &&
        deepEqual(singleBook.compose([{ rows: [[0.5, 0.5]], times: ['T0'] }]).weightRows, [[0.5, 0.5]]));
    check('F: single book rejects a second sleeve or an unweighted entry',
        (() => { try { singleBook.compose([{ rows: [[0]] }, { rows: [[0]] }]); return false; } catch { return true; } })() &&
        (() => { try { singleBook.compose([{ rows: [[0]], weight: 0.5 }]); return false; } catch { return true; } })());
    const splitAB = [
        { rows: [[1, 0], [0, 1], [1, 0]], times: ['T0', 'T1', 'T2'], weight: 0.5 },
        { rows: [[2, 2], [4, 4]], times: ['T1', 'T2'], weight: 0.5 },
    ];
    check('F: fixed-split composes on the INTERSECTION of the sleeves\' times',
        (() => { const b = fixedSplitBook.compose(splitAB); return deepEqual(b.bookTimes, ['T1', 'T2']) && deepEqual(b.weightRows, [[1, 1.5], [2.5, 2]]) && deepEqual(b.weights, [0.5, 0.5]); })());
    check('F: fixed-split defaults to equal capital',
        deepEqual(fixedSplitBook.compose([
            { rows: [[1, 0], [0, 1]], times: ['T0', 'T1'] },
            { rows: [[0, 1], [1, 0]], times: ['T0', 'T1'] },
        ]).weightRows, [[0.5, 0.5], [0.5, 0.5]]));
    check('F: fixed-split rejects weights that do not sum to 1',
        (() => { try { fixedSplitBook.compose([{ rows: [[1]], times: ['T0'], weight: 0.6 }, { rows: [[1]], times: ['T0'], weight: 0.6 }]); return false; } catch { return true; } })());
    check('F: fixed-split rejects a row-count mismatch when there are no times',
        (() => { try { fixedSplitBook.compose([{ rows: [[1], [1]] }, { rows: [[1]] }]); return false; } catch { return true; } })());
    check('F: commonTimeIndexes reports the shared grid', (() => {
        const { keep, times } = commonTimeIndexes(splitAB);
        return deepEqual(times, ['T1', 'T2']) && deepEqual(keep, [[1, 0], [2, 1]]);
    })());
    check('F: fixed-split rejects an empty entry list', (() => { try { fixedSplitBook.compose([]); return false; } catch { return true; } })());

    // ---- G. the composition root --------------------------------------------
    resetRegistry();
    const installed = installDefaultStack({ replace: true });
    check('G: installDefaultStack registers every declared plugin', deepEqual(installed, [...PLUGIN_IDS]) && installed.length === 7);
    check('G: the default roster is exactly the legacy learner',
        deepEqual([...activeRoster('learner')], ['legacy-hivemind']) &&
        ['sleeve', 'book', 'risk'].every((kind) => activeRoster(kind).length === 0));
    check('G: every default-stack plugin satisfies its contract',
        DEFAULT_STACK.every((entry) => validatePlugin(CONTRACTS[entry.kind], entry.plugin).ok));
    check('G: every sleeve/book/risk plugin lands UNTESTED or LIVE, never EXPERIMENTAL',
        DEFAULT_STACK.every((entry) => PLUGIN_STATES.includes(entry.state)));
    check('G: the registry ids match the plugin manifest',
        deepEqual([...ids('sleeve')], ['carry-dispersion', 'oi-change', 'toptrader-fade']) &&
        deepEqual([...ids('book')], ['fixed-split', 'single']) &&
        deepEqual([...ids('risk')], ['cap-band']) &&
        deepEqual([...ids('learner')], ['legacy-hivemind']));
    check('G: the legacy adapter is a learner factory with the engine defaults',
        (() => {
            const entry = resolve('learner', 'legacy-hivemind');
            return entry.capability === CAPABILITIES.MODEL && entry.defaultStack === true &&
                validateInstance(CONTRACTS.learner, { fit() {}, predict() {} }).length === 0 &&
                legacyHivemindLearner.defaults === LEGACY_HIVEMIND_DEFAULTS &&
                LEGACY_HIVEMIND_DEFAULTS.ensembleSize === 3 && LEGACY_HIVEMIND_DEFAULTS.forceMin === true;
        })());
    check('G: instantiating the legacy adapter without a state dir throws its own guard (no silent NaN)',
        (() => { try { instantiate('learner', 'legacy-hivemind'); return false; } catch (e) { return e.message.includes('directoryPath'); } })());

    // ---- H. the import law ---------------------------------------------------
    const readFile = resolveReader();
    const listFiles = resolveLister();
    if (readFile) {
        const files = new Map();
        for (const rel of LAW_FILES) {
            try { files.set(rel, await readFile(rel)); } catch (e) { files.set(rel, null); }
        }
        const unreadable = [...files].filter(([, text]) => text == null).map(([rel]) => rel);
        check('H: every core/plugin file is readable', unreadable.length === 0, unreadable.join(','));

        const violations = [];
        const engineImporters = [];
        for (const [file, text] of files) {
            if (text == null) continue;
            const specs = importSpecifiers(text).map((spec) => resolveSpecifier(file, spec));
            if (specs.includes(ENGINE_IMPORT_ALLOWED)) engineImporters.push(file);
            for (const target of specs) {
                const bare = !target.startsWith('src/');
                if (bare) {
                    if (!BARE_ALLOWED.test(target) && target !== 'better-sqlite3') violations.push(`${file}: bare "${target}"`);
                    continue;
                }
                if (isCoreContract(file) && !isCoreContract(target)) violations.push(`${file}: contracts must import only contracts (-> ${target})`);
                else if (isCorePrimitive(file) && !(isCoreContract(target) || isCorePrimitive(target))) violations.push(`${file}: primitives must import only contracts/primitives (-> ${target})`);
                else if (isCore(file) && !isCore(target)) violations.push(`${file}: core must not import outside core (-> ${target})`);
                else if (isPlugin(file) && file !== 'src/plugins/index.js') {
                    const allowed = isCoreContract(target) || isCorePrimitive(target);
                    const legacyBridge = file === LEGACY_ADAPTER && target === ENGINE_IMPORT_ALLOWED;
                    if (!allowed && !legacyBridge) violations.push(`${file}: a plugin may import only contracts/primitives (+ the legacy adapter's engine) (-> ${target})`);
                }
                if (isPlugin(file) && isPlugin(target) && file !== 'src/plugins/index.js') violations.push(`${file}: plugins must not import each other (-> ${target})`);
                if (isPlugin(file) && target.startsWith('src/analysis/')) violations.push(`${file}: plugins must not import the analysis gate (-> ${target})`);
                if (isLegacy(file) && isCore(target)) violations.push(`${file}: the legacy tree must not import core (-> ${target})`);
            }
            if (file === 'src/core/contracts/base.js' && specs.length !== 0) violations.push(`${file}: the contract kernel must have zero imports`);
        }
        check('H: the import law holds for every file', violations.length === 0, violations.slice(0, 6).join(' | '));
        check('H: exactly one plugin file bridges to the legacy engine', deepEqual(engineImporters, [LEGACY_ADAPTER]), engineImporters.join(','));

        if (listFiles) {
            const listed = (await listFiles()).filter((p) => (isCore(p) || isPlugin(p)) && p.endsWith('.js'));
            const missing = listed.filter((p) => !LAW_FILES.includes(p));
            check('H: no unlisted file exists under core/ or plugins/', missing.length === 0, missing.join(','));
        } else {
            check('H: complete file listing checked (no lister available — manifest only)', true, 'no listFiles');
        }
    } else {
        check('H: import law checked (no reader available — skipped)', true, 'no readFile');
    }

    // ---- I. the one-view rule ------------------------------------------------
    const viewA = { times: ['T0', 'T1'], candles: [{ close: 1 }, { close: 2 }], symbols: ['a'] };
    check('I: viewIdentity reads rows/times/symbols and their length',
        (() => { const id = viewIdentity(viewA); return id.n === 2 && id.times[1] === 'T1' && id.symbols[0] === 'a'; })());
    check('I: the same view fingerprints equally', sameView(viewA, { ...viewA }) && viewFingerprint(viewA) === viewFingerprint({ ...viewA }));
    check('I: a perturbed row changes the identity', !sameView(viewA, { ...viewA, candles: [{ close: 1 }, { close: 2.0001 }] }));
    check('I: assertOneView passes on an identical view and throws on a different one',
        assertOneView(viewA, { ...viewA }) === true &&
        (() => { try { assertOneView(viewA, { ...viewA, times: ['T0'] }); return false; } catch (e) { return e.message.includes('one-view rule'); } })());
    check('I: metadata outside the identity does not change it', sameView(viewA, { ...viewA, labels: [1, 0], params: { window: 3 } }));

    // ---- J. the lock register's V2 section -----------------------------------
    check('J: the core lock-registry entries are valid in isolation',
        validateRegistry(CORE_REGISTRY, { label: 'core' }).length === 0,
        validateRegistry(CORE_REGISTRY, { label: 'core' }).join(' | '));
    const exportProblems = [];
    for (const [mod, names] of Object.entries(CORE_MODULES)) {
        const actual = CORE_IMPORTS[mod];
        if (!actual) { exportProblems.push(`${mod}:not-imported`); continue; }
        const listed = new Set(names);
        for (const name of names) if (actual[name] === undefined) exportProblems.push(`${mod}:${name}`);
        for (const name of Object.keys(actual)) {
            if (name === 'default' || name === 'then') continue;
            if (!listed.has(name)) exportProblems.push(`${mod}:${name}:unregistered`);
        }
    }
    check('J: every core module is imported, every listed export exists and no export is unregistered',
        exportProblems.length === 0, exportProblems.join(','));
    check('J: every core registry entry names a known proving test',
        Object.values(CORE_REGISTRY).every((e) => Array.isArray(e.proves) && e.proves.length > 0 && e.proves.every((t) => KNOWN_TESTS.includes(t))));
    check('J: every core registry entry carries a resolvable citation and a real note',
        Object.values(CORE_REGISTRY).every((e) => e.citations.every((c) => !!CITATIONS[c]) && e.note.length > 200));
    check('J: the plugin register does not drift from the composition root', (() => {
        const declared = DEFAULT_STACK.map((entry) => `${entry.kind}:${entry.plugin.id}`).sort();
        const registered = Object.keys(PLUGIN_REGISTRY).sort();
        return declared.length === registered.length && declared.every((k, i) => k === registered[i]) &&
            DEFAULT_STACK.every((entry) => {
                const row = PLUGIN_REGISTRY[`${entry.kind}:${entry.plugin.id}`];
                return row.kind === entry.kind && row.state === entry.state && row.defaultStack === entry.defaultStack;
            });
    })());
    check('J: every plugin register entry is a valid state with a proof and a citation',
        Object.values(PLUGIN_REGISTRY).every((e) => PLUGIN_STATES.includes(e.state) &&
            e.proves.every((t) => KNOWN_TESTS.includes(t)) && e.citations.every((c) => !!CITATIONS[c]) && e.note.length > 80));
    check('J: the legacy adapter is registered as LIVE in the default stack and proved by its own entry',
        PLUGIN_REGISTRY['learner:legacy-hivemind'].state === 'LIVE' &&
        PLUGIN_REGISTRY['learner:legacy-hivemind'].defaultStack === true &&
        PLUGIN_REGISTRY['learner:legacy-hivemind'].proves.includes('legacy_hivemind.test.js'));
    check('J: the un-promoted sleeves land UNTESTED (never EXPERIMENTAL, never default)',
        ['sleeve:carry-dispersion', 'sleeve:toptrader-fade', 'sleeve:oi-change', 'book:fixed-split']
            .every((k) => PLUGIN_REGISTRY[k].state === 'UNTESTED' && PLUGIN_REGISTRY[k].defaultStack === false));
    check('J: the lock levels used by the core section are the real ones',
        Object.values(CORE_REGISTRY).every((e) => Object.values(LOCK_LEVELS).includes(e.status)));

    // ---- K. the sleeve composition (round 40) --------------------------------
    // The driver-side composer is the only place that calls sleeve -> book ->
    // risk -> gate together (the import law forbids every other placement), so
    // this section proves the chain, not the parts: the scored book is exactly
    // the sleeve's own P&L through the pinned risk spec, and the G2/A2/A18
    // readouts ride beside it.
    const kW = [[0.5, -0.5], [0.4, -0.4], [0.6, -0.6], [-0.2, 0.2]];
    const kR = [[0.01, 0.02], [0.02, -0.01], [-0.01, 0.03], [0.02, 0.01]];
    const kDot = scoreBook(kW, kR, { costBps: 0 });
    const kPre = scoreBookReturns(bookReturns(kW, kR), kW, { costBps: 0 });
    check('K: scoreBookReturns is the scoreBook arithmetic on a precomputed gross series',
        kDot && kPre && deepEqual(kDot, kPre));
    check('K: scoreBookReturns rejects a non-finite gross, an empty gross and ragged weights',
        scoreBookReturns([0.1, NaN], [[1], [1]]) === null &&
        scoreBookReturns([], []) === null &&
        scoreBookReturns([0.1, 0.2], [[1]]) === null);
    check('K: the composer resolves exactly the three registered sleeves and throws on an unknown id',
        deepEqual([...SLEEVE_IDS], ['carry-dispersion', 'toptrader-fade', 'oi-change']) &&
        resolveSleeve('carry-dispersion') === carryDispersionSleeve &&
        (() => { try { resolveSleeve('nope'); return false; } catch (e) { return e.message.includes('known:'); } })());
    const kCarryView = {
        fRate: [[0.01, 0.03, 0.02], [0.02, 0.01, 0.03], [0.03, 0.02, 0.01], [0.01, 0.02, 0.03], [0.02, 0.03, 0.01], [0.03, 0.01, 0.02]],
        basisPnl: [[0.001, -0.002, 0.001], [0.002, 0.001, -0.001], [-0.001, 0.002, 0.001], [0.001, 0.001, 0.002], [0.002, -0.001, 0.001], [-0.002, 0.001, 0.002]],
        times: [0, 1, 2, 3, 4, 5],
    };
    const kCarry = scoreSleeve('carry-dispersion', kCarryView, { costBps: 0 });
    check('K: the carry sleeve scores through the pinned chain (single book + cap-band)',
        kCarry.available === true && kCarry.weightRows.length === 5 &&
        kCarry.weightRows.every((row) => row.every((x) => Math.abs(x) <= 0.125 + 1e-12)) &&
        deepEqual(kCarry.net, carryDispersionSleeve.returns(kCarryView,
            capBandRisk.applyForSleeve(singleBook.compose([{ rows: carryDispersionSleeve.signal(kCarryView), weight: 1 }]).weightRows, 'carry-dispersion'))));
    const kCarry10 = scoreSleeve('carry-dispersion', kCarryView, { costBps: 10 });
    check('K: sleeve costs are monotone (net@10 <= net@0) and the turnover is the book turnover',
        kCarry10.available === true && kCarry10.netSharpe <= kCarry.netSharpe + 1e-12 &&
        near(kCarry.turnover, bookTurnover(kCarry.weightRows)));
    const kCarryPanel = scoreSleeve('carry-dispersion', kCarryView, {
        costBps: 0,
        panel: [[0.01, 0.02, 0.01, -0.01, 0.02], [0.02, 0.01, -0.02, 0.01, 0.01]],
    });
    check('K: the neutral Sharpe is NaN without a panel and finite beside one',
        Number.isNaN(kCarry.neutralSharpe) && kCarry.panelStreams === 0 &&
        Number.isFinite(kCarryPanel.neutralSharpe) && kCarryPanel.panelStreams === 2);
    const kFadeView = {
        topLS: [[1.2, 1.1, 1.3, 1.0, 1.2, 1.1, 1.4, 1.2], [0.9, 1.0, 0.8, 1.1, 0.9, 1.0, 0.9, 1.1], [1.0, 1.2, 1.1, 1.3, 1.0, 1.2, 1.0, 0.9]],
        spotRet: [[0.01, -0.01, 0.02], [0.02, 0.01, -0.01], [-0.01, 0.02, 0.01], [0.01, 0.01, 0.02], [0.02, -0.02, 0.01], [-0.02, 0.01, 0.02], [0.01, 0.02, -0.01], [0.02, 0.01, 0.01], [-0.01, -0.01, 0.02], [0.01, 0.02, 0.01], [0.02, -0.01, -0.02], [-0.01, 0.01, 0.01]],
        times: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    };
    const kFade = scoreSleeve('toptrader-fade', kFadeView, {});
    check('K: the fade sleeve scores and respects its 12.5% cap',
        kFade.available === true && kFade.weightRows.length > 0 &&
        kFade.weightRows.every((row) => row.every((x) => Math.abs(x) <= 0.125 + 1e-12)) &&
        deepEqual(kFade.net, toptraderFadeSleeve.returns(kFadeView,
            capBandRisk.applyForSleeve(singleBook.compose([{ rows: toptraderFadeSleeve.signal(kFadeView), weight: 1 }]).weightRows, 'toptrader-fade'))));
    const kOiView = {
        oiValue: [[100, 102, 101, 103, 105, 104, 106, 108], [200, 198, 202, 201, 199, 203, 205, 204], [150, 151, 149, 152, 150, 153, 151, 154]],
        spotRet: kFadeView.spotRet,
        times: kFadeView.times,
    };
    const kOi = scoreSleeve('oi-change', kOiView, {});
    check('K: the OI sleeve scores through its 50/50 blend + band chain',
        kOi.available === true && kOi.weightRows.length > 0 &&
        deepEqual(kOi.net, oiChangeSleeve.returns(kOiView,
            capBandRisk.applyForSleeve(singleBook.compose([{ rows: oiChangeSleeve.signal(kOiView), weight: 1 }]).weightRows, 'oi-change'))));
    check('K: an empty sleeve (no placeable rows) is unavailable, not a throw',
        (() => {
            const r = scoreSleeve('toptrader-fade', { topLS: [null, null], spotRet: [], times: [] }, {});
            return r.available === false && typeof r.reason === 'string';
        })());
    const kLong = scoreSleeve('toptrader-fade', {
        topLS: kFadeView.topLS.map((s) => [...s, ...s, ...s]),
        spotRet: [...kFadeView.spotRet, ...kFadeView.spotRet, ...kFadeView.spotRet],
        times: kFadeView.times.map((t) => t),
    }, {});
    check('K: the A18 stress readouts ride on the scored book (finite halves, finite worst block)',
        kLong.available === true && Number.isFinite(kLong.stress.first) && Number.isFinite(kLong.stress.second) &&
        Number.isFinite(kLong.stress.min) && Number.isFinite(kLong.worstBlock));

    // ---- K2. the carry view builder (round 42) -------------------------------
    // Parsed funding rows + exact spot closes -> the aligned R8 panel. The rank
    // change is a PARTIAL rotation (B/C swap, A pinned top): an exact-mirror
    // rank reversal is a fixed point of the normalized EWMA (per-row L1
    // renormalization resets the magnitude, so a mirrored target can never
    // cross zero), while partial churn — the production case with 8 symbols —
    // drifts the weights normally.
    const kGrid = 28_800_000;
    const kT0 = 1_700_000_000_000 - (1_700_000_000_000 % kGrid);
    const kN = 40;
    const kFlip = 10;
    const kCloses = (start, rets) => {
        const out = [];
        let p = start;
        for (let i = 0; i <= rets.length; i++) {
            out.push({ timestamp: kT0 + i * kGrid, close: p });
            if (i < rets.length) p *= (1 + rets[i]);
        }
        return out;
    };
    const kRets = [];
    for (let i = 0; i < kN; i++) kRets.push(i % 2 ? 0.01 : -0.005);
    const kRateA = (i) => 0.0001;
    const kRateB = (i) => (i < kFlip ? 0.0005 : 0.0008);
    const kRateC = (i) => (i < kFlip ? 0.0008 : 0.0005);
    const kRowsA = [];
    const kRowsB = [];
    const kRowsC = [];
    for (let i = 0; i < kN; i++) {
        kRowsA.push({ timestamp: kT0 + i * kGrid, fundingRate: kRateA(i), markPrice: 100 + i });
        kRowsB.push({ timestamp: kT0 + i * kGrid, fundingRate: kRateB(i), markPrice: 200 - i });
        kRowsC.push({ timestamp: kT0 + i * kGrid, fundingRate: kRateC(i), markPrice: 300 + i });
    }
    kRowsA.push({ timestamp: kT0 + 2 * kGrid + 4 * 3_600_000, fundingRate: 0.0002, markPrice: 102.5 });
    const kStreams = () => ([
        { fundingRows: kRowsA, spotCloses: kCloses(100, kRets) },
        { fundingRows: kRowsB, spotCloses: kCloses(200, kRets.map((r) => -r)) },
        { fundingRows: kRowsC, spotCloses: kCloses(300, kRets.map((r) => r / 2)) },
    ]);
    const kView = buildCarrySleeveView({ streams: kStreams() });
    check('K2: the builder aligns the common grid and SUMS sub-grid funding rows into their bucket',
        kView.buckets === kN && kView.streams === 3 && kView.times.length === kN &&
        near(kView.fRate[2][0], 0.0001 + 0.0002, 1e-12) && near(kView.fRate[2][1], 0.0005, 1e-12) && near(kView.fRate[2][2], 0.0008, 1e-12));
    check('K2: the builder intersects to common buckets and reads exact-boundary spot legs per stream',
        (() => {
            const cut = buildCarrySleeveView({ streams: [{ ...kStreams()[0] }, { fundingRows: kRowsB.slice(1), spotCloses: kCloses(200, kRets.map((r) => -r)) }, kStreams()[2]] });
            const shifted = buildCarrySleeveView({ streams: [{ fundingRows: kRowsA, spotCloses: kCloses(100, kRets).map((c) => ({ ...c, timestamp: c.timestamp + 1 })) }, kStreams()[1], kStreams()[2]] });
            const colA = shifted.basisPnl.map((row) => row[0]);
            const colBC = shifted.basisPnl.slice(1).map((row) => row[1]).concat(shifted.basisPnl.slice(1).map((row) => row[2]));
            return cut.buckets === kN - 1 && colA.every((x) => x === null) && colBC.every((x) => x !== null);
        })());
    check('K2: the built view scores end-to-end with turnover and a finite break-even',
        (() => {
            const s = scoreSleeve('carry-dispersion', kView, { costBps: 4 });
            return s.available === true && s.turnover > 0 && Number.isFinite(s.breakEvenCostBps) &&
                s.gross.length === s.weightRows.length && s.spec === carryDispersionSleeve.spec;
        })());
    check('K2: the legs are separated (basisPnl is spot-minus-perp only, funding lives in fRate alone)',
        (() => {
            const v = buildCarrySleeveView({ streams: kStreams() });
            const srets = [kRets, kRets.map((r) => -r), kRets.map((r) => r / 2)];
            const mbase = [100, 200, 300];
            const mdir = [1, -1, 1];
            for (let i = 1; i < v.times.length; i++) {
                for (let j = 0; j < 3; j++) {
                    if (j === 0 && (i === 2 || i === 3)) continue;
                    const b = v.basisPnl[i][j];
                    if (b === null) return false;
                    const spot = srets[j][i - 1];
                    const perp = (mbase[j] + mdir[j] * i) / (mbase[j] + mdir[j] * (i - 1)) - 1;
                    if (Math.abs(b - (spot - perp)) > 1e-9) return false;
                }
            }
            return true;
        })());
    check('K2: a zero mark is missing data, never a price (no fabricated +-100% basis)',
        (() => {
            const zeroMark = (base, dir) => {
                const rows = [];
                for (let i = 0; i < 5; i++) rows.push({ timestamp: kT0 + i * kGrid, fundingRate: 0.0001, markPrice: i === 2 ? 0 : base + dir * i });
                return rows;
            };
            const v = buildCarrySleeveView({
                streams: [
                    { fundingRows: zeroMark(100, 1), spotCloses: kCloses(100, [0.001, 0.001, 0.001, 0.001, 0.001]) },
                    { fundingRows: zeroMark(200, -1), spotCloses: kCloses(200, [0.001, 0.001, 0.001, 0.001, 0.001]) },
                ],
            });
            return v.buckets === 5 && v.basisPnl[2].every((x) => x === null) &&
                v.basisPnl[3].every((x) => x === null) &&
                v.basisPnl[1].every((x) => x !== null && Math.abs(x) < 0.05) &&
                v.basisPnl[4].every((x) => x !== null && Math.abs(x) < 0.05);
        })());

    // ---- K3. the `--sleeve` run-mode core (round 44) ---------------------------
    // File TEXTS in, the G2 report object out: the CLI only reads files and
    // writes the report, everything scored lives here. Only carry-dispersion
    // runs on shipped data; the positioning sleeves land available:false.
    const kFundText = (fn) => {
        const rows = [];
        for (let i = 0; i < 40; i++) rows.push(JSON.stringify({ timestamp: kT0 + i * kGrid, fundingRate: fn(i), markPrice: 100 + i }));
        return rows.join('\n');
    };
    const kCandleText = (start, rets) => {
        let p = start;
        const rows = [];
        for (let i = 0; i <= rets.length; i++) {
            rows.push(JSON.stringify({ timestamp: new Date(kT0 + i * kGrid - 3_600_000).toISOString(), close: p }));
            if (i < rets.length) p *= (1 + rets[i]);
        }
        return rows.join('\n');
    };
    const kFundTexts = [kFundText(() => 0.0001), kFundText((i) => (i < 10 ? 0.0005 : 0.0008)), kFundText((i) => (i < 10 ? 0.0008 : 0.0005))];
    const kCandleTexts = [kCandleText(100, kRets), kCandleText(200, kRets.map((r) => -r)), kCandleText(300, kRets.map((r) => r / 2))];
    check('K3: texts parse to the common grid with full marks and a clean basis',
        (() => {
            const p = parseSleeveInputs({ fundingTexts: kFundTexts, candleTexts: kCandleTexts });
            return p.streams === 3 && p.buckets === 40 && p.nullBasisFraction < 0.05 && p.markedFraction === 1 &&
                p.view.times.length === 40 && p.view.fRate[0].every((x) => Number.isFinite(x));
        })());
    check('K3: the report scores the book with G5 knobs and a printable summary',
        (() => {
            const r = runSleeveReport({ sleeveId: 'carry-dispersion', fundingTexts: kFundTexts, candleTexts: kCandleTexts, costBps: 4 });
            const text = formatSleeveReport(r);
            return r.available === true && r.buckets === 40 && r.turnoverAnnual > 0 && Number.isFinite(r.breakEvenCostBps) &&
                Array.isArray(r.g5knobs) && r.g5knobs.length > 0 && r.g5verdict === false &&
                text.includes('carry-dispersion') && text.includes('G5 verdict false');
        })());
    check('K3: unknown sleeves and positioning sleeves are unavailable, not throws',
        (() => {
            const u = runSleeveReport({ sleeveId: 'nope', fundingTexts: kFundTexts, candleTexts: kCandleTexts });
            const f = runSleeveReport({ sleeveId: 'toptrader-fade', fundingTexts: kFundTexts, candleTexts: kCandleTexts });
            const o = runSleeveReport({ sleeveId: 'oi-change', fundingTexts: kFundTexts, candleTexts: kCandleTexts });
            return u.available === false && f.available === false && o.available === false &&
                typeof u.reason === 'string' && typeof f.reason === 'string' &&
                formatSleeveReport(f).includes('unavailable');
        })());
    check('K3: ragged inputs are unavailable with a reason (empty funding, mismatched lists)',
        (() => {
            const e = runSleeveReport({ sleeveId: 'carry-dispersion', fundingTexts: [''], candleTexts: kCandleTexts.slice(0, 1) });
            const m = runSleeveReport({ sleeveId: 'carry-dispersion', fundingTexts: kFundTexts, candleTexts: kCandleTexts.slice(0, 1) });
            return e.available === false && m.available === false &&
                typeof e.reason === 'string' && typeof m.reason === 'string';
        })());
    check('K2: the builder rejects an empty stream list and scores an empty intersection as no view',
        (() => {
            let threw = false;
            try { buildCarrySleeveView({ streams: [] }); } catch { threw = true; }
            const noCommon = buildCarrySleeveView({
                streams: [
                    { fundingRows: [{ timestamp: kT0, fundingRate: 0.001, markPrice: 1 }], spotCloses: [] },
                    { fundingRows: [{ timestamp: kT0 + kGrid, fundingRate: 0.001, markPrice: 1 }], spotCloses: [] },
                ],
            });
            return threw && noCommon.buckets === 0 && noCommon.fRate.length === 0;
        })());

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
