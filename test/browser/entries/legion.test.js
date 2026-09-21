// Integration suite for the legion orchestration modules (src/legion/*).
//
// The original src/mainController.js was a ~2.5k-line procedural script with no
// test coverage. It is now the entry point only; the orchestration lives in
// src/legion/*, split by concern. This suite is the safety net for that split:
// it boots the legion against the in-memory (sql.js) filesystem, asserts the
// structure is built, and exercises the pure helpers plus the DB round-trip.
//
// It deliberately does NOT import src/mainController.js (which auto-runs the
// candle stream). The legion modules are imported DYNAMICALLY, after
// __ensureSql(): src/legion/database.js opens its two SQLite databases at module
// evaluation time (exactly as the original monolith did), so the sql.js runtime
// must be ready before that graph is evaluated.

import { __ensureSql } from '../shims/better-sqlite3.js';
import { PROJECT } from '../harness.js';

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export async function run() {
    await __ensureSql();
    const checks = [];
    const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

    const { state } = await import('../../../src/legion/state.js');
    const { CONFIG } = await import('../../../src/legion/config.js');
    const { PriorityQueue } = await import('../../../src/legion/priorityQueue.js');
    const { legionAccuracy } = await import('../../../src/legion/accuracy.js');
    const { getTierAndType, buildFreshStructure, getControllerParams } = await import('../../../src/legion/structure.js');
    const ser = await import('../../../src/legion/serialization.js');
    const { initLegion } = await import('../../../src/legion/init.js');
    const { saveLegionState } = await import('../../../src/legion/persistence.js');
    const { getCleanLegionState } = await import('../../../src/legion/broadcast.js');
    const { getCurrentMarketContext } = await import('../../../src/legion/signals.js');
    const { processCandles } = await import('../../../src/legion/runner.js');
    const { processBatch } = await import('../../../src/legion/batch.js');
    const { runWorker, runConsolidationWorker } = await import('../../../src/legion/workers.js');
    const { getLocalIP } = await import('../../../src/legion/net.js');

    // ---- 1. every legion entry point survived the split --------------------
    for (const [name, fn] of Object.entries({
        processCandles, processBatch, runWorker, runConsolidationWorker,
        initLegion, saveLegionState, getCleanLegionState, getCurrentMarketContext,
        getTierAndType, buildFreshStructure, getControllerParams,
        vectorToBlob: ser.vectorToBlob, blobToVector: ser.blobToVector,
        canonicalJSON: ser.canonicalJSON, computeContentHash: ser.computeContentHash,
        computeGaussianDistance: ser.computeGaussianDistance, getLocalIP,
    })) {
        check(`legion exports ${name}()`, typeof fn === 'function');
    }
    check('PriorityQueue exported', typeof PriorityQueue === 'function');
    check('legionAccuracy exported', legionAccuracy && typeof legionAccuracy === 'object');
    check('config paths resolve from src/legion',
        CONFIG.file.endsWith('/src/candles.jsonl') && CONFIG.stateFolder.endsWith('/NeuLegion-master/state'),
        `file=${CONFIG.file} stateFolder=${CONFIG.stateFolder}`);

    // ---- 2. PriorityQueue is a correct min-heap ----------------------------
    const pq = new PriorityQueue();
    const rnd = mulberry32(1234);
    const pushed = [];
    for (let i = 0; i < 500; i++) { const d = rnd() * 1000; pushed.push(d); pq.push({ accumDist: d, i }); }
    check('PriorityQueue size tracks pushes', pq.size === 500, String(pq.size));
    const popped = [];
    while (pq.size > 0) popped.push(pq.pop().accumDist);
    check('PriorityQueue pops in ascending order', popped.every((v, i) => i === 0 || popped[i - 1] <= v),
        `first/last: ${popped[0]}..${popped[popped.length - 1]}`);
    check('PriorityQueue preserves every element', popped.length === 500 && Math.min(...popped) === Math.min(...pushed) && Math.max(...popped) === Math.max(...pushed));
    check('PriorityQueue empty pop returns null', pq.pop() === null);

    // ---- 3. serialization helpers -----------------------------------------
    const vec = [0.5, -1.25, 3, 1e-9, -0];
    const round = ser.blobToVector(ser.vectorToBlob(vec));
    check('vectorToBlob/blobToVector round-trips float64 exactly',
        round.length === vec.length && vec.every((v, i) => Object.is(v, round[i])),
        JSON.stringify(round));
    check('vectorToBlob on empty/invalid input yields empty blob', ser.vectorToBlob([]).length === 0 && ser.vectorToBlob(null).length === 0);
    check('canonicalJSON is key-order independent',
        ser.canonicalJSON({ b: 1, a: [2, { d: 3, c: 4 }] }) === ser.canonicalJSON({ a: [2, { c: 4, d: 3 }], b: 1 }),
        ser.canonicalJSON({ b: 1, a: [2, { d: 3, c: 4 }] }));
    check('computeContentHash is stable for equal vectors',
        ser.computeContentHash([1, 2, 3]) === ser.computeContentHash([1, 2, 3]) &&
        ser.computeContentHash([1, 2, 3]) !== ser.computeContentHash([1, 2, 4]),
        `${ser.computeContentHash([1, 2, 3])} / ${ser.computeContentHash([1, 2, 4])}`);
    check('computeGaussianDistance is finite',
        Number.isFinite(ser.computeGaussianDistance([0, 0], [1, 1], [1, 1], [1, 1])),
        String(ser.computeGaussianDistance([0, 0], [1, 1], [1, 1], [1, 1])));

    // ---- 4. tier/type classification + fresh structure ---------------------
    const clusters = (CONFIG.basePairs * 2) + ((CONFIG.maxTier - 1) * (CONFIG.elderPairs * 2));
    const seen = new Set();
    for (let c = 0; c < clusters; c++) {
        const t = getTierAndType(c);
        check(`getTierAndType(${c}) returns tier/type`, t && Number.isFinite(t.tier) && typeof t.type === 'string',
            JSON.stringify(t));
        seen.add(t.type);
    }
    check('both polarities are represented across clusters', seen.has('positive') && seen.has('negative'), [...seen].join(','));

    // drive the shared state exactly as processCandles does
    state.structureDims = [
        CONFIG.baseGroups, CONFIG.baseSections, CONFIG.baseLayers,
        (CONFIG.basePairs * 2) + ((CONFIG.maxTier - 1) * (CONFIG.elderPairs * 2)),
    ];
    const fresh = buildFreshStructure();
    check('buildFreshStructure produces the declared dimensions',
        fresh.length === state.structureDims[0] &&
        fresh[0].length === state.structureDims[1] &&
        fresh[0][0].length === state.structureDims[2] &&
        fresh[0][0][0].length === state.structureDims[3],
        JSON.stringify([fresh.length, fresh[0]?.length, fresh[0]?.[0]?.length, fresh[0]?.[0]?.[0]?.length]));
    check('every fresh controller carries the required fields',
        fresh.flat(3).every((c) =>
            typeof c.type === 'string' && typeof c.directoryPath === 'string' &&
            Number.isFinite(c.tier) && c.group >= 0 && c.section >= 0 && c.layer >= 0 && c.id >= 0),
        JSON.stringify(fresh.flat(3)[0]));

    const p0 = getControllerParams(0, 0, 0);
    const pMax = getControllerParams(state.structureDims[0] - 1, state.structureDims[1] - 1, state.structureDims[2] - 1);
    check('getControllerParams returns finite, positive params',
        ['cacheSize', 'atrFactor', 'stopFactor', 'minPriceMovement', 'maxPriceMovement', 'pop']
            .every((k) => Number.isFinite(p0[k]) && p0[k] > 0),
        JSON.stringify(p0));
    check('getControllerParams scales cache up and population down across the hierarchy',
        pMax.cacheSize > p0.cacheSize && p0.pop > pMax.pop,
        `cache ${p0.cacheSize} -> ${pMax.cacheSize}; pop ${p0.pop} -> ${pMax.pop}`);

    // ---- 5. legion boot + persistence round-trip ---------------------------
    const loadedCounter = initLegion();
    check('initLegion returns a numeric resume counter', Number.isFinite(loadedCounter), String(loadedCounter));
    check('initLegion populated state.structureMap',
        Array.isArray(state.structureMap) && state.structureMap.flat(3).length === fresh.flat(3).length,
        `${state.structureMap && state.structureMap.flat(3).length} controllers`);
    check('initLegion assigned directory paths to every controller',
        state.structureMap.flat(3).every((c) => typeof c.directoryPath === 'string' && c.directoryPath.length > 0));

    // a market context with an empty candle cache must fall back to defaults
    state.cache = [];
    const market = getCurrentMarketContext();
    check('getCurrentMarketContext falls back to defaults without candles',
        market && market.price === 1.0 && Number.isFinite(market.atrProxy) && Number.isFinite(market.volatility),
        JSON.stringify(market));

    saveLegionState();
    const clean = getCleanLegionState();
    const totalVoters = clean?.positive?.voters?.length + clean?.negative?.voters?.length;
    check('getCleanLegionState returns a serialisable positive/negative snapshot',
        Array.isArray(clean?.positive?.voters) && Array.isArray(clean?.negative?.voters) &&
        totalVoters === state.structureMap.flat(3).length,
        `voters=${totalVoters} controllers=${state.structureMap.flat(3).length}`);
    const voter = clean?.positive?.voters?.[0];
    check('clean voters expose the documented sections',
        voter && ['id', 'tier', 'signalSpeed', 'influence', 'params', 'price', 'stats', 'memory'].every((k) => k in voter) &&
        Number.isFinite(voter.signalSpeed) && !('polarity' in voter),
        JSON.stringify(voter && Object.keys(voter)));

    check('getLocalIP does not throw', (() => { try { getLocalIP(); return true; } catch { return false; } })());

    return {
        total: checks.length,
        failed: checks.filter((c) => !c.pass).length,
        failures: checks.filter((c) => !c.pass),
        checks,
    };
}
