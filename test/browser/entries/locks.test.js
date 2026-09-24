// Lock-registry suite — the "what is proven, and by what" contract.
//
// Validates `test/lock-registry.js`:
//   1. every component bag in `test/component-manifest.js` is classified exactly
//      once (and nothing extra is classified);
//   2. each entry's status/domain/citations/proving-tests are valid, and the
//      status-specific requirements hold (LOCKED-bit-exact needs a fingerprint;
//      NEEDS-LOCAL-RUN needs a local script; etc.);
//   3. every declared research note actually exists on disk and has a heading;
//   4. the summary counts are internally consistent.
//
// This suite does not run the other suites (that is the runner's job); it makes
// the *mapping* checkable so a component can never be silently un-locked.

import {
    LOCK_LEVELS,
    DOMAINS,
    CITATIONS,
    KNOWN_TESTS,
    HIVEMIND_REGISTRY,
    CONTROLLER_REGISTRY,
    ANALYSIS_MODULES,
    ANALYSIS_REGISTRY,
    SUPPORT_MODULES,
    SUPPORT_REGISTRY,
    validateRegistry,
} from '../../lock-registry.js';
import { COMPONENTS, CONTROLLER_COMPONENTS } from '../../component-manifest.js';
import * as performanceMod from '../../../src/analysis/performance.js';
import * as splitsMod from '../../../src/analysis/splits.js';
import * as labelsMod from '../../../src/analysis/labels.js';
import * as uniquenessMod from '../../../src/analysis/uniqueness.js';
import * as backtestMod from '../../../src/analysis/backtest.js';
import * as walkforwardMod from '../../../src/analysis/walkforward.js';
import * as overfittingMod from '../../../src/analysis/overfitting.js';
import * as realityCheckMod from '../../../src/analysis/reality_check.js';
import * as dependenceMod from '../../../src/analysis/dependence.js';
import * as worldMod from '../../../src/analysis/world.js';
import * as featuresMod from '../../../src/analysis/features.js';
import * as holdingMod from '../../../src/analysis/holding.js';
import * as streamsMod from '../../../src/analysis/streams.js';
import * as replicationMod from '../../../src/analysis/replication.js';
import * as forecastMod from '../../../src/analysis/forecast.js';
import * as decisionMod from '../../../src/analysis/decision.js';
import * as raceMod from '../../../src/analysis/race.js';
import * as benchmarkMod from '../../../src/analysis/benchmark.js';
import * as carryMod from '../../../src/analysis/carry.js';
import * as pricePrecisionMod from '../../../src/price_precision.js';
import * as surpriseMod from '../../../src/hivemind/memory/surprise.js';
import * as sampleWeightsMod from '../../../src/hivemind/training/sample_weights.js';
import * as homeostasisMod from '../../../src/hivemind/ensemble/homeostasis.js';
import * as evolveMod from '../../../src/legion/evolve.js';
import * as multiprobeMod from '../../../src/hivemind/memory/multiprobe.js';
import * as binarypcMod from '../../../src/hivemind/memory/binarypc.js';
import * as bitweightMod from '../../../src/hivemind/memory/bitweight.js';
import * as querymodMod from '../../../src/hivemind/memory/querymod.js';
import * as consolidationLogicMod from '../../../src/consolidation_logic.js';
import * as candleQualityMod from '../../../src/candle_quality.js';
import * as sanitizeMod from '../../../src/legion/sanitize.js';
import * as rngMod from '../../../src/legion/rng.js';
import * as legionMetricsMod from '../../../src/observer/legion_metrics.js';
import * as alertsMod from '../../../src/observer/alerts.js';
import * as analyzeMod from '../../../src/analyze.js';

const ANALYSIS_IMPORTS = {
    'performance.js': performanceMod,
    'splits.js': splitsMod,
    'labels.js': labelsMod,
    'uniqueness.js': uniquenessMod,
    'backtest.js': backtestMod,
    'walkforward.js': walkforwardMod,
    'overfitting.js': overfittingMod,
    'reality_check.js': realityCheckMod,
    'dependence.js': dependenceMod,
    'world.js': worldMod,
    'features.js': featuresMod,
    'holding.js': holdingMod,
    'streams.js': streamsMod,
    'replication.js': replicationMod,
    'forecast.js': forecastMod,
    'decision.js': decisionMod,
    'race.js': raceMod,
    'benchmark.js': benchmarkMod,
    'carry.js': carryMod,
};

