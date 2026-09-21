import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

import HiveMindController from './hivemind/hiveMindController.js';
import { installSeededRandom } from './legion/rng.js';

// Deterministic runs (ROADMAP P0-2): the dispatcher passes a per-worker seed
// derived from CONFIG.seed. With `seed == null` this is a no-op and the worker
// uses native randomness exactly as before.
if (workerData.seed != null) installSeededRandom(workerData.seed);

const { directoryPath, cacheSize, pop, cache, id, type, tier, priceObj, processCount, forceMin, bcR, injR, sharedMem, childMem } = workerData;

try {
    const controller = new HiveMindController(id, directoryPath, cacheSize, pop, type, tier, priceObj, forceMin);

    const start = performance.now();
    const signal = controller.getSignal(cache, processCount, bcR, injR, sharedMem, childMem);
    const end = performance.now();
    const duration = end - start;

    // A controller may return an `{ error }` object instead of a signal (e.g.
    // short input, or an indicator failure). Report it as a failure so the
    // dispatcher rejects and the batch isolates this slot (ROADMAP P0-1) rather
    // than storing an error object as if it were a signal.
    if (!signal || signal.error) {
        parentPort.postMessage({ error: (signal && signal.error) || 'controller returned no signal' });
    } else {
        // `quarantinedRows` is a non-enumerable diagnostic on the signal (see
        // hiveMindController.getSignal); read it explicitly because structured
        // clone would drop it, and report it beside the signal so the main
        // thread can accumulate a run-level count (ROADMAP P0-1).
        const quarantinedRows = Number.isFinite(signal.quarantinedRows) ? signal.quarantinedRows : 0;
        parentPort.postMessage({ signal, duration, quarantinedRows });
    }
} catch (err) {
    parentPort.postMessage({ error: err.message || String(err) });
}
