// The *audited evaluation world* for the walk-forward A/B (ROADMAP round 23, N0).
//
// Why this module exists. `auditNoLookahead` certifies causality by perturbing
// every value after a test bar and requiring that bar's position not to move. It
// can only do that for information it can *reach* — and the shipped model
// (`HiveMindController`) reads the candle series, not the return array, so a
// returns-only perturbation never touches its input and its audit passed
// vacuously (measured; see docs/BUGS.md #22). This module builds the view a
// candle-driven model actually consumes — the real candles, with every bar after
// the probe point shifted by a bounded, deterministic, non-uniform factor — so
// the perturbation reaches the model's input and the audit has teeth.
//
// The shock is applied to the OHLC of every bar *after* the probe point, so:
//   * the position at the probe bar cannot legitimately move (it may only read
//     bars <= t) -> a clean result is a real causality certificate;
//   * any leak (a feature that reads bar t+1..) moves the position -> caught;
//   * the view is self-consistent: `view.returns` is always re-derived from the
//     (possibly shocked) closes, so there is never a second, unshocked copy of
//     the future hiding in the state object.
//
// Pure: no I/O, no RNG (the shock is a deterministic function of the index), no
// hot-path imports. Grounded in the same decision-time-leakage literature as the
// audit itself (arXiv 2605.23959, 2608.27734).

import { barReturns } from './walkforward.js';

// The default shock: a ~5% non-uniform multiplicative wobble. `probe` bounds the
// factor to [1, 1 + 2*probe] (it is 1 + probe*(1 + sin(...))), so a shocked price
// path can never go non-positive or explode — which is what makes it safe to use
// with the audit's own `probe` semantics.
export const DEFAULT_SHOCK = Object.freeze({ probe: 0.05, frequency: 1.7, volumePhase: Math.PI / 2 });

// Bounded, deterministic, NON-uniform multiplicative shock for bar `t`:
//
//   factor(t) = 1                       for t <= after
//             = 1 + probe*(1 + sin(frequency*t))   for t >  after
//
// Non-uniform matters: the controller robustly normalises its indicator features,
// so a uniform level shift can be normalised away. A varying factor changes the
// *shape* of the future path, which no scale-invariant model can ignore.
export function shockFactor(t, { after = -1, probe = DEFAULT_SHOCK.probe, frequency = DEFAULT_SHOCK.frequency } = {}) {
    if (!(t > after)) return 1;
    return 1 + probe * (1 + Math.sin(frequency * t));
}

// The volume shock. Same bounded, deterministic, non-uniform construction as
// `shockFactor`, but PHASE-SHIFTED so it is not collinear with the price shock —
// a volume-only strategy (`sig-volume`) or a model that reads volume-based
// indicators must be reachable by the perturbation too, otherwise its audit is
// vacuous (measured on the completed smoke run: `sig-volume` was unreachable in
// 0/32 probes before this). Bounded to [1, 1 + 2*probe], so volume can only grow.
export function volumeShockFactor(t, { after = -1, probe = DEFAULT_SHOCK.probe, frequency = DEFAULT_SHOCK.frequency, phase = DEFAULT_SHOCK.volumePhase } = {}) {
    if (!(t > after)) return 1;
    return 1 + probe * (1 + Math.sin(frequency * t + phase));
}

// Rebuild the candle array with every bar after `after` scaled. Returns a new
// array of new objects; the input is never mutated. `perturb = null` (the base
// pass) returns the input array unchanged.
export function shockCandles(candles, perturb = null) {
    if (!perturb) return candles;
    const { after, probe = DEFAULT_SHOCK.probe, frequency = DEFAULT_SHOCK.frequency } = perturb;
    return candles.map((c, t) => {
        if (!(t > after)) return c;
        const f = shockFactor(t, { after, probe, frequency });
        const fv = volumeShockFactor(t, { after, probe, frequency });
        return {
            ...c,
            open: c.open * f,
            high: c.high * f,
            low: c.low * f,
            close: c.close * f,
            volume: (Number.isFinite(c.volume) ? c.volume : 1) * fv,
        };
    });
}

// The `viewFor` the walk-forward audit calls. `viewFor(returns, perturb)` returns
// the object a candle-driven model reads; `perturb` is `null` for the base pass
// or the audit's `{ after, probe }` spec for a probe pass.
//
// The base pass returns the *real* candles (so the reported metrics are measured
// on the shipped data, not on a synthesis), and only the probe pass is shocked.
export function makeCandleViewFor(candles, { frequency } = {}) {
    const baseCloses = candles.map((c) => c.close);
    const baseVolumes = candles.map((c) => (Number.isFinite(c.volume) ? c.volume : 1));
    const baseReturns = barReturns(baseCloses);
    return (returns, perturb) => {
        if (!perturb) {
            return { returns: returns || baseReturns, closes: baseCloses, volumes: baseVolumes, candles, perturb: null };
        }
        const shocked = shockCandles(candles, { after: perturb.after, probe: perturb.probe, frequency });
        const closes = shocked.map((c) => c.close);
        const volumes = shocked.map((c) => (Number.isFinite(c.volume) ? c.volume : 1));
        return {
            returns: barReturns(closes),
            closes,
            volumes,
            candles: shocked,
            perturb: { after: perturb.after, probe: perturb.probe },
        };
    };
}

// A world from real candles: `{ candles, closes, returns }`. `maxBars` keeps the
// most recent bars (the A/B's bounded window).
export function worldFromCandles(candles, { maxBars = null } = {}) {
    const bars = maxBars && candles.length > maxBars ? candles.slice(-maxBars) : candles.slice();
    const closes = bars.map((c) => c.close);
    const volumes = bars.map((c) => (Number.isFinite(c.volume) ? c.volume : 1));
    return { candles: bars, closes, volumes, returns: barReturns(closes) };
}
