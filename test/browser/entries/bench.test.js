// Micro-benchmark for the HiveMind hot path. Run inside a Worker via
// test/browser/harness.js. Reports per-operation wall time plus counters for
// the global Math primitives the neural core leans on, so we can see where a
// training step actually spends its budget.

import { __ensureSql } from '../shims/better-sqlite3.js';
import HiveMind from '../../../src/hivemind/hiveMind.js';

const counters = { random: 0, exp: 0, sqrt: 0, pow: 0, log: 0, abs: 0, max: 0, min: 0 };
let counting = false;

function instrument() {
    const wrap = (name) => {
        const orig = Math[name];
        Math[name] = function (...args) {
            if (counting) counters[name]++;
            return orig.apply(Math, args);
        };
    };
    for (const k of Object.keys(counters)) wrap(k);
}

async function timeAsync(fn, n) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t0) / n;
}

export async function run() {
    await __ensureSql();
    instrument();

    const ES = 64;
    const IS = 125;
    const D = 'state/bench';
    const inputs = Array.from({ length: IS }, (_, i) => ((i * 37) % 101) / 100);
    const inputs2 = Array.from({ length: IS }, (_, i) => ((i * 53 + 7) % 101) / 100);

    const out = {};

    let t0 = performance.now();
    const hm = new HiveMind(D, ES, IS, 'bench', true);
    out.constructMs = +(performance.now() - t0).toFixed(1);

    hm.predict(inputs);
    const p0ms = await timeAsync(() => hm.predict(inputs), 20);
    out.predictMs = +p0ms.toFixed(2);

    for (let i = 0; i < 5; i++) hm.train(inputs, 1);

    counting = true;
    for (const k of Object.keys(counters)) counters[k] = 0;
    const tTrain = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) hm.train(i % 2 ? inputs : inputs2, i % 3 ? 1 : 0);
    const trainMs = (performance.now() - tTrain) / N;
    counting = false;
    out.trainMs = +trainMs.toFixed(2);
    out.countersPerTrain = {};
    for (const k of Object.keys(counters)) out.countersPerTrain[k] = Math.round(counters[k] / N);

    counting = true;
    for (const k of Object.keys(counters)) counters[k] = 0;
    const tPred = performance.now();
    const P = 50;
    for (let i = 0; i < P; i++) hm.predict(i % 2 ? inputs : inputs2);
    out.predictMs2 = +((performance.now() - tPred) / P).toFixed(2);
    counting = false;
    out.countersPerPredict = {};
    for (const k of Object.keys(counters)) out.countersPerPredict[k] = Math.round(counters[k] / P);

    const tB = performance.now();
    for (let i = 0; i < 20; i++) hm.broadcastMemory(inputs, 0.025);
    out.broadcastMs = +((performance.now() - tB) / 20).toFixed(2);

    const broad = hm.broadcastMemory(inputs, 0.025);
    const tT = performance.now();
    for (let i = 0; i < 20; i++) hm.translateMemory(broad.memories, inputs, 0.025);
    out.translateMs = +((performance.now() - tT) / 20).toFixed(2);

    return out;
}
