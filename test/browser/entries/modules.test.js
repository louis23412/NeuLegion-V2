// Structural suite for the HiveMind / HiveMindController component splits.
//
// The behavioural suites (sanity / core / indicators / features / legion) and the
// golden suite exercise the assembled classes; this one pins the *assembly*
// itself: every method named in test/component-manifest.js must be installed on
// the class prototype exactly once, as a non-enumerable own property that is the
// very function exported by its component bag, and nothing else may leak onto
// the prototype. That makes the mixin wiring (and any future re-split) fail
// loudly instead of silently dropping a method into an undefined call site.
//
// It also checks the guard rails in internal/mixins.js: installing a duplicate
// key or a non-method value must throw.

import HiveMind from '../../../src/hivemind/hiveMind.js';
import HiveMindController from '../../../src/hivemind/hiveMindController.js';
import { installMethods } from '../../../src/hivemind/internal/mixins.js';
import {
    COMPONENTS, CLASS_API, TOTAL_INSTALLED,
    CONTROLLER_COMPONENTS, CONTROLLER_CLASS_API, CONTROLLER_TOTAL_INSTALLED,
} from '../../component-manifest.js';

import { activationMethods } from '../../../src/hivemind/kernels/activations.js';
import { linalgMethods } from '../../../src/hivemind/kernels/linalg.js';
import { normalizationMethods } from '../../../src/hivemind/kernels/normalization.js';
import { samplingMethods } from '../../../src/hivemind/kernels/sampling.js';
import { statisticsMethods } from '../../../src/hivemind/kernels/statistics.js';
import { loadStateMethods } from '../../../src/hivemind/persistence/load.js';
import { saveStateMethods } from '../../../src/hivemind/persistence/save.js';
import { dimensionMethods } from '../../../src/hivemind/persistence/dimensions.js';
import { lshMethods } from '../../../src/hivemind/memory/lsh.js';
import { protoMethods } from '../../../src/hivemind/memory/protos.js';
import { replayMethods } from '../../../src/hivemind/memory/replay.js';
import { retrievalMethods } from '../../../src/hivemind/memory/retrieval.js';
import { consolidationMethods } from '../../../src/hivemind/memory/consolidation.js';
import { bankMethods } from '../../../src/hivemind/memory/banks.js';
import { attentionMethods } from '../../../src/hivemind/transformer/attention.js';
import { forwardMethods } from '../../../src/hivemind/transformer/forward.js';
import { hiveStateMethods } from '../../../src/hivemind/ensemble/hiveState.js';
import { scoreMethods } from '../../../src/hivemind/ensemble/scores.js';
import { gradientMethods } from '../../../src/hivemind/training/gradients.js';
import { distillationMethods } from '../../../src/hivemind/training/distillation.js';
import { transferMethods } from '../../../src/hivemind/knowledge/transfer.js';
import { diagnosticsMethods } from '../../../src/hivemind/internal/diagnostics.js';

import { controllerDatabaseMethods } from '../../../src/hivemind/controller/database.js';
import { controllerAccuracyMethods } from '../../../src/hivemind/controller/accuracy.js';
import { controllerCandleMethods } from '../../../src/hivemind/controller/candles.js';
import { controllerFeatureMethods } from '../../../src/hivemind/controller/features.js';
import { controllerTradeMethods } from '../../../src/hivemind/controller/trades.js';

const HIVEMIND_BAGS = {
    activations: activationMethods,
    linalg: linalgMethods,
    normalization: normalizationMethods,
    sampling: samplingMethods,
    statistics: statisticsMethods,
    loadState: loadStateMethods,
    saveState: saveStateMethods,
    dimensions: dimensionMethods,
    lsh: lshMethods,
    protos: protoMethods,
    replay: replayMethods,
    retrieval: retrievalMethods,
    consolidation: consolidationMethods,
    banks: bankMethods,
    attention: attentionMethods,
    forward: forwardMethods,
    hiveState: hiveStateMethods,
    scores: scoreMethods,
    gradients: gradientMethods,
    distillation: distillationMethods,
    transfer: transferMethods,
    diagnostics: diagnosticsMethods,
};

const CONTROLLER_BAGS = {
    controllerDatabase: controllerDatabaseMethods,
    controllerAccuracy: controllerAccuracyMethods,
    controllerCandle: controllerCandleMethods,
    controllerFeature: controllerFeatureMethods,
    controllerTrade: controllerTradeMethods,
};

