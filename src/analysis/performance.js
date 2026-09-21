// Performance & significance statistics for honest strategy evaluation.
//
// Pure functions — no I/O, no global state. Everything here exists to answer
// "is this Sharpe ratio actually evidence of skill, or the best of many noisy
// tries?" (Bailey & Lopez de Prado). These modules are the *measuring
// instrument*: they are never imported by the locked hot path
// (`src/hivemind/`, `src/legion/runner.js`), so they cannot move a golden
// fingerprint.
//
// References:
//   - Bailey & Lopez de Prado, "The Deflated Sharpe Ratio" (2014).
//   - Bailey, Borwein, Lopez de Prado & Zhu, "Pseudo-Mathematics and Financial
//     Charlatanism" (2014) — minimum backtest length.
//   - Lo, "Statistics of the Sharpe Ratio" (2002) — the SR standard error.
//   - Politis & Romano, "The Stationary Bootstrap" (JASA 1994).
//
// Conventions: `sharpeRatio` returns the *per-period* ratio unless
// `periodsPerYear` is given. PSR/DSR/MinTRL require SR, skew and kurtosis at the
// SAME frequency as `n` (pass a raw, non-annualised SR).

export const EULER_MASCHERONI = 0.5772156649015329;

// Abramowitz & Stegun 7.1.26 — |error| < 1.5e-7.
export function erf(x) {
    if (x === 0) return 0; // keep Phi(0) exactly 0.5
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const p = 0.3275911;
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const t = 1 / (1 + p * ax);
    const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
    const y = 1 - poly * Math.exp(-ax * ax);
    return sign * y;
}