const SUPPORT_IMPORTS = {
    'price_precision.js': pricePrecisionMod,
    'surprise.js': surpriseMod,
    'sample_weights.js': sampleWeightsMod,
    'homeostasis.js': homeostasisMod,
    'evolve.js': evolveMod,
    'multiprobe.js': multiprobeMod,
    'binarypc.js': binarypcMod,
    'bitweight.js': bitweightMod,
    'querymod.js': querymodMod,
    'consolidation_logic.js': consolidationLogicMod,
    'candle_quality.js': candleQualityMod,
    'sanitize.js': sanitizeMod,
    'rng.js': rngMod,
    'legion_metrics.js': legionMetricsMod,
    'alerts.js': alertsMod,
    'analyze.js': analyzeMod,
};

const PROJECT_ROOT = import.meta.dirname
    ? import.meta.dirname.replace(/[\\/]test[\\/]browser[\\/]entries$/, '')
    : '';

function resolveReader(options) {
    if (options && typeof options.readFile === 'function') return options.readFile;
    if (globalThis.__fs && typeof globalThis.__fs.readTextFile === 'function') {
        return (p) => globalThis.__fs.readTextFile(p);
    }
    return null;
}

export async function run(options = {}) {
    const readFile = resolveReader(options);
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    // ---- A. registry is internally valid ------------------------------------
    const hmProblems = validateRegistry(HIVEMIND_REGISTRY, {
        manifestKeys: Object.keys(COMPONENTS),
        label: 'hivemind',
    });
    const ctlProblems = validateRegistry(CONTROLLER_REGISTRY, {
        manifestKeys: Object.keys(CONTROLLER_COMPONENTS),
        label: 'controller',
    });
    check('hivemind registry valid + complete', hmProblems.length === 0, hmProblems.join(' | '));
    check('controller registry valid + complete', ctlProblems.length === 0, ctlProblems.join(' | '));

    // ---- B. coverage --------------------------------------------------------
    const hmKeys = Object.keys(COMPONENTS);
    const ctlKeys = Object.keys(CONTROLLER_COMPONENTS);
    check('every hivemind bag classified', hmKeys.every((k) => HIVEMIND_REGISTRY[k]), `bags=${hmKeys.length}`);
    check('every controller bag classified', ctlKeys.every((k) => CONTROLLER_REGISTRY[k]), `bags=${ctlKeys.length}`);
    check('registry has no extra hivemind bags', Object.keys(HIVEMIND_REGISTRY).length === hmKeys.length,
        `registry=${Object.keys(HIVEMIND_REGISTRY).length} manifest=${hmKeys.length}`);
    check('registry has no extra controller bags', Object.keys(CONTROLLER_REGISTRY).length === ctlKeys.length,
        `registry=${Object.keys(CONTROLLER_REGISTRY).length} manifest=${ctlKeys.length}`);

    // ---- C. status distribution is sane -------------------------------------
    const all = [...Object.values(HIVEMIND_REGISTRY), ...Object.values(CONTROLLER_REGISTRY)];
    const byStatus = {};
    for (const e of all) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    check('every entry has a known status', all.every((e) => Object.values(LOCK_LEVELS).includes(e.status)),
        JSON.stringify(byStatus));
    check('no component is left EXPERIMENTAL in the core',
        all.filter((e) => e.status === LOCK_LEVELS.EXPERIMENTAL).length === 0,
        JSON.stringify(all.filter((e) => e.status === LOCK_LEVELS.EXPERIMENTAL).map((e) => e.note).slice(0, 3)));
    check('every LOCKED* entry names a proving test',
        all.filter((e) => e.status.startsWith('LOCKED')).every((e) => e.proves.length > 0),
        JSON.stringify(all.filter((e) => e.status.startsWith('LOCKED') && e.proves.length === 0).map((e) => e.note).slice(0, 3)));
    check('every BIT_EXACT entry names a golden fingerprint',
        all.filter((e) => e.status === LOCK_LEVELS.BIT_EXACT).every((e) => Array.isArray(e.fingerprints) && e.fingerprints.length > 0));

    // ---- D. claimed fingerprints are the real golden set ---------------------
    const GOLDEN = [
        'hm:diagnostics', 'hm:predictions', 'hm:memberCounts', 'hm:broadcast', 'hm:translate',
        'hm:postReloadPrediction', 'ctl:finalSignal', 'ctl:signalTrajectory', 'ctl:signalCount',
        'ctl:lastTrainingStep', 'ctl:accuracyTotals',
    ];
    const claimed = new Set(all.flatMap((e) => e.fingerprints || []));
    const unknown = [...claimed].filter((f) => !GOLDEN.includes(f));
    check('claimed fingerprints all exist in golden.test.js', unknown.length === 0, unknown.join(','));

    // ---- E. citations referenced exist --------------------------------------
    const usedCites = new Set(all.flatMap((e) => e.citations || []));
    check('all citation keys resolve', [...usedCites].every((c) => !!CITATIONS[c]),
        [...usedCites].filter((c) => !CITATIONS[c]).join(','));
    check('citation set is non-trivial', usedCites.size >= 8, `used=${usedCites.size}`);

    // ---- F. proving tests are known entries ---------------------------------
    const usedTests = new Set(all.flatMap((e) => e.proves || []));
    check('all proving tests are known entries', [...usedTests].every((t) => KNOWN_TESTS.includes(t)),
        [...usedTests].filter((t) => !KNOWN_TESTS.includes(t)).join(','));

    // ---- G. every NEEDS-LOCAL-RUN names its local script ---------------------
    const local = all.filter((e) => e.status === LOCK_LEVELS.NEEDS_LOCAL_RUN);
    check('NEEDS-LOCAL-RUN entries name a local script', local.every((e) => typeof e.localScript === 'string' && e.localScript.length > 0),
        local.map((e) => `${e.note.slice(0, 24)}=${e.localScript}`).join(' | '));

    // ---- H. reference-count consistency -------------------------------------
    check('hivemind registry covers all layers (>=20 bags)', Object.keys(HIVEMIND_REGISTRY).length >= 20,
        `n=${Object.keys(HIVEMIND_REGISTRY).length}`);

    // ---- J. analysis supercharges are registered + exported ------------------
    const analysisProblems = validateRegistry(ANALYSIS_REGISTRY, {
        manifestKeys: Object.keys(ANALYSIS_MODULES),
        label: 'analysis',
    });
    check('analysis registry valid + complete', analysisProblems.length === 0, analysisProblems.join(' | '));
    const missingExports = [];
    const unregisteredExports = [];
    for (const [mod, names] of Object.entries(ANALYSIS_MODULES)) {
        const actual = ANALYSIS_IMPORTS[mod];
        if (!actual) { missingExports.push(`${mod}:not-imported`); continue; }
        const listed = new Set(names);
        for (const name of names) if (actual[name] === undefined) missingExports.push(`${mod}:${name}`);
        // The other direction: an export that is NOT in the registry is a silent hole in
        // the contract (the module can grow an un-locked entry point without any check
        // noticing). The pure-analysis lists are exhaustive by convention, so this is the
        // completeness half of the same invariant.
        for (const name of Object.keys(actual)) {
            if (name === 'default' || name === 'then') continue;
            if (!listed.has(name)) unregisteredExports.push(`${mod}:${name}`);
        }
    }
    // Both directions in one check: a listed export that is missing, or an export that
    // is not listed (a silent un-locked entry point) are the same class of contract gap.
    const exportProblems = [...missingExports, ...unregisteredExports.map((e) => `${e}:unregistered`)];
    check('analysis exports are all registered and resolvable', exportProblems.length === 0, exportProblems.join(','));
    const analysisAll = Object.values(ANALYSIS_REGISTRY);
    check('analysis supercharges are LOCKED-invariant',
        analysisAll.every((e) => e.status === LOCK_LEVELS.INVARIANT),
        JSON.stringify(analysisAll.map((e) => e.status)));
    check('analysis modules prove via analysis.test.js',
        analysisAll.every((e) => e.proves.includes('analysis.test.js')));

    // ---- K. support modules (hot-path helpers) are registered + exported ------
    const supportProblems = validateRegistry(SUPPORT_REGISTRY, {
        manifestKeys: Object.keys(SUPPORT_MODULES),
        label: 'support',
    });
    check('support registry valid + complete', supportProblems.length === 0, supportProblems.join(' | '));
    const missingSupportExports = [];
    for (const [mod, names] of Object.entries(SUPPORT_MODULES)) {
        const actual = SUPPORT_IMPORTS[mod];
        if (!actual) { missingSupportExports.push(`${mod}:not-imported`); continue; }
        for (const name of names) if (actual[name] === undefined) missingSupportExports.push(`${mod}:${name}`);
    }
    check('every support export exists', missingSupportExports.length === 0, missingSupportExports.join(','));
    check('every support module proves via a dedicated entry',
        Object.values(SUPPORT_REGISTRY).every((e) => e.proves.some((t) => t.endsWith('.test.js'))));
    check('price_precision proves via its own entry',
        SUPPORT_REGISTRY['price_precision.js'].proves.includes('price_precision.test.js'));
    check('surprise proves via its own entry + the golden no-op',
        SUPPORT_REGISTRY['surprise.js'].proves.includes('surprise.test.js') &&
        SUPPORT_REGISTRY['surprise.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['surprise.js'].proves));
    check('sample_weights proves via its own entry + the golden no-op',
        SUPPORT_REGISTRY['sample_weights.js'].proves.includes('sample_weights.test.js') &&
        SUPPORT_REGISTRY['sample_weights.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['sample_weights.js'].proves));
    check('homeostasis proves via its own entry + the golden no-op',
        SUPPORT_REGISTRY['homeostasis.js'].proves.includes('homeostasis.test.js') &&
        SUPPORT_REGISTRY['homeostasis.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['homeostasis.js'].proves));
    check('evolve proves via its own entry (additive low-rank ES)',
        SUPPORT_REGISTRY['evolve.js'].proves.includes('evolve.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['evolve.js'].proves));
    check('multiprobe proves via its own entry + the golden no-op (default-off wiring)',
        SUPPORT_REGISTRY['multiprobe.js'].proves.includes('multiprobe.test.js') &&
        SUPPORT_REGISTRY['multiprobe.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['multiprobe.js'].proves));
    check('binarypc proves via its own entry (additive data-aware hashing)',
        SUPPORT_REGISTRY['binarypc.js'].proves.includes('binarypc.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['binarypc.js'].proves));
    check('bitweight proves via its own entry + the aligned-index validation (default-off wiring)',
        SUPPORT_REGISTRY['bitweight.js'].proves.includes('bitweight.test.js') &&
        SUPPORT_REGISTRY['bitweight.js'].proves.includes('lsh.test.js') &&
        SUPPORT_REGISTRY['bitweight.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['bitweight.js'].proves));
    check('querymod proves via its own entry + the golden no-op (default-off wiring)',
        SUPPORT_REGISTRY['querymod.js'].proves.includes('querymod.test.js') &&
        SUPPORT_REGISTRY['querymod.js'].proves.includes('lsh.test.js') &&
        SUPPORT_REGISTRY['querymod.js'].proves.includes('golden.test.js'),
        JSON.stringify(SUPPORT_REGISTRY['querymod.js'].proves));

    // ---- L. the LSH recall invariant is registered ---------------------------
    const lshEntry = HIVEMIND_REGISTRY.lsh;
    check('lsh bag proves the recall invariant via lsh.test.js',
        !!lshEntry && lshEntry.proves.includes('lsh.test.js'),
        JSON.stringify(lshEntry && lshEntry.proves));
    check('lsh bag cites the LSH literature (SimHash + multi-probe)',
        !!lshEntry && lshEntry.citations.includes('charikar2002') && lshEntry.citations.includes('lv2017multiprobe'),
        JSON.stringify(lshEntry && lshEntry.citations));

    // ---- I. research notes exist on disk ------------------------------------
    if (readFile) {
        const missing = [];
        const noHeading = [];
        for (const [domain, rel] of Object.entries(DOMAINS)) {
            try {
                const text = await readFile(`${PROJECT_ROOT}/${rel}`);
                if (!/^#\s/m.test(text)) noHeading.push(domain);
            } catch (e) {
                missing.push(`${domain}:${rel}`);
            }
        }
        check('every domain research note exists', missing.length === 0, missing.join(','));
        check('every domain research note has a heading', noHeading.length === 0, noHeading.join(','));
        // The index + bibliography must also exist.
        for (const extra of ['docs/research/README.md', 'docs/CITATIONS.md', 'docs/LOCKED.md']) {
            let ok = true;
            try { await readFile(`${PROJECT_ROOT}/${extra}`); } catch { ok = false; }
            check(`doc exists: ${extra}`, ok);
        }
        // The frozen-design docs are part of the contract, so they must not vanish.
        for (const extra of ['docs/DESIGN.md', 'docs/RUNBOOK.md']) {
            let ok = true;
            try { await readFile(`${PROJECT_ROOT}/${extra}`); } catch { ok = false; }
            check(`design doc exists: ${extra}`, ok);
        }
    } else {
        check('research notes checked (no reader available - skipped)', true, 'no readFile');
    }

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
