// src/analysis/reality_check/bootstrap/tests.js (round-107 split of src/analysis/reality_check/bootstrap.js).
// The RC/SPA/step-down tests on the shared draws.
// Moved byte-exact (spaCore gains export for inter-part use, not re-exported by the shim);
// re-exported by the bootstrap.js shim.
import { DEFAULT_RC_CONFIG, relativePerformance, safeRatio } from './inputs.js';
import { bootstrapRelativeMeans, bootstrapStdErrors, studentizedBoot } from './resampling.js';
export function whiteRealityCheck({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });

    const root = Math.sqrt(T);
    let best = 0;
    for (let k = 1; k < K; k++) if (fbar[k] > fbar[best]) best = k;
    const stat = root * fbar[best];

    const bootStats = new Float64Array(nBoot);
    let exceed = 0;
    for (let b = 0; b < nBoot; b++) {
        const row = fbarBoot[b];
        let mx = -Infinity;
        for (let k = 0; k < K; k++) {
            const d = row[k] - fbar[k];
            if (d > mx) mx = d;
        }
        const vb = root * mx;
        bootStats[b] = vb;
        if (vb > stat) exceed++;
    }
    return {
        statistic: stat,
        pValue: exceed / nBoot,
        nBoot,
        blockLength: bl,
        bestIndex: best,
        bestMean: fbar[best],
        means: Array.from(fbar),
        bootStats,
    };
}

export function hansenSpa({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });

    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    // "Upper" recentring: every candidate keeps its own mean (Hansen 2005's
    // least-favourable, most conservative member of the family).
    const core = spaCore(fbar, fbarBoot, omega, fbar, nBoot, K);
    return {
        statistic: core.statistic,
        pValue: core.pValue,
        nBoot,
        blockLength: bl,
        bestIndex: core.bestIndex,
        bestT: core.bestT,
        standardErrors: Array.from(omega),
        means: Array.from(fbar),
        bootStats: core.bootStats,
    };
}

// The bootstrap standard error of each strategy's mean, estimated from the same
// stationary draws (rather than an i.i.d. sample standard deviation) so it is
// robust to serial dependence — this is what makes the SPA statistic
// HAC-consistent.

export function spaCore(fbar, fbarBoot, omega, recentring, nBoot, K) {
    let stat = 0;
    let best = 0;
    let bestT = -Infinity;
    for (let k = 0; k < K; k++) {
        const t = safeRatio(fbar[k], omega[k]);
        if (t > bestT) { bestT = t; best = k; }
        if (t > stat) stat = t;
    }
    const tBoot = studentizedBoot(fbarBoot, recentring, omega, nBoot, K);
    const bootStats = new Float64Array(nBoot);
    let exceed = 0;
    for (let b = 0; b < nBoot; b++) {
        const off = b * K;
        let mx = 0;
        for (let k = 0; k < K; k++) {
            const v = tBoot[off + k];
            if (v > mx) mx = v;
        }
        bootStats[b] = mx;
        if (mx > stat) exceed++;
    }
    return { statistic: stat, pValue: exceed / nBoot, bestIndex: best, bestT, bootStats, tBoot };
}

// Hansen (2005) consistent recentring. A candidate whose sample mean relative to
// the benchmark is more than A_k = omega_k * sqrt(2 * log(log(T))) below zero is
// "too poor to be asymptotically relevant" and is recentred to zero; every other
// candidate keeps its own mean. The log-log bound is what makes the test
// *consistent*: it vanishes as T grows (so a genuinely bad candidate is
// eventually recentred out, restoring power) but shrinks more slowly than the
// sampling error (so a real local alternative keeps its edge). Matches the
// reference implementation in `arch.bootstrap.multiple_comparison.SPA`
// (`threshold = -sqrt((variances/t) * 2 * log(log(t)))`).

export function consistentRecentring(fbar, omega, T) {
    if (!Number.isInteger(T) || T < 3) {
        throw new Error('reality_check: T must be an integer >= 3 for the log-log bound');
    }
    if (!fbar || !omega || fbar.length !== omega.length) {
        throw new Error('reality_check: fbar and omega must be equal-length arrays');
    }
    const bound = Math.sqrt(2 * Math.log(Math.log(T)));
    const K = fbar.length;
    const recentring = new Float64Array(K);
    for (let k = 0; k < K; k++) {
        const A = omega[k] * bound;
        recentring[k] = fbar[k] >= -A ? fbar[k] : 0;
    }
    return { recentring, bound };
}

