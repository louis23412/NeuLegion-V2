// Live-reader upgrade suite (C3: multiprobes + query-mod wired into
// `_retrieveTopRelevantProtos`, the LIVE scored reader).
//
// The margin-ordered multi-probe (Lv et al., VLDB 2007) and dynamic query
// modification (Claydon, Connor & Dearle, arXiv 2605.23807) were previously
// consulted only by `_getGlobalLSHCandidates`, whose caller (`broadcastMemory`)
// feeds the signal payload — never the scored position (BUGS.md #44). C3 wires
// both into the reader the model actually scores through, behind the same
// default-off flags (`_multiProbeConfig`, `_queryModConfig`), so with both
// null the probe results are bit-identical to before.
//
// Tiers (all on real forceMin HiveMinds, seeded RNG):
//   A. OFF = IDENTICAL — fresh flags are null; twin instances (same seed,
//      both flags null) produce identical predict trajectories and identical
//      reader outputs on the same query (the golden-safety half).
//   B. MULTIPROBE LIVE — with `_multiProbeConfig` set, aggregate recall of
//      seeded noisy neighbours is >= the stock random-level reader, and the
//      margin-probe branch provably executes (bucket-get counts differ from
//      the stock path under identical seeds — output equality is expected,
//      see the saturation note below).
//   C. QUERYMOD LIVE — same bar for `_queryModConfig` rounds (recall >= stock,
//      re-hash path executes); exact queries are recovered by every arm.
//   D. DETERMINISM — pristine twin instances with the same flag set return
//      identical reader outputs (run before any battery mutates access counts
//      via `_reinforceProto`).
//
// Comparison discipline (CYCLE-205 fix): every cross-instance comparison is by
// VALUE (exact mean+size fingerprints), never by reference. Separate HiveMind
// instances own distinct proto objects, so `includes`/`===` across instances
// is always false — the original revision compared that way and failed 6/13
// with `off=0/48`. Likewise each read clones its query proto: the reader
// caches `projNorms` onto the passed object, so sharing one query object
// across instances would pin the first instance's projections.
//
// Like the other entries this takes an optional `{ ensureSql, stateDir }` so the
// node mirror can run against the real better-sqlite3 driver and a temp dir.

import HiveMind from '../../../src/hivemind/hiveMind.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const ES = 2, IS = 8, STEPS = 32, BATTERY = 48, SIGMA = 0.35;
const MP_CFG = { maxFlips: 3, budget: 200 };
const QM_CFG = { alpha: 1, topK: 8, rounds: 2, maxFlips: 2, probeBudget: 16 };

const inputs8 = (s) => Array.from({ length: IS }, (_, i) => Math.sin(s * 1.7 + i * 0.9) * 0.6);

