// NeuLegion legion component: legion bootstrap and resume
//
// Split out of the original monolithic src/mainController.js; the bodies are
// byte-identical apart from the shared mutable state being read/written as
// properties of the `state` holder (see ./state.js). src/mainController.js is
// now just the entry point that runs ./legion/runner.js.

import fs from 'fs';
import path from 'path';
import { state } from './state.js';
import { CONFIG } from './config.js';
import { legionAccuracy } from './accuracy.js';
import { db } from './database.js';
import { selectAccValue } from './statements.js';
import { getTierAndType, buildFreshStructure } from './structure.js';
import { configFingerprint } from './sanitize.js';

// Bumped when the persisted legion schema changes shape. Written into
// `state/main/state_meta.json` alongside a fingerprint of the structure-
// affecting config, so a config edit cannot silently resume on top of an
// incompatible state directory (ROADMAP P0-2).
export const STATE_SCHEMA_VERSION = 2;

export const initLegion = () => {
    const counterRow = db.prepare('SELECT candle_counter FROM legion_state WHERE singleton = 1').get();
    let loadedCounter = counterRow ? counterRow.candle_counter : 0;
    if (!counterRow) {
        db.prepare('INSERT INTO legion_state (singleton, candle_counter) VALUES (1, 0)').run();
    }

    const longWinRaw = selectAccValue.get('long_win');
    if (longWinRaw) {
        legionAccuracy.longWin = parseFloat(longWinRaw.value) || 0;
    }

    const shortWinRaw = selectAccValue.get('short_win');
    if (shortWinRaw) {
        legionAccuracy.shortWin = parseFloat(shortWinRaw.value) || 0;
    }

    const longLossRaw = selectAccValue.get('long_loss');
    if (longLossRaw) {
        legionAccuracy.longLoss = parseFloat(longLossRaw.value) || 0;
    }

    const shortLossRaw = selectAccValue.get('short_loss');
    if (shortLossRaw) {
        legionAccuracy.shortLoss = parseFloat(shortLossRaw.value) || 0;
    }

    const longPointsRaw = selectAccValue.get('long_points');
    if (longPointsRaw) {
        legionAccuracy.longPoints = parseFloat(longPointsRaw.value) || 0;
    }

    const shortPointsRaw = selectAccValue.get('short_points');
    if (shortPointsRaw) {
        legionAccuracy.shortPoints = parseFloat(shortPointsRaw.value) || 0;
    }

    const longTotalPointsRaw = selectAccValue.get('long_total_points');
    if (longTotalPointsRaw) {
        legionAccuracy.longTotalPoints = parseFloat(longTotalPointsRaw.value) || 0;
    }

    const shortTotalPointsRaw = selectAccValue.get('short_total_points');
    if (shortTotalPointsRaw) {
        legionAccuracy.shortTotalPoints = parseFloat(shortTotalPointsRaw.value) || 0;
    }

    const maxBuyScoreRaw = selectAccValue.get('max_buy_score');
    if (maxBuyScoreRaw) {
        legionAccuracy.maxBuyScore = parseFloat(maxBuyScoreRaw.value) || 0;
    }

    const maxSellScoreRaw = selectAccValue.get('max_sell_score');
    if (maxSellScoreRaw) {
        legionAccuracy.maxSellScore = parseFloat(maxSellScoreRaw.value) || 0;
    }

    const maxFinalScoreRaw = selectAccValue.get('max_final_score');
    if (maxFinalScoreRaw) {
        legionAccuracy.maxFinalScore = parseFloat(maxFinalScoreRaw.value) || 0;
    }

    const minBuyScoreRaw = selectAccValue.get('min_buy_score');
    if (minBuyScoreRaw) {
        legionAccuracy.minBuyScore = parseFloat(minBuyScoreRaw.value) || 100;
    }

    const minSellScoreRaw = selectAccValue.get('min_sell_score');
    if (minSellScoreRaw) {
        legionAccuracy.minSellScore = parseFloat(minSellScoreRaw.value) || 100;
    }

    const minFinalScoreRaw = selectAccValue.get('min_final_score');
    if (minFinalScoreRaw) {
        legionAccuracy.minFinalScore = parseFloat(minFinalScoreRaw.value) || 100;
    }

    const buyRaw = selectAccValue.get('buy_score_history');
    if (buyRaw?.value) {
        try { legionAccuracy.buyScoreHistory = JSON.parse(buyRaw.value); }
        catch (e) { legionAccuracy.buyScoreHistory = []; }
    }

    const sellRaw = selectAccValue.get('sell_score_history');
    if (sellRaw?.value) {
        try { legionAccuracy.sellScoreHistory = JSON.parse(sellRaw.value); }
        catch (e) { legionAccuracy.sellScoreHistory = []; }
    }

    const finalRaw = selectAccValue.get('final_score_history');
    if (finalRaw?.value) {
        try { legionAccuracy.finalScoreHistory = JSON.parse(finalRaw.value); }
        catch (e) { legionAccuracy.finalScoreHistory = []; }
    }

    const currentCount = db.prepare('SELECT COUNT(*) AS count FROM legion_controllers').get().count;

    if (currentCount === 0) {
        state.structureMap = buildFreshStructure();

        const insertStmt = db.prepare(`
            INSERT INTO legion_controllers
            (group_id, section_id, layer_id, cluster_id, controller_type, directory_path, tier)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
            state.structureMap.flat(3).forEach(ctrl => {
                insertStmt.run(
                    ctrl.group,
                    ctrl.section,
                    ctrl.layer,
                    ctrl.id,
                    ctrl.type,
                    ctrl.directoryPath,
                    ctrl.tier
                );
            });
        })();
    } else {
        const rows = db.prepare('SELECT * FROM legion_controllers').all();
        const rowMap = new Map();
        rows.forEach(row => {
            const key = `${row.group_id}-${row.section_id}-${row.layer_id}-${row.cluster_id}`;
            rowMap.set(key, row);
        });

        state.structureMap = Array.from({ length: state.structureDims[0] }, (_, group) =>
            Array.from({ length: state.structureDims[1] }, (_, section) =>
                Array.from({ length: state.structureDims[2] }, (_, layer) =>
                    Array.from({ length: state.structureDims[3] }, (_, cluster) => {
                        const key = `${group}-${section}-${layer}-${cluster}`;
                        const row = rowMap.get(key);

                        if (!row) {
                            const { tier, type } = getTierAndType(cluster);
                            const defDir = path.join(CONFIG.stateFolder, `Group${group}`, `Section${section}`, `Layer${layer}`, `G${group}S${section}L${layer}C${cluster}`);
                            fs.mkdirSync(defDir, { recursive: true });

                            db.prepare(`
                                INSERT INTO legion_controllers
                                (group_id, section_id, layer_id, cluster_id, controller_type, directory_path, tier)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                            `).run(
                                group, section, layer, cluster,
                                type, defDir, tier
                            );

                            return {
                                tier,
                                type,
                                directoryPath: defDir,
                                group,
                                section,
                                layer,
                                id: cluster,
                                signalSpeed: 0,
                                memConnections: 0,
                                childConnections : 0,
                                lastSignal: {},
                                signalHistory: [],
                                probHistory: [],
                                scoreHistory: [],
                                lifetimeMinScore: 100,
                                lifetimeMaxScore: 0,
                                lifetimeMinProb: 100,
                                lifetimeMaxProb: 0,
                            };
                        }

                        fs.mkdirSync(row.directory_path, { recursive: true });

                        return {
                            type: row.controller_type,
                            directoryPath: row.directory_path,
                            group: row.group_id,
                            section: row.section_id,
                            layer: row.layer_id,
                            id: row.cluster_id,
                            signalSpeed: row.signal_speed ?? 0,
                            memConnections: row.mem_connections ?? 0,
                            childConnections : row.child_connections ?? 0,
                            lastSignal: JSON.parse(row.last_signal ?? '{}'),
                            signalHistory: JSON.parse(row.signal_history ?? '[]'),
                            probHistory: JSON.parse(row.prob_history ?? '[]'),
                            scoreHistory: JSON.parse(row.score_history ?? '[]'),
                            lifetimeMinScore: row.lifetime_min_score ?? 100,
                            lifetimeMaxScore: row.lifetime_max_score ?? 0,
                            lifetimeMinProb:  row.lifetime_min_prob  ?? 100,
                            lifetimeMaxProb:  row.lifetime_max_prob  ?? 0,
                            tier : row.tier ?? 1
                        };
                    })
                )
            )
        );
    }

    // --- state schema / config guard (ROADMAP P0-2) -------------------------
    // Never fatal unless explicitly configured to refuse. A mismatch means the
    // on-disk state was produced by a different model shape, so resuming would
    // silently blend two trajectories.
    try {
        const metaPath = path.join(CONFIG.stateFolder, 'main', 'state_meta.json');
        const fingerprint = configFingerprint(CONFIG);
        let prev = null;
        try { prev = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* first run */ }

        if (prev && prev.configFingerprint && prev.configFingerprint !== fingerprint) {
            state.configMismatch = prev.configFingerprint;
            const message = `[state] persisted state was written with a different config (${prev.configFingerprint} != ${fingerprint}).`;
            if (CONFIG.refuseOnConfigChange) {
                throw new Error(`${message} Refusing to resume (CONFIG.refuseOnConfigChange=true).`);
            }
            console.error(`${message} Resuming anyway; set CONFIG.refuseOnConfigChange = true to refuse.`);
        } else {
            state.configMismatch = null;
        }

        fs.writeFileSync(metaPath, JSON.stringify({
            schemaVersion: STATE_SCHEMA_VERSION,
            configFingerprint: fingerprint,
            structureDims: state.structureDims,
            updatedAt: new Date().toISOString(),
        }, null, 2));
    } catch (err) {
        // A refusal must propagate; a non-refusal write failure must not.
        if (CONFIG.refuseOnConfigChange && state.configMismatch) throw err;
        console.error('[state] could not write state meta:', err && err.message ? err.message : err);
    }

    return loadedCounter;
};
