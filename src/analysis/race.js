// Successive-halving / Hyperband racing for the family search (round 26, R26-15).
//
// The A/B's expensive step is not a fold — R26-12 makes a fold cheap and R26-13
// pairs the comparison — it is the *number of arms* (variants x seeds x policy
// configurations). Successive halving gives every arm a small budget (few folds,
// one seed), eliminates the arms that are statistically out of contention, and
// reallocates the freed budget to the survivors, so the search cost is
// `O(arms)` at the cheapest rung instead of `O(arms)` at the full budget.
//
// This module is the ENGINE only, and it is deliberately pure and evaluator-
// agnostic: `successiveHalving({ arms, evaluate, maxBudget, eta })` calls
// `evaluate(arm, budget)` (sync or async) and needs nothing else. The shipped
// `analyze` driver does NOT yet expose a `--race` flag: R26-15 is **gated** on an
// economics win (R26-5) or a diversity win (R26-6), and `RUN-ANALYSIS.md` §7 found
// neither — the family is cost-dead, so a wider search has no measured reason yet.
// The engine and its full-grid validation are built now so that decision can be
// revisited cheaply, and so the validation requirement (a racing budget must not
// change the *decided* set) is a test rather than a promise.
//
// Grounding: Jamieson & Talwalkar (2016, arXiv 1502.07943) — non-stochastic
// best-arm identification with successive halving; Li et al. (2018, arXiv
// 1603.06560) — Hyperband (successive halving as a subroutine).
//
// Pure: no I/O, no RNG. Exact reference vectors live in `analysis.test.js`.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const idOf = (arm) => (arm && typeof arm === 'object' ? (arm.id ?? arm.label ?? null) : arm);

// The number of halving rounds needed to shrink a pool from `maxBudget/minBudget`
// rungs down to one arm at `eta` reduction per round.
export function halvingRounds({ maxBudget, minBudget = 1, eta = 3 } = {}) {
    if (!isNum(maxBudget) || !isNum(minBudget) || !isNum(eta)) return 0;
    if (!(maxBudget >= minBudget) || !(minBudget >= 1) || !(eta > 1)) return 0;
    return Math.max(1, Math.floor(Math.log(maxBudget / minBudget) / Math.log(eta)) + 1);
}

// The elimination schedule: how many arms survive and what budget each rung uses.
// Stops early once a single arm remains (there is nothing left to eliminate), so
// the top rung may be below `maxBudget` for a small arm count.
export function halvingSchedule({ arms, maxBudget, minBudget = 1, eta = 3 } = {}) {
    const n = Array.isArray(arms) ? arms.length : 0;
    const rounds = halvingRounds({ maxBudget, minBudget, eta });
    const schedule = [];
    let survivors = n;
    let budget = rounds > 0 ? maxBudget / Math.pow(eta, rounds - 1) : maxBudget;
    for (let r = 0; r < rounds && survivors > 1; r++) {
        const keep = Math.max(1, Math.ceil(survivors / eta));
        schedule.push({ round: r, budget: Math.round(budget), arms: survivors, keep });
        survivors = keep;
        budget *= eta;
    }
    return schedule;
}

// Run the race. `evaluate(arm, budget)` must resolve to a finite number (a score;
// higher is better unless `maximize:false`). A non-finite result is treated as a
// thrown evaluation and the arm is eliminated rather than silently ranked.
//
// Returns `{ available, winner, rounds, evaluated, fullGrid, schedule, reader }`.
// `rounds[i].scored` is the full rung (arm + score, in arm order), so a caller can
// render exactly what was compared and what was cut.
export async function successiveHalving({
    arms, evaluate, maxBudget, minBudget = 1, eta = 3, maximize = true,
} = {}) {
    if (!Array.isArray(arms) || arms.length === 0) return { available: false, reason: 'no arms to race' };
    if (typeof evaluate !== 'function') return { available: false, reason: 'evaluate(arm, budget) required' };
    if (!isNum(maxBudget) || maxBudget < 1) return { available: false, reason: 'maxBudget must be a finite number >= 1' };
    const dir = maximize ? 1 : -1;
    const schedule = halvingSchedule({ arms, maxBudget, minBudget, eta });
    let pool = arms.slice();
    let budget = schedule.length ? schedule[0].budget : Math.round(maxBudget);
    const rounds = [];
    for (let r = 0; r < schedule.length; r++) {
        const scored = [];
        for (const arm of pool) {
            let v;
            try {
                v = await evaluate(arm, budget);
            } catch {
                v = NaN;
            }
            scored.push({ arm, id: idOf(arm), score: isNum(v) ? v : null });
        }
        const ranked = scored.filter((s) => s.score != null).sort((a, b) => dir * (b.score - a.score));
        const keep = schedule[r].keep;
        const survivors = ranked.slice(0, keep).map((s) => s.arm);
        rounds.push({
            round: r,
            budget,
            keep,
            scored,
            survivors: survivors.slice(),
            survivorIds: survivors.map(idOf),
            lost: ranked.slice(keep).map((s) => s.arm),
            lostIds: ranked.slice(keep).map(idOf),
            nonFinite: scored.filter((s) => s.score == null).map(idOf),
        });
        if (survivors.length <= 1) {
            pool = survivors;
            break;
        }
        pool = survivors;
        budget = schedule[r + 1] ? schedule[r + 1].budget : Math.round(maxBudget);
    }
    let winner = pool.length === 1 ? pool[0] : null;
    if (winner == null) {
        const last = rounds[rounds.length - 1];
        const ranked = last ? last.scored.filter((s) => s.score != null).sort((a, b) => dir * (b.score - a.score)) : [];
        winner = ranked.length ? ranked[0].arm : null;
    }
    return {
        available: true,
        winner,
        winnerId: idOf(winner),
        rounds,
        evaluated: rounds.reduce((a, r) => a + r.scored.length, 0),
        survivorEvaluations: rounds.reduce((a, r) => a + r.survivors.length, 0),
        // The real cost comparison: budget-weighted units spent by the race versus
        // scoring every arm at the top budget (a full grid).
        spentBudget: rounds.reduce((a, r) => a + r.budget * r.scored.length, 0),
        gridBudget: arms.length * Math.round(maxBudget),
        fullGrid: arms.length,
        schedule,
        maximize,
        reader: 'successive halving: every arm is scored at the cheapest rung, only the top 1/eta survive to a budget eta times larger, and the race stops when one arm remains. `evaluated` is the number of (arm, budget) evaluations actually spent, versus `fullGrid` arms at the top budget for a grid search. The engine is validated against a full-grid oracle in analysis.test.js section AM before it may be trusted.',
    };
}

export function formatRace(race) {
    if (!race || race.available !== true) return `race: unavailable (${race ? race.reason : 'none'})`;
    const rungs = race.rounds.map((r) => `${r.budget}x${r.scored.length}`).join(' -> ');
    return `race: winner=${race.winnerId} rungs=${rungs} evals=${race.evaluated}/${race.fullGrid} arms`;
}