export async function run(options = {}) {
    if (options.ensureSql) await options.ensureSql();
    else {
        const shim = await import('../shims/better-sqlite3.js');
        await shim.__ensureSql();
    }
    const stateDir = options.stateDir || ((label) => `state/livereader-${label}`);
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
    const realRandom = Math.random;
    const seeded = (seed, fn) => {
        Math.random = mulberry32(seed);
        try { return fn(); } finally { Math.random = realRandom; }
    };

    const build = (label, seed) => seeded(seed, () => {
        const hm = new HiveMind(stateDir(label), ES, IS, label, true);
        hm._gradientResetFrequency = 1;
        for (let s = 0; s < STEPS; s++) {
            seeded(seed * 31 + s, () => { hm.train(inputs8(s), s % 2); });
        }
        return hm;
    });

    const fp = (p) => `${Array.from(p.mean, (v) => String(v)).join(',')}|${String(p.size)}`;
    const bankOf = (hm) => {
        const out = [];
        for (let t = 0; t < hm._ensembleSize; t++) {
            const sem = hm._semanticProtos[t];
            if (sem) for (const p of sem) out.push(p);
        }
        return out;
    };
    const readFp = (hm, mean, variance, seed) => seeded(seed, () => hm._retrieveTopRelevantProtos(
        0, [{ mean: mean.slice(), variance: variance.slice(), size: 1 }], 200).map(fp));
    const sameFp = (a, b) => a.length === b.length && a.every((f, i) => f === b[i]);

    // ---- A. off = identical --------------------------------------------------
    const hmA = build('A_off', 501);
    check('A: upgrade flags default to null', hmA._multiProbeConfig === null && hmA._queryModConfig === null);
    const hmB = build('B_off', 501);
    const traj = (hm) => seeded(502, () => {
        const ps = [];
        for (let s = 0; s < 6; s++) ps.push(hm.predict(inputs8(100 + s)));
        return ps;
    });
    const tA = traj(hmA), tB = traj(hmB);
    check('A: twin off-instances have identical predict trajectories',
        tA.length === tB.length && tA.every((v, i) => v === tB[i]));

    const bankA = bankOf(hmA);
    check('A: training populates the semantic bank', bankA.length > 0, `protos=${bankA.length}`);
    if (bankA.length === 0) {
        const failed = checks.filter((c) => !c.pass);
        return { total: checks.length, failed: failed.length + 1, failures: failed, checks };
    }

    const arnd = mulberry32(503);
    const srcA = bankA[Math.floor(arnd() * bankA.length)];
    const meanA = Array.from(srcA.mean, (v) => v + gauss(arnd) * SIGMA);
    const varA = Array.from(srcA.variance);
    check('A: twin off-readers return identical outputs',
        sameFp(readFp(hmA, meanA, varA, 504), readFp(hmB, meanA, varA, 504)));

    // ---- D + B/C family: fresh pristine instances (seed 505), queries drawn
    // from the battery arm's own bank so every source has a value-identical
    // counterpart in each arm's bank. The battery arms are built AFTER the D
    // twins, so no battery read sees access counts mutated by a D read.
    const mk = (label, cfg) => {
        const hm = build(label, 505);
        if (cfg === 'mp') hm._multiProbeConfig = { ...MP_CFG };
        if (cfg === 'qm') hm._queryModConfig = { ...QM_CFG };
        return hm;
    };
    const hmOff = mk('D_off', null), hmOff2 = mk('D_off2', null);
    const hmMp = mk('D_mp', 'mp'), hmMp2 = mk('D_mp2', 'mp');
    const hmQm = mk('D_qm', 'qm'), hmQm2 = mk('D_qm2', 'qm');
    const bcOff = build('BC_off', 505);
    const bcMp = build('BC_mp', 505); bcMp._multiProbeConfig = { ...MP_CFG };
    const bcQm = build('BC_qm', 505); bcQm._queryModConfig = { ...QM_CFG };
    const bcBank = bankOf(bcOff);
    if (bcBank.length === 0) {
        const failed = checks.filter((c) => !c.pass);
        return { total: checks.length, failed: failed.length + 1, failures: failed, checks };
    }
    const qrnd = mulberry32(503);
    const queries = [];
    for (let q = 0; q < BATTERY && q < bcBank.length * 4; q++) {
        const src = bcBank[Math.floor(qrnd() * bcBank.length)];
        queries.push({
            srcFp: fp(src),
            mean: Array.from(src.mean, (v) => v + gauss(qrnd) * SIGMA),
            variance: Array.from(src.variance),
        });
    }
    while (queries.length < BATTERY) {
        const src = bcBank[queries.length % bcBank.length];
        queries.push({
            srcFp: fp(src),
            mean: Array.from(src.mean, (v) => v + gauss(qrnd) * SIGMA),
            variance: Array.from(src.variance),
        });
    }
    const qDetail = `bank=${bcBank.length}`;
    check('D: off arm deterministic across pristine twins',
        sameFp(readFp(hmOff, queries[1].mean, queries[1].variance, 800), readFp(hmOff2, queries[1].mean, queries[1].variance, 800)), qDetail);
    check('D: margin arm deterministic across pristine twins',
        sameFp(readFp(hmMp, queries[1].mean, queries[1].variance, 800), readFp(hmMp2, queries[1].mean, queries[1].variance, 800)), qDetail);
    check('D: querymod arm deterministic across pristine twins',
        sameFp(readFp(hmQm, queries[2].mean, queries[2].variance, 801), readFp(hmQm2, queries[2].mean, queries[2].variance, 801)), qDetail);

    // ---- B/C. battery --------------------------------------------------------
    // Saturation note: at forceMin scale the bank (<=100 protos) is fully
    // recovered by every arm's probes, so all three arms return IDENTICAL
    // candidate sets and identical outputs — output difference cannot tell a
    // consulted flag from a dead one here (both live arms measured
    // differ=0/48). Consultation is therefore proven by EXECUTION, not output:
    // each arm's bucket `.get` calls are counted during the read. Same-seed
    // reads make this decisive — an ignored flag would run the identical stock
    // path with identical draws and an identical count.
    const readCounted = (hm, mean, variance, seed) => {
        const maps = [];
        for (const setArr of hm._semanticLSHBuckets[0]) {
            for (const m of setArr) if (m && typeof m.get === 'function') maps.push(m);
        }
        const hadOwn = maps.map((m) => Object.prototype.hasOwnProperty.call(m, 'get'));
        const origs = maps.map((m) => m.get);
        let n = 0;
        maps.forEach((m, i) => {
            const orig = origs[i];
            m.get = function (k) { n++; return orig.call(this, k); };
        });
        try {
            return { fps: readFp(hm, mean, variance, seed), gets: n };
        } finally {
            maps.forEach((m, i) => {
                if (hadOwn[i]) m.get = origs[i];
                else delete m.get;
            });
        }
    };
    let offHit = 0, mpHit = 0, qmHit = 0, missing = 0;
    const bankMp = bankOf(bcMp), bankQm = bankOf(bcQm);
    for (let q = 0; q < queries.length; q++) {
        const qq = queries[q];
        if (!bcBank.some((p) => fp(p) === qq.srcFp) || !bankMp.some((p) => fp(p) === qq.srcFp) || !bankQm.some((p) => fp(p) === qq.srcFp)) missing++;
        const rO = readFp(bcOff, qq.mean, qq.variance, 600 + q);
        const rM = readFp(bcMp, qq.mean, qq.variance, 600 + q);
        const rQ = readFp(bcQm, qq.mean, qq.variance, 600 + q);
        if (rO.includes(qq.srcFp)) offHit++;
        if (rM.includes(qq.srcFp)) mpHit++;
        if (rQ.includes(qq.srcFp)) qmHit++;
    }
    check('B: battery sanity — stock reader recovers some neighbours', offHit > 0, `off=${offHit}/${BATTERY} missing=${missing}`);
    check('B: margin-probe recall >= stock recall', mpHit >= offHit, `mp=${mpHit} off=${offHit}`);
    let offGets = 0, mpGets = 0, qmGets = 0;
    for (let q = 0; q < 6; q++) {
        const qq = queries[q];
        offGets += readCounted(bcOff, qq.mean, qq.variance, 900 + q).gets;
        mpGets += readCounted(bcMp, qq.mean, qq.variance, 900 + q).gets;
        qmGets += readCounted(bcQm, qq.mean, qq.variance, 900 + q).gets;
    }
    check('B: margin flag is consulted (live probe path executes)', mpGets > 0 && offGets > 0 && mpGets !== offGets, `mpGets=${mpGets} offGets=${offGets}`);
    check('C: querymod recall >= stock recall', qmHit >= offHit, `qm=${qmHit} off=${offHit}`);
    check('C: querymod flag is consulted (re-hash path executes)', qmGets > 0 && offGets > 0 && qmGets !== offGets, `qmGets=${qmGets} offGets=${offGets}`);

    const eSrc = bcBank[0];
    const eFp = fp(eSrc);
    const eMean = Array.from(eSrc.mean), eVar = Array.from(eSrc.variance);
    check('B/C: exact queries are recovered by every arm',
        readFp(bcOff, eMean, eVar, 700).includes(eFp) &&
        readFp(bcMp, eMean, eVar, 700).includes(eFp) &&
        readFp(bcQm, eMean, eVar, 700).includes(eFp));

    const failed = checks.filter((c) => !c.pass);
    return { total: checks.length, failed: failed.length, failures: failed, checks };
}
