// HiveMind component: diagnostics
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const diagnosticsMethods = {
    // Read-only introspection for the test suite and for debugging a live
    // instance. It walks the private weight/gradient trees and the LSH buckets
    // so external callers can assert invariants (finiteness, index consistency)
    // that would otherwise be unreachable behind the underscore-prefixed fields.
    diagnostics () {
        const numericStats = (root) => {
            let count = 0; let nonFinite = 0; let min = Infinity; let max = -Infinity;
            let sum = 0; let sumSq = 0;
            const walk = (v) => {
                if (typeof v === 'number') {
                    count++;
                    if (!Number.isFinite(v)) nonFinite++;
                    else { if (v < min) min = v; if (v > max) max = v; sum += v; sumSq += v * v; }
                } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
                    for (let i = 0; i < v.length; i++) walk(v[i]);
                } else if (v && typeof v === 'object') {
                    for (const k of Object.keys(v)) walk(v[k]);
                }
            };
            walk(root);
            return { count, nonFinite, min: count ? min : 0, max: count ? max : 0, sum, sumSq };
        };

        const members = [];
        let totalSemantic = 0; let totalAttention = 0; let totalAdaptive = 0; let totalCoreEpisodic = 0;
        let lshConsistent = true; let deadInBuckets = 0; let missingFromBuckets = 0;
        const problems = [];

        for (let idx = 0; idx < this._ensembleSize; idx++) {
            const sem = this._semanticProtos[idx] || [];
            const att = this._attentionMemory[idx] || [];
            const adp = this._adaptiveContext[idx] || [];
            const coreEp = this._coreEpisodic[idx] || [];
            totalSemantic += sem.length;
            totalAttention += att.length;
            totalAdaptive += adp.length;
            totalCoreEpisodic += coreEp.length;

            // A proto intentionally lives in numLshSets*lshNumTables buckets, so
            // only the *set* of indexed protos is meaningful here; the exact
            // multiplicity is checked by callers against bucketEntries.
            const buckets = this._semanticLSHBuckets[idx];
            let bucketEntries = 0;
            const present = new Set();
            for (let s = 0; s < this._numLshSets; s++) {
                for (let t = 0; t < this._lshNumTables; t++) {
                    for (const bucket of buckets[s][t].values()) {
                        for (const p of bucket) {
                            bucketEntries++;
                            present.add(p);
                        }
                    }
                }
            }
            const live = new Set(sem);
            let dead = 0; let missing = 0;
            for (const p of present) if (!live.has(p)) dead++;
            for (const p of live) if (!present.has(p)) missing++;
            deadInBuckets += dead;
            missingFromBuckets += missing;
            if (dead || missing) {
                lshConsistent = false;
                problems.push({ idx, dead, missing });
            }

            members.push({
                idx, semantic: sem.length, attention: att.length, adaptive: adp.length,
                coreEpisodic: coreEp.length, bucketEntries, uniqueInBuckets: present.size,
                deadInBuckets: dead, missingFromBuckets: missing,
            });
        }

        return {
            status: 'ok',
            ensembleSize: this._ensembleSize,
            inputSize: this._inputSize,
            hiddenSize: this._hiddenSize,
            lowDim: this._lowDim,
            numProjections: this._numProjections,
            numLshSets: this._numLshSets,
            lshNumTables: this._lshNumTables,
            lshHashBits: this._lshHashBits,
            trainingStepCount: this._trainingStepCount,
            effectiveSemanticMax: this._effectiveSemanticMax,
            baseProtoCapacity: this._baseProtoCapacity,
            weights: numericStats(this._transformers),
            gradients: numericStats(this._gradientAccumulation),
            totals: { semantic: totalSemantic, attention: totalAttention, adaptive: totalAdaptive, coreEpisodic: totalCoreEpisodic },
            lshConsistent, deadInBuckets, missingFromBuckets, problems,
            members,
        };
    }

};
