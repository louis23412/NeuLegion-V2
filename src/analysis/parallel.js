// Order-preserving bounded-concurrency scheduling (round 26, R26-4).
//
// The A/B's fold loop is embarrassingly parallel: every fold-pass is an
// independent model fit with its own state directory and its own seed
// (`(variantSeed + testStart·977)`, `+7777` for predict), so the arithmetic of a
// fold does not depend on when it runs. What *does* depend on scheduling is the
// **emit order** — `folds.jsonl` and the per-variant checkpoints must stay
// byte-identical between the serial and parallel paths. So the scheduler collects
// results by unit index and the caller assembles them in order; the executor is the
// only thing that changes.
//
// This module is deliberately dependency-free and synchronous-free: the score
// arithmetic is elsewhere (`backtest.js`), the worker entry is elsewhere
// (`fold_worker.js`), and the only thing here is "run N units with C in flight,
// return them in order".

// Validate and normalise a concurrency request. A non-finite / non-positive value
// means "serial" (1), never "unbounded".
export const normaliseConcurrency = (value, { max = 64 } = {}) => {
    if (!Number.isFinite(value) || value <= 1) return 1;
    return Math.min(Math.floor(value), max);
};

// Run `units` through `exec(unit, index)` with at most `concurrency` in flight,
// returning the results in **unit order** (the scheduler's whole contract). The
// first rejection wins and no further units are started; already-running units are
// awaited so no promise is left dangling (their results are discarded). `onResult`
// is called as each finishes (out of order), for progress reporting only.
export async function scheduleUnits(units, { exec, concurrency = 1, onResult = null } = {}) {
    if (!Array.isArray(units)) throw new Error('scheduleUnits: units must be an array');
    if (typeof exec !== 'function') throw new Error('scheduleUnits: exec(unit, index) is required');
    const n = units.length;
    const results = new Array(n);
    if (n === 0) return results;
    const width = normaliseConcurrency(concurrency, { max: n });
    let next = 0;
    let failure = null;
    const runner = async () => {
        while (true) {
            if (failure) return;
            const i = next++;
            if (i >= n) return;
            try {
                const value = await exec(units[i], i);
                results[i] = value;
                if (onResult) { try { onResult(value, i); } catch { /* reporting is best-effort */ } }
            } catch (err) {
                if (!failure) failure = err;
                return;
            }
        }
    };
    await Promise.all(Array.from({ length: width }, runner));
    if (failure) throw failure;
    return results;
}

// A worker-backed fold executor (round 26, R26-4).
//
// `dispatch(request)` is an async function that runs one fold request in another
// thread/process and resolves `{ positions, confidence, stats }` (the worker's
// wire shape). The production implementation is `makeNodeFoldDispatcher` in
// `analyze.js`; tests inject a fake. This wrapper is only responsible for turning a
// `(variant, stream, fold)` request into the dispatcher's shape, validating the
// reply, and adapting the worker's `positions` to the executor contract's
// `signals`, so the scheduling order and the reply contract are testable in the
// browser harness without `worker_threads`.
export const makeFoldExecutor = ({ dispatch }) => {
    if (typeof dispatch !== 'function') throw new Error('makeFoldExecutor: dispatch(request) is required');
    return async (request) => {
        const reply = await dispatch(request);
        if (!reply || !Array.isArray(reply.positions)) {
            throw new Error(`fold executor: malformed reply for ${request && request.variantId}/${request && request.foldIndex}`);
        }
        const confidence = Array.isArray(reply.confidence) ? reply.confidence : null;
        return { signals: reply.positions, confidence, stats: reply.stats || null };
    };
};