// Standard normal CDF. Phi(0) === 0.5 exactly.
export function normalCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.15e-9).
export function normalInvCdf(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
        1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
        6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
        -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
        3.754408661907416e+00];
    const plow = 0.02425;
    const phigh = 1 - plow;
    let q; let r;
    if (p < plow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > phigh) {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function mean(xs) {
    if (!xs.length) return NaN;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

// Population (ddof=0) standard deviation — the power-sum convention used by the
// skewness/kurtosis moments below.
export function stdPopulation(xs) {
    const n = xs.length;
    if (n < 1) return NaN;
    const m = mean(xs);
    let s2 = 0;
    for (const x of xs) { const d = x - m; s2 += d * d; }
    return Math.sqrt(s2 / n);
}

// Sample (ddof=1) standard deviation — the convention for the Sharpe estimator.
export function stdSample(xs) {
    const n = xs.length;
    if (n < 2) return NaN;
    const m = mean(xs);
    let s2 = 0;
    for (const x of xs) { const d = x - m; s2 += d * d; }
    return Math.sqrt(s2 / (n - 1));
}

// Per-period Sharpe ratio. Set periodsPerYear > 1 to annualise (x sqrt(pp)).
// Returns 0 when the series has zero dispersion (a flat return stream has no
// risk-adjusted signal — NaN would poison downstream aggregation).
export function sharpeRatio(returns, { riskFree = 0, periodsPerYear = 1 } = {}) {
    const n = returns.length;
    if (n < 2) return NaN;
    const excess = returns.map((r) => r - riskFree / periodsPerYear);
    const sd = stdSample(excess);
    if (!(sd > 0)) return 0;
    return (mean(excess) / sd) * Math.sqrt(periodsPerYear);
}

export function annualizeSharpe(sr, periodsPerYear = 252) {
    return sr * Math.sqrt(periodsPerYear);
}

export function deannualizeSharpe(sr, periodsPerYear = 252) {
    return sr / Math.sqrt(periodsPerYear);
}

// Fisher-Pearson sample skewness (population moments).
export function skewness(xs) {
    const n = xs.length;
    if (n < 2) return 0;
    const m = mean(xs);
    let m2 = 0; let m3 = 0;
    for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; }
    m2 /= n; m3 /= n;
    if (!(m2 > 0)) return 0;
    return m3 / Math.pow(m2, 1.5);
}

// Non-excess kurtosis (normal === 3).
export function kurtosis(xs) {
    const n = xs.length;
    if (n < 2) return 3;
    const m = mean(xs);
    let m2 = 0; let m4 = 0;
    for (const x of xs) { const d = x - m; m2 += d * d; m4 += d * d * d * d; }
    m2 /= n; m4 /= n;
    if (!(m2 > 0)) return 3;
    return m4 / (m2 * m2);
}

// Lo (2002): SE(SR) = sqrt((1 - skew*SR + (kurt-1)/4 * SR^2) / (n-1)).
export function sharpeStandardError({ sharpe, n, skew = 0, kurtosis: kurt = 3 }) {
    if (n < 2) return NaN;
    const v = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe;
    if (v < 0) return NaN;
    return Math.sqrt(v / (n - 1));
}

// Probabilistic Sharpe Ratio: probability the true SR exceeds `benchmarkSR`,
// correcting for sample length, skew and fat tails.
//   PSR = Phi( (SR - SR*) * sqrt(n-1) / sqrt(1 - g3*SR + (g4-1)/4 * SR^2) )
export function probabilisticSharpeRatio({ sharpe, n, skew = 0, kurtosis: kurt = 3, benchmarkSR = 0 }) {
    if (n < 2) return NaN;
    const denom2 = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe;
    if (!(denom2 > 0)) return NaN;
    const z = (sharpe - benchmarkSR) * Math.sqrt(n - 1) / Math.sqrt(denom2);
    return normalCdf(z);
}

// Expected maximum Sharpe across N independent trials, given the variance of the
// trial SRs. This is the selection-bias hurdle. N<=1 => 0 (no selection).
export function expectedMaxSharpe({ trials, trialsVariance }) {
    if (!(trials > 1)) return 0;
    if (!(trialsVariance > 0)) return 0;
    const e = Math.E;
    const term1 = (1 - EULER_MASCHERONI) * normalInvCdf(1 - 1 / trials);
    const term2 = EULER_MASCHERONI * normalInvCdf(1 - 1 / (trials * e));
    return Math.sqrt(trialsVariance) * (term1 + term2);
}

// Default variance of the Sharpe estimator when no trial spread is supplied
// (Lo 2002 asymptotic variance for zero skew / normal kurtosis).
export function defaultTrialVariance({ sharpe, n }) {
    if (n < 2) return NaN;
    return (1 + 0.5 * sharpe * sharpe) / (n - 1);
}

// Deflated Sharpe Ratio: PSR evaluated against the expected-max-of-N hurdle.
export function deflatedSharpeRatio({
    sharpe, n, skew = 0, kurtosis: kurt = 3,
    trials = 1, trialsVariance = null, benchmarkSR = null,
}) {
    if (n < 2) return NaN;
    const variance = trialsVariance != null ? trialsVariance : defaultTrialVariance({ sharpe, n });
    const hurdle = benchmarkSR != null ? benchmarkSR : expectedMaxSharpe({ trials, trialsVariance: variance });
    return probabilisticSharpeRatio({ sharpe, n, skew, kurtosis: kurt, benchmarkSR: hurdle });
}

// Minimum Track Record Length: observations required for the observed SR to beat
// `benchmarkSR` with probability `prob`. Inf when SR <= benchmarkSR.
export function minimumTrackRecordLength({ sharpe, benchmarkSR = 0, skew = 0, kurtosis: kurt = 3, prob = 0.95 }) {
    if (!(sharpe > benchmarkSR)) return Infinity;
    const v = 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe;
    const z = normalInvCdf(prob);
    return 1 + v * Math.pow(z / (sharpe - benchmarkSR), 2);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Stationary bootstrap (Politis & Romano) p-value for H0: SR <= benchmarkSR.
// Geometric block lengths (mean = blockLength), wraparound. Deterministic given
// the seed. Returns { pValue, samples, observed }.
//
// FIXED (docs/BUGS.md #10): the block start was drawn once and thereafter only
// ever advanced (`i = (i + 1) % n`), so every resample was a single contiguous
// rotation of the series with random repeats rather than independent geometric
// blocks. That made the bootstrap Sharpe distribution far too narrow and the
// p-value anti-conservative — on pure noise the 5% test rejected ~17.5% of
// series instead of ~5%. Per Politis & Romano (1994) a new block must begin with
// a freshly drawn uniform start; doing so restores the calibrated rate (5.8% in
// analysis.test.js section G, which pins it at <= 10%).
export function stationaryBootstrapSharpe({
    returns, benchmarkSR = 0, samples = 1000, blockLength = null, seed = 1,
}) {
    const n = returns.length;
    if (n < 2) return { pValue: NaN, samples: 0, observed: NaN };
    const rnd = mulberry32(seed);
    const p = blockLength != null ? 1 / blockLength : 1 / Math.max(1, Math.floor(Math.pow(n, 1 / 3)));
    const observed = sharpeRatio(returns);
    let exceed = 0;
    for (let s = 0; s < samples; s++) {
        const draw = new Array(n);
        let i = Math.floor(rnd() * n);
        for (let t = 0; t < n; t++) {
            if (t > 0) {
                if (rnd() < p) i = Math.floor(rnd() * n);
                else i = (i + 1) % n;
            }
            draw[t] = returns[i];
        }
        const sr = sharpeRatio(draw);
        if (!(sr > benchmarkSR)) exceed++;
    }
    return { pValue: exceed / samples, samples, observed };
}

// One-call evaluation summary used by the legion's reporting layer.
export function evaluateStrategy(returns, { periodsPerYear = 1, trials = 1, trialsVariance = null } = {}) {
    const n = returns.length;
    const sharpe = sharpeRatio(returns, { periodsPerYear });
    const perPeriodSharpe = deannualizeSharpe(sharpe, periodsPerYear);
    const skew = skewness(returns);
    const kurt = kurtosis(returns);
    return {
        n,
        sharpe,
        perPeriodSharpe,
        skew,
        kurtosis: kurt,
        sharpeStandardError: sharpeStandardError({ sharpe: perPeriodSharpe, n, skew, kurtosis: kurt }),
        psr: probabilisticSharpeRatio({ sharpe: perPeriodSharpe, n, skew, kurtosis: kurt }),
        dsr: deflatedSharpeRatio({ sharpe: perPeriodSharpe, n, skew, kurtosis: kurt, trials, trialsVariance }),
        minTrackRecordLength: minimumTrackRecordLength({ sharpe: perPeriodSharpe, skew, kurtosis: kurt }),
    };
}