// Hansen's *consistent* SPA: identical to `hansenSpa` except the recentring is
// the consistent one above. When every candidate is close to the benchmark the
// two coincide exactly (all candidates are "valid"); when many candidates are
// far below it, the consistent recentring removes their noise from the null
// maximum, so `pValue <= hansenSpa(...).pValue` — the intended gain in power.

export function hansenSpaConsistent({ returnsMatrix, benchmark, nBoot, blockLength, seed } = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });
    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    const { recentring, bound } = consistentRecentring(fbar, omega, T);
    const core = spaCore(fbar, fbarBoot, omega, recentring, nBoot, K);
    return {
        statistic: core.statistic,
        pValue: core.pValue,
        nBoot,
        blockLength: bl,
        bestIndex: core.bestIndex,
        bestT: core.bestT,
        standardErrors: Array.from(omega),
        means: Array.from(fbar),
        recentring: Array.from(recentring),
        logLogBound: bound,
        bootStats: core.bootStats,
    };
}

// Romano & Wolf (2005) step-down max-t on the SAME stationary-bootstrap draws as
// the SPA family above, with Hansen's consistent recentring. The single-step SPA
// answers "does the family contain an edge?"; the step-down answers WHICH
// candidates carry it while keeping the family-wise error rate at alpha.
// Candidates are processed in descending observed t and the reference maximum is
// recomputed over the still-active (not-yet-rejected) candidates only, so a
// candidate is compared against the best of its peers rather than against the
// whole family. By the StepM property the step p-values are monotone down that
// order, so the first candidate that fails stops the procedure: once it is not
// significant, no smaller statistic can be. The first step is therefore EXACTLY
// the single-step consistent SPA (same draws, same max-with-0, same recentring),
// which is why the two always agree on whether the family rejects anything — the
// step-down only ever adds the identity of the rejected candidates.

export function romanoWolfStepM({
    returnsMatrix, benchmark, nBoot, blockLength, seed, alpha = 0.05,
} = {}) {
    ({ benchmark = 0, nBoot, blockLength, seed } = { ...DEFAULT_RC_CONFIG, benchmark, nBoot, blockLength, seed });
    if (!(typeof alpha === 'number' && alpha > 0 && alpha < 1)) {
        throw new Error('reality_check: alpha must be in (0,1)');
    }
    const { rel, T, K } = relativePerformance(returnsMatrix, benchmark);
    const { fbar, fbarBoot, blockLength: bl } = bootstrapRelativeMeans(rel, { nBoot, blockLength, seed, T, K });
    const omega = bootstrapStdErrors(fbar, fbarBoot, nBoot, K);
    const { recentring, bound } = consistentRecentring(fbar, omega, T);

    const tStats = new Float64Array(K);
    for (let k = 0; k < K; k++) tStats[k] = safeRatio(fbar[k], omega[k]);
    const order = Array.from({ length: K }, (_, k) => k).sort((a, c) => tStats[c] - tStats[a]);
    const tBoot = studentizedBoot(fbarBoot, recentring, omega, nBoot, K);

    const stepPValues = new Float64Array(K).fill(1);
    const rejected = new Array(K).fill(false);
    const active = new Array(K).fill(true);
    let nRejected = 0;
    for (let j = 0; j < K; j++) {
        const idx = order[j];
        const threshold = tStats[idx];
        if (!(threshold > 0)) break;
        let exceed = 0;
        for (let b = 0; b < nBoot; b++) {
            const off = b * K;
            let mx = 0;
            for (let k = 0; k < K; k++) {
                if (!active[k]) continue;
                const v = tBoot[off + k];
                if (v > mx) mx = v;
            }
            if (mx > threshold) exceed++;
        }
        const p = exceed / nBoot;
        stepPValues[idx] = p;
        if (p <= alpha) {
            rejected[idx] = true;
            active[idx] = false;
            nRejected++;
        } else {
            break;
        }
    }

    const bootStats = new Float64Array(nBoot);
    for (let b = 0; b < nBoot; b++) {
        const off = b * K;
        let mx = 0;
        for (let k = 0; k < K; k++) {
            const v = tBoot[off + k];
            if (v > mx) mx = v;
        }
        bootStats[b] = mx;
    }

    return {
        alpha,
        order,
        tStats: Array.from(tStats),
        stepPValues: Array.from(stepPValues),
        rejected,
        rejectedIndices: rejected.reduce((acc, r, k) => { if (r) acc.push(k); return acc; }, []),
        nRejected,
        bestIndex: order[0],
        bestT: tStats[order[0]],
        means: Array.from(fbar),
        standardErrors: Array.from(omega),
        recentring: Array.from(recentring),
        logLogBound: bound,
        nBoot,
        blockLength: bl,
        bootStats,
        T,
        K,
    };
}
