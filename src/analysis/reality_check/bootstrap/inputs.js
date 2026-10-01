// src/analysis/reality_check/bootstrap/inputs.js (round-107 split of src/analysis/reality_check/bootstrap.js).
// Candidate/benchmark inputs: config, benchmark series, the relative-performance matrix, the safe-ratio guard.
// Moved byte-exact; re-exported by the bootstrap.js shim.
export const DEFAULT_RC_CONFIG = Object.freeze({
    benchmark: 0,
    nBoot: 1000,
    blockLength: null, // null => floor(T^(1/3)), matching stationaryBootstrapSharpe
    seed: 1,
});

export function benchmarkSeries(benchmark, n) {
    if (benchmark == null) return new Float64Array(n);
    if (typeof benchmark === 'number') {
        if (!Number.isFinite(benchmark)) throw new Error('reality_check: benchmark must be finite');
        const out = new Float64Array(n);
        out.fill(benchmark);
        return out;
    }
    if (Array.isArray(benchmark) || ArrayBuffer.isView(benchmark)) {
        if (benchmark.length !== n) throw new Error('reality_check: benchmark length must equal the number of bars');
        const out = new Float64Array(n);
        for (let t = 0; t < n; t++) {
            const v = Number(benchmark[t]);
            if (!Number.isFinite(v)) throw new Error('reality_check: benchmark contains a non-finite value');
            out[t] = v;
        }
        return out;
    }
    throw new Error('reality_check: benchmark must be a number, a series, or null');
}

// Validate the candidate matrix and subtract the benchmark, giving the K x T
// matrix of relative performances f_{k,t} = r_{k,t} - b_t. This is the input to
// both tests; the "performance measure" here is the mean relative return, which
// is exactly what White/Hansen use (any measure whose mean is the object of
// inference works, but mean is the canonical and exactly checkable choice).

export function relativePerformance(returnsMatrix, benchmark = 0) {
    if (!Array.isArray(returnsMatrix) || returnsMatrix.length < 2) {
        throw new Error('reality_check: need at least 2 candidate strategies');
    }
    const K = returnsMatrix.length;
    const T = returnsMatrix[0] && returnsMatrix[0].length;
    if (!Number.isInteger(T) || T < 2) throw new Error('reality_check: need at least 2 bars');
    for (const row of returnsMatrix) {
        if (!Array.isArray(row) && !ArrayBuffer.isView(row)) throw new Error('reality_check: each strategy must be a return series');
        if (row.length !== T) throw new Error('reality_check: returnsMatrix must be rectangular');
    }
    const bench = benchmarkSeries(benchmark, T);
    const rel = [];
    for (let k = 0; k < K; k++) {
        const row = returnsMatrix[k];
        const out = new Float64Array(T);
        for (let t = 0; t < T; t++) {
            const v = Number(row[t]);
            if (!Number.isFinite(v)) throw new Error('reality_check: returns contain a non-finite value');
            out[t] = v - bench[t];
        }
        rel.push(out);
    }
    return { rel, T, K, benchmark: bench };
}

// One stationary-bootstrap index draw (Politis & Romano 1994): at each step a
// new geometric block starts with probability 1/blockLength, otherwise the
// cursor advances by one (wraparound). blockLength = 1 collapses to i.i.d.
// sampling with replacement. Shared verbatim between the two tests so that RC
// and SPA are compared under the SAME resampling draws.

export function safeRatio(num, den) {
    if (den > 0) return num / den;
    return num > 0 ? Infinity : 0;
}