// Shared assembly assertions, run once per split class.
function checkAssembly(check, { label, Class, bags, components, classApi, totalInstalled }) {
    // 1. Each bag exports exactly the methods the manifest claims.
    for (const [name, expected] of Object.entries(components)) {
        const bag = bags[name];
        if (!bag) { check(`${label}: bag ${name} exists`, false, 'no bag imported for this manifest entry'); continue; }
        const keys = Object.keys(bag);
        check(`${label}: bag ${name} matches manifest`,
            keys.length === expected.length && expected.every((m, i) => keys[i] === m),
            `expected [${expected.join(', ')}], got [${keys.join(', ')}]`);
    }
    check(`${label}: no unlisted bag`, Object.keys(bags).length === Object.keys(components).length,
        `${Object.keys(bags).length} bags vs ${Object.keys(components).length} manifest entries`);

    // 2. Every method is installed on the prototype as a non-enumerable own
    //    property holding the exact function from its bag.
    const missing = [];
    const wrongRef = [];
    const enumerable = [];
    for (const [name, expected] of Object.entries(components)) {
        const bag = bags[name];
        if (!bag) continue;
        for (const method of expected) {
            if (!Object.prototype.hasOwnProperty.call(Class.prototype, method)) { missing.push(method); continue; }
            const desc = Object.getOwnPropertyDescriptor(Class.prototype, method);
            if (desc.value !== bag[method]) wrongRef.push(method);
            if (desc.enumerable) enumerable.push(method);
        }
    }
    check(`${label}: every manifest method is installed`, missing.length === 0, `missing: ${missing.join(', ')}`);
    check(`${label}: installed methods are the bag function references`, wrongRef.length === 0, `mismatched: ${wrongRef.join(', ')}`);
    check(`${label}: installed methods are non-enumerable`, enumerable.length === 0, `enumerable: ${enumerable.join(', ')}`);

    // 3. Nothing extra leaks onto the prototype: constructor + class API +
    //    exactly the installed methods, no more.
    const own = Object.getOwnPropertyNames(Class.prototype);
    const expectedOwn = ['constructor', ...classApi, ...Object.values(components).flat()];
    const extra = own.filter((n) => !expectedOwn.includes(n));
    const absent = expectedOwn.filter((n) => !own.includes(n));
    check(`${label}: prototype own-property set is exactly as expected`, extra.length === 0 && absent.length === 0,
        `extra: [${extra.join(', ')}] absent: [${absent.join(', ')}]`);
    check(`${label}: installed method count is ${totalInstalled}`, totalInstalled === Object.values(components).flat().length,
        String(totalInstalled));
    check(`${label}: prototype has no duplicate methods`,
        new Set(own).size === own.length,
        `duplicates: ${own.filter((n, i) => own.indexOf(n) !== i).join(', ')}`);

    // 4. The class body keeps the public API; the bags never provide it.
    for (const name of classApi) {
        check(`${label}: class API ${name}() is not provided by a bag`,
            typeof Class.prototype[name] === 'function' && !Object.values(components).flat().includes(name),
            name);
    }
}

export async function run() {
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    checkAssembly(check, {
        label: 'hivemind',
        Class: HiveMind,
        bags: HIVEMIND_BAGS,
        components: COMPONENTS,
        classApi: CLASS_API,
        totalInstalled: TOTAL_INSTALLED,
    });

    checkAssembly(check, {
        label: 'controller',
        Class: HiveMindController,
        bags: CONTROLLER_BAGS,
        components: CONTROLLER_COMPONENTS,
        classApi: CONTROLLER_CLASS_API,
        totalInstalled: CONTROLLER_TOTAL_INSTALLED,
    });

    // 5. installMethods guard rails.
    class Dummy {}
    installMethods(Dummy, { ok () { return 1; } });
    check('installMethods installs a method', typeof Dummy.prototype.ok === 'function' && !Object.getOwnPropertyDescriptor(Dummy.prototype, 'ok').enumerable);
    installMethods(Dummy, { ok2 () { return 2; } }, { assertCount: 1 });
    check('installMethods honours assertCount', typeof Dummy.prototype.ok2 === 'function');
    let threw = false;
    try { installMethods(Dummy, { ok () { return 3; } }); } catch { threw = true; }
    check('installMethods throws on duplicate key', threw);
    threw = false;
    try { installMethods(Dummy, { bad: 42 }); } catch { threw = true; }
    check('installMethods throws on non-method value', threw);
    threw = false;
    try { installMethods(Dummy, { a () {}, b () {} }, { assertCount: 1 }); } catch { threw = true; }
    check('installMethods throws on assertCount mismatch', threw);

    return {
        total: checks.length,
        failed: checks.filter((c) => !c.pass).length,
        failures: checks.filter((c) => !c.pass),
        checks,
    };
}
