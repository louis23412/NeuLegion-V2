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
import {
    BANK_CONTRACT_METHODS, BANK_IDS, ENGINE_BANK_METHODS, TOURNAMENT_TARGETS,
    validateBank, assertBank, validateTournament,
} from '../../../src/hivemind/memory/contract.js';
import {
    DEFAULT_STACK, registerBank, hasBank, ids, resolveStack, stackDigest,
    _clearRegistryForTests,
} from '../../../src/hivemind/memory/registry.js';
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

    // ---- W4a (round 46): the MemoryBank plugin contract + registry ---------
    // DESIGN ONLY: the engine is untouched (banks stay installed method bags).
    // These checks pin the interface mechanics plus the engine grounding, so
    // V2.3's binding has a contract that already fits reality.
    const memBank = () => {
        const b = { id: 'test-bank', version: '0.1' };
        for (const m of BANK_CONTRACT_METHODS) b[m] = () => null;
        return b;
    };
    check('W4a: the contract accepts a complete bank and rejects holes',
        validateBank(memBank()).ok === true &&
        validateBank(null).ok === false &&
        validateBank({ id: 'x', version: '1' }).reasons.length === BANK_CONTRACT_METHODS.length &&
        validateBank({ ...memBank(), id: '' }).reasons.some((r) => r.includes('id')));
    check('W4a: assertBank throws naming the missing method',
        (() => {
            let msg = '';
            try { assertBank({ id: 'x', version: '1', write () {}, read () {}, decay () {}, merge () {}, consolidate () {} }); } catch (e) { msg = String(e && e.message); }
            return /contract violation/.test(msg) && /"stats"/.test(msg);
        })());
    check('W4a: the default stack is exactly the 4 engine banks in order',
        Array.isArray(DEFAULT_STACK) && DEFAULT_STACK.length === 4 &&
        DEFAULT_STACK.join(',') === BANK_IDS.join(',') &&
        DEFAULT_STACK.join(',') === 'episodic,adaptive,semantic,core');
    check('W4a: every grounded engine method exists on HiveMind.prototype',
        (() => {
            const missing = [];
            for (const [id, g] of Object.entries(ENGINE_BANK_METHODS)) {
                if (!BANK_IDS.includes(id)) missing.push(`${id}:unlisted`);
                for (const m of g.methods) {
                    if (typeof HiveMind.prototype[m] !== 'function') missing.push(`${id}:${m}`);
                }
            }
            return missing.length === 0;
        })(),
        (() => {
            const missing = [];
            for (const [id, g] of Object.entries(ENGINE_BANK_METHODS)) {
                for (const m of g.methods) {
                    if (typeof HiveMind.prototype[m] !== 'function') missing.push(`${id}:${m}`);
                }
            }
            return missing.join(',');
        })());
    check('W4a: the registry validates on entry, refuses duplicates, resolves deterministically',
        (() => {
            _clearRegistryForTests();
            const a = memBank();
            const c = { ...memBank(), id: 'second', version: '2.0' };
            registerBank(a);
            registerBank(c);
            let dup = false;
            try { registerBank(memBank()); } catch { dup = true; }
            let bad = false;
            try { registerBank({ id: 'broken' }); } catch { bad = true; }
            let unknown = false;
            try { resolveStack(['nope']); } catch { unknown = true; }
            const d1 = stackDigest(['second', 'test-bank']);
            const d2 = stackDigest(['second', 'test-bank']);
            const d3 = stackDigest(['test-bank', 'second']);
            const ok = dup && bad && unknown && hasBank('test-bank') && ids().length === 2 &&
                d1 === 'second@2.0+test-bank@0.1' && d1 === d2 && d1 !== d3;
            _clearRegistryForTests();
            return ok;
        })());
    check('W4a: the default stack resolves once its 4 banks register (digest pinned)',
        (() => {
            _clearRegistryForTests();
            for (const id of BANK_IDS) {
                const b = memBank();
                b.id = id;
                b.version = 'engine';
                registerBank(b);
            }
            const digest = stackDigest();
            const resolved = resolveStack();
            _clearRegistryForTests();
            return digest === 'episodic@engine+adaptive@engine+semantic@engine+core@engine' &&
                resolved.length === 4 && resolved.every((b, i) => b.id === BANK_IDS[i]);
        })());
    check('W4a: swapping a non-default plugin changes the digest, never the default',
        (() => {
            _clearRegistryForTests();
            for (const id of BANK_IDS) {
                const b = memBank();
                b.id = id;
                b.version = 'engine';
                registerBank(b);
            }
            const before = stackDigest();
            const alt = memBank();
            alt.id = 'ringbuf';
            alt.version = '9.9';
            registerBank(alt);
            const afterDefault = stackDigest();
            const swapped = stackDigest(['episodic', 'ringbuf', 'semantic', 'core']);
            _clearRegistryForTests();
            return before === afterDefault && swapped === 'episodic@engine+ringbuf@9.9+semantic@engine+core@engine';
        })());
    check('W4a: the tournament validator gates targets, baselines and alpha',
        validateTournament({ target: 'realised-vol', baseline: 'ewma' }).ok === true &&
        validateTournament({ target: 'direction' }).ok === false &&
        validateTournament({ target: 'regime', baseline: '' }).ok === false &&
        validateTournament({ target: 'sleeve-pnl', alpha: 2 }).ok === false &&
        TOURNAMENT_TARGETS.length === 3);

    return {
        total: checks.length,
        failed: checks.filter((c) => !c.pass).length,
        failures: checks.filter((c) => !c.pass),
        checks,
    };
}
