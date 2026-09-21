// HiveMind component: consolidation
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { isFiniteNumber } from '../utils.js';

export const consolidationMethods = {
    _consolidateSemanticProtos (transformerIdx) {
        let sem = this._semanticProtos[transformerIdx];

        const minForConsolidate = Math.max(5, Math.round(this._baseProtoCapacity * 0.2));
        if (sem.length < minForConsolidate) {
            return;
        }

        const n = sem.length;
        const hidden = this._hiddenSize;

        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const agreement = this._agreementScores[transformerIdx] ?? 0.5;
        const overload = sem.length / this._effectiveSemanticMax;
        const mergePressure = Math.max(0, overload - 0.15) + (perf > 0.7 ? (perf - 0.7) * 0.8 : 0);
        let mergeKernelThresh = (0.73 + 0.15 * this._protoCapacityFactor) - 0.40 * mergePressure - 0.25 * (1 - agreement);
        mergeKernelThresh = Math.max(0.40, Math.min(0.85, mergeKernelThresh));

        const stagnation = this._isStagnating(transformerIdx);
        const drop = this._detectSuddenDrop(transformerIdx) > 1.2;

        if (stagnation) mergeKernelThresh += 0.1;
        if (drop) mergeKernelThresh += 0.1;
        mergeKernelThresh = Math.min(0.92, mergeKernelThresh);

        const totalBoostFactor = 1 + 0.2 * (stagnation ? 1 : 0) + 0.1 * (drop ? 1 : 0);

        const topPreCandidates = Math.min(Math.round(this._effectiveSemanticMax * 1.05), Math.round(n * 0.6));

        for (let i = 0; i < n; i++) {
            if (!sem[i].projNorms || sem[i].projNorms.length !== this._numProjections) sem[i].projNorms = this._computeProjNorms(sem[i].mean);
        }

        const pairs = [];
        // Flatten every prototype's projection signature into one contiguous
        // Float32Array so the O(n^2) similarity sweep reads linear memory
        // instead of chasing numProjections separate little typed arrays. The
        // reduction order (projection-major, then low-dim) is preserved, so
        // every similarity value is bit-identical.
        const numProj = this._numProjections;
        const lowDim = this._lowDim;
        const projDim = numProj * lowDim;
        const flatProjs = new Float32Array(n * projDim);
        for (let i = 0; i < n; i++) {
            const projs = sem[i].projNorms;
            const base = i * projDim;
            for (let np = 0; np < numProj; np++) {
                const p = projs[np];
                const off = base + np * lowDim;
                for (let l = 0; l < lowDim; l++) flatProjs[off + l] = p[l];
            }
        }
        // Reused per-row scratch buffers (avoids O(n^2) short-lived objects).
        const approxScores = new Float32Array(n);
        const indices = new Array(n);
        const maxTopIdx = Math.min(topPreCandidates, Math.round(this._baseProtoCapacity * 5 * (1 + this._protoCapacityFactor)));
        const topCount = Math.min(maxTopIdx, n);
        // Selection buffers for the stable top-k pass below.
        const selScore = new Float32Array(topCount);
        const selIdx = new Int32Array(topCount);
        // Symmetric Gram matrix of the projection signatures: dot(i,j) is
        // bit-identical to dot(j,i) (multiplication is commutative in IEEE-754
        // and both directions accumulate k=0..projDim-1 in the same order), so
        // every unordered pair is evaluated once and mirrored instead of twice.
        // The O(n^2) sweep is the dominant cost of consolidation, and this
        // removes the redundant half of it. Falls back to the per-row sweep for
        // absurdly large n to bound the extra n^2 buffer.
        const useGram = n <= 1024;
        let gramMatrix = null;
        if (useGram) {
            const gram = new Float32Array(n * n);
            for (let gi = 0; gi < n; gi++) {
                const baseI = gi * projDim;
                const rowI = gi * n;
                for (let gj = gi; gj < n; gj++) {
                    const baseJ = gj * projDim;
                    let sumSim = 0;
                    for (let k = 0; k < projDim; k++) {
                        sumSim += flatProjs[baseI + k] * flatProjs[baseJ + k];
                    }
                    const v = sumSim / numProj;
                    gram[rowI + gj] = v;
                    gram[gj * n + gi] = v;
                }
            }
            gramMatrix = gram;
        }
        for (let i = 0; i < n; i++) {
            if (sem[i].isCore) continue;

            if (useGram) {
                approxScores.set(gramMatrix.subarray(i * n, i * n + n));
                approxScores[i] = -10;
            } else {
                const baseI = i * projDim;
                approxScores.fill(-10);
                for (let j = 0; j < n; j++) {
                    if (j === i) continue;
                    const baseJ = j * projDim;
                    let sumSim = 0;
                    for (let k = 0; k < projDim; k++) {
                        sumSim += flatProjs[baseI + k] * flatProjs[baseJ + k];
                    }
                    approxScores[j] = sumSim / numProj;
                }
            }

            // Only the first `topCount` entries of the descending score order
            // are ever consumed, so sorting all n candidates per row was doing
            // (n - topCount) rows of wasted ordering work plus allocating a
            // fresh comparator closure per row. This maintains the exact prefix
            // of a stable `indices.sort((a,b) => approxScores[b]-approxScores[a])`
            // — score descending, ties broken by ascending index — using an
            // inline insertion pass over the Float32 scores.
            let selN = 0;
            let nan = false;
            for (let k = 0; k < n; k++) {
                const s = approxScores[k];
                if (s !== s) { nan = true; break; }
                if (selN < topCount) {
                    let p = selN;
                    while (p > 0 && selScore[p - 1] < s) {
                        selScore[p] = selScore[p - 1];
                        selIdx[p] = selIdx[p - 1];
                        p--;
                    }
                    selScore[p] = s;
                    selIdx[p] = k;
                    selN++;
                } else if (s > selScore[topCount - 1]) {
                    let p = topCount - 1;
                    while (p > 0 && selScore[p - 1] < s) {
                        selScore[p] = selScore[p - 1];
                        selIdx[p] = selIdx[p - 1];
                        p--;
                    }
                    selScore[p] = s;
                    selIdx[p] = k;
                }
            }

            if (nan) {
                // Defensive fallback: a NaN score makes the comparator
                // unordered, so defer to the original stable full sort to keep
                // the ordering contract identical in pathological inputs.
                for (let k = 0; k < n; k++) indices[k] = k;
                indices.sort((a, b) => approxScores[b] - approxScores[a]);
            }
            const ranked = nan ? indices : selIdx;
            const rankedLen = nan ? topCount : selN;

            for (let ti = 0; ti < rankedLen; ti++) {
                const j = ranked[ti];
                if (i >= j) continue;
                if (sem[j].isCore) continue;

                const sim = this._kernelSimilarity(sem[i], sem[j]);
                if (sim > mergeKernelThresh) {
                    pairs.push([i, j, sim]);
                }
            }
        }

        if (pairs.length > 0) {
            pairs.sort((a, b) => b[2] - a[2]);

            const merged = new Set();
            for (const pair of pairs) {
                if (pairs.length > this._baseProtoCapacity * 4) break;

                let i = pair[0];
                let j = pair[1];
                if (merged.has(i) || merged.has(j)) continue;

                let keepIdx = sem[i].size >= sem[j].size ? i : j;
                let removeIdx = keepIdx === i ? j : i;

                const utilRemove = this._cachedUtilityScores[transformerIdx][removeIdx] || this._computeProtoUtility(sem[removeIdx]);
                const utilKeep = this._cachedUtilityScores[transformerIdx][keepIdx] || this._computeProtoUtility(sem[keepIdx]);
                if (utilRemove > utilKeep) {
                    [keepIdx, removeIdx] = [removeIdx, keepIdx];
                }

                const keep = sem[keepIdx];
                const remove = sem[removeIdx];
                const oldMean = new Float32Array(keep.mean);
                const keepSize = keep.size;
                const removeSize = remove.size;
                const totalSize = keepSize + removeSize;

                const newMean = this._fastVectorAdd(oldMean, remove.mean, keepSize / totalSize, removeSize / totalSize);
                keep.mean.set(newMean);
                this._invalidateProjCache(keep.mean);
                keep.contentHash = this._computeContentHash(keep.mean);

                keep.size = totalSize;
                this._reinforceProto(keep, remove.accessCount * this._mergeAccessScale * totalBoostFactor, remove.size * 0.8, remove.importance * 0.5, totalBoostFactor);
                this._finalizeSemanticProto(keep, transformerIdx);

                let deltaSqSum = 0;
                const deltaVec = this._vectorSub(newMean, oldMean);
                deltaSqSum = this._vectorDot(deltaVec, deltaVec);

                const diff1 = this._vectorSub(oldMean, newMean);
                const diff2 = this._vectorSub(remove.mean, newMean);
                for (let k = 0; k < hidden; k++) {
                    keep.variance[k] = (keepSize * (keep.variance[k] + diff1[k] * diff1[k]) +
                                    removeSize * (remove.variance[k] + diff2[k] * diff2[k])) / totalSize * 1.1;
                    keep.variance[k] = Math.max(keep.variance[k], 1e-6);
                }
                keep.importance += 0.5 * deltaSqSum / hidden;
                // keep.mean is unchanged since the _finalizeSemanticProto above,
                // so its projection signature and LSH registration are still
                // current - recomputing projNorms and re-inserting duplicated
                // that work.

                this._removeProtoFromLSH(transformerIdx, remove);

                merged.add(removeIdx);
            }

            const sortedMerged = Array.from(merged).sort((a, b) => b - a);
            for (const idx of sortedMerged) {
                sem.splice(idx, 1);
            }
        }

        let varThresh = 1.0 + 1.5 * (1 - perf) * this._memoryFactor + 1.0 * (1 - agreement) * this._protoCapacityFactor;
        const baseMinSize = Math.round(this._baseProtoCapacity * 0.25);
        let minSizeForSplit = baseMinSize - Math.round((3 + 2 * (1 - this._protoCapacityFactor)) * perf);
        minSizeForSplit = Math.max(4, minSizeForSplit);
        if (stagnation || drop) {
            varThresh -= 2.0 * this._memoryFactor;
            minSizeForSplit = Math.max(3, minSizeForSplit - Math.round((3 + 2 * this._protoCapacityFactor) * this._memoryFactor));
        }

        if (sem.length < this._effectiveSemanticMax * 1.4) {
            for (let i = 0; i < sem.length; i++) {
                const p = sem[i];
                if (p.size < minSizeForSplit || p.isCore) continue;

                let varSum = 0;
                for (let j = 0; j < hidden; j++) {
                    varSum += p.variance[j];
                }
                const avgVar = varSum / hidden;
                if (avgVar <= varThresh) continue;

                let maxVar = 0;
                let splitDim = 0;
                for (let j = 0; j < hidden; j++) {
                    if (p.variance[j] > maxVar) {
                        maxVar = p.variance[j];
                        splitDim = j;
                    }
                }

                const baseScale = Math.sqrt(Math.max(maxVar, 1e-6)) * 1.2;
                const perfScaleAdjust = 1 + 2.0 * (1 - perf) + 1.0 * (1 - agreement);
                let splitScale = baseScale * perfScaleAdjust;
                if (stagnation || drop) splitScale *= 1.5;

                const originalMean = new Float32Array(p.mean);
                const oldImportance = p.importance || 0;
                const oldSize = p.size;
                const oldAccess = p.accessCount;
                const halfSize = Math.floor(oldSize / 2);
                const size1 = oldSize - halfSize;
                const size2 = halfSize;

                p.mean[splitDim] -= splitScale;
                this._invalidateProjCache(p.mean);
                p.size = size1;
                p.accessCount = oldAccess * (size1 / oldSize);
                p.variance[splitDim] = Math.min(p.variance[splitDim] + splitScale ** 2 * 1.5, this._maxVariancePerDim);
                p.importance = oldImportance * 0.6;
                p.projNorms = this._computeProjNorms(p.mean);
                // _finalizeSemanticProto(p) below re-registers in the LSH index
                // and recomputes the content hash.

                const newMean = new Float32Array(originalMean);
                newMean[splitDim] += splitScale;

                const newVariance = new Float32Array(p.variance);
                newVariance[splitDim] = Math.min(newVariance[splitDim] + splitScale ** 2 * 1.5, this._maxVariancePerDim);

                this._reinforceProto(p, oldAccess * (size1 / oldSize) * 0.6, 0, oldImportance * 0.6);
                this._finalizeSemanticProto(p, transformerIdx);

                const newProto = this._createNewProto(newMean, newVariance, size2, false);
                this._reinforceProto(newProto, oldAccess * (size2 / oldSize) * 0.6, 0, oldImportance * 0.4);
                this._finalizeSemanticProto(newProto, transformerIdx);
                sem.push(newProto);

                if (sem.length >= this._effectiveSemanticMax * this._mergeTrimFactor) break;
            }
        }

        if (sem.length > this._effectiveSemanticMax * this._tempOverloadFactor) {
            this._sortByUtilityDescInPlace(sem);
            const oldLen = sem.length;
            const trimLen = Math.round(this._effectiveSemanticMax * this._mergeTrimFactor);
            const toRemove = sem.slice(trimLen, oldLen);
            for (const proto of toRemove) {
                this._removeProtoFromLSH(transformerIdx, proto);
            }
            sem.length = trimLen;

            const overloadFactor = sem.length / this._effectiveSemanticMax;
            if (overloadFactor > 1.0 && sem.length > 0) {
                const accessValues = sem.map(p => p.accessCount || 0);
                accessValues.sort((a, b) => a - b);

                const pruneFraction = 0.05 + 0.10 * (overloadFactor - 1.0);
                const pruneIdx = Math.floor(accessValues.length * pruneFraction);
                let dynamicThreshold = pruneIdx < accessValues.length ? accessValues[pruneIdx] : 0;

                dynamicThreshold = Math.max(dynamicThreshold, 2.0);

                const toRemovePrune = [];
                for (const proto of sem) {
                    if (!proto.isCore && (proto.accessCount || 0) < dynamicThreshold) {
                        toRemovePrune.push(proto);
                    }
                }
                for (const proto of toRemovePrune) {
                    this._removeProtoFromLSH(transformerIdx, proto);
                }
                sem = sem.filter(p => p.isCore || (p.accessCount || 0) >= dynamicThreshold);
            }
        }

        if (sem.length > 0) {
            this._sortByUtilityDescInPlace(sem);

            let numCores = Math.min(this._coreMaxProtos * 2, sem.length);
            if (stagnation || drop) {
                numCores = Math.min(Math.round(this._coreMaxProtos * 2.5), sem.length);
            }
            sem.forEach(p => p.isCore = false);
            if (numCores > 0) {
                const candidateLimit = Math.min(sem.length, numCores * (4 + 2 * this._protoCapacityFactor));
                const candidates = sem.slice(0, candidateLimit);

                const coreProtos = [];
                const coreSet = new Set();
                coreProtos.push(candidates[0]);
                candidates[0].isCore = true;
                coreSet.add(candidates[0]);

                // Farthest-point core selection, made incremental. bestSimToCores[i]
                // tracks the best similarity between candidates[i] and any core
                // chosen so far, so each outer step only tests the single newly
                // added core instead of re-scanning the whole core set (which made
                // this O(numCores^2 * candidates) similarity computations). The
                // chosen cores, iteration order and Math.random() tie-breaks are
                // all unchanged.
                const numCandidates = candidates.length;
                const bestSimToCores = new Float64Array(numCandidates);
                {
                    const firstCoreProjs = coreProtos[0].projNorms;
                    for (let i = 0; i < numCandidates; i++) {
                        bestSimToCores[i] = this._projSimilarity(candidates[i].projNorms, firstCoreProjs);
                    }
                }

                for (let c = 1; c < numCores; c++) {
                    let bestIdx = -1;
                    let maxMinDist = -1;
                    for (let i = 0; i < numCandidates; i++) {
                        const cand = candidates[i];
                        if (coreSet.has(cand)) continue;

                        const dist = 1 - bestSimToCores[i];

                        if (dist > maxMinDist || (dist === maxMinDist && Math.random() < 0.5)) {
                            maxMinDist = dist;
                            bestIdx = i;
                        }
                    }
                    if (bestIdx !== -1) {
                        const selected = candidates[bestIdx];
                        coreProtos.push(selected);
                        selected.isCore = true;
                        coreSet.add(selected);

                        const selProjs = selected.projNorms;
                        for (let i = 0; i < numCandidates; i++) {
                            if (coreSet.has(candidates[i])) continue;
                            const sim = this._projSimilarity(candidates[i].projNorms, selProjs);
                            if (sim > bestSimToCores[i]) bestSimToCores[i] = sim;
                        }
                    } else {
                        break;
                    }
                }

                coreProtos.forEach(p => {
                    const logBonus = Math.round(5 + 10 * this._protoCapacityFactor) * Math.log(1 + p.size);
                    const cappedLogBonus = Math.min(logBonus, Math.round(20 + 30 * this._protoCapacityFactor));
                    p.importance = (p.importance || 0) + 8 + cappedLogBonus;
                    this._reinforceProto(p, 0, 0, 2, this._coreBoostMultiplier);
                    this._finalizeSemanticProto(p, transformerIdx);
                });
            }

            if (sem.length > this._effectiveSemanticMax) {
                const oldLen = sem.length;
                const toRemove = sem.slice(this._effectiveSemanticMax, oldLen);
                for (const proto of toRemove) {
                    this._removeProtoFromLSH(transformerIdx, proto);
                }
                sem.length = this._effectiveSemanticMax;
            }
        }

        const numPriority = Math.min(Math.round(this._priorityMax * this._tempOverloadFactor), sem.length);
        if (numPriority > 0) {
            const indexed = sem.map((proto, i) => ({i, util: this._computeProtoUtility(proto)}));
            indexed.sort((a, b) => b.util - a.util);
            this._priorityIndices[transformerIdx] = indexed.slice(0, numPriority).map(o => o.i);
        } else {
            this._priorityIndices[transformerIdx] = [];
        }

        this._updateSemanticStats(transformerIdx);
        this._normalizeSemantic(transformerIdx, sem);
        this._semanticProtos[transformerIdx] = sem;
    },

    _computeMemoryScoreFromProtos (protos, attentionScores, transformerIdx, entryIndex, memoryList, ignoreRecency = false) {
        if (!Array.isArray(protos) || protos.length === 0) return 0;

        const hidden = this._hiddenSize;
        const totalSize = protos.reduce((sum, p) => sum + p.size, 0) || 1;
        const rep = this._weightedMean(protos);

        let sqSumApprox = 0;
        let pooledVarSum = 0;
        for (let j = 0; j < hidden; j++) {
            let weightedSq = 0;
            let varJ = 0;
            for (const p of protos) {
                const m = p.mean[j];
                const v = Math.max(p.variance[j], 1e-6);
                const diff = m - rep[j];
                varJ += p.size * (v + diff * diff);
                weightedSq += p.size * m * m;
            }
            pooledVarSum += varJ / totalSize;
            sqSumApprox += weightedSq;
        }
        const magnitudeScore = Math.sqrt(sqSumApprox);
        const varianceScore = Math.tanh(Math.sqrt(Math.max(0, pooledVarSum / hidden)));

        let clusterDiversityScore = 0;
        if (protos.length > 1) {
            let clusterEnt = 0;
            for (const p of protos) {
                const prob = p.size / totalSize;
                if (prob > 1e-6) clusterEnt -= prob * Math.log(prob + 1e-12);
            }
            clusterDiversityScore = clusterEnt / Math.log(protos.length + 1);
        }

        let activeDims = 0;
        for (let j = 0; j < hidden; j++) {
            let maxAbs = 0;
            for (const p of protos) {
                maxAbs = Math.max(maxAbs, Math.abs(p.mean[j]));
            }
            if (maxAbs > 1e-3) activeDims++;
        }
        const sparsity = activeDims / hidden;
        const sparsityScore = 1 - Math.abs(sparsity - 0.5) * 2;

        let attentionSharpness = 0;
        if (attentionScores) {
            // attentionScores are raw scaled dot-products (Q·K/sqrt(headSize)), not
            // probabilities: they may be negative and never sum to 1, so entropy must
            // be taken over the softmax of each row (matching _contextAwareAttention).
            // Treating the raw scores as probabilities made "sharpness" a function of
            // the score row's L1 norm and positive-entry count rather than attention
            // concentration. The softmax is never materialised: with m = max(z) and
            // S = Σ exp(z - m), entropy H = -Σ p·log p = log(S) - (Σ exp(z-m)·(z-m))/S.
            let totalEntropy = 0, queryCount = 0;
            const logN = Math.log(this._inputSize);
            for (let h = 0; h < attentionScores.length; h++) {
                const head = attentionScores[h];
                for (let i = 0; i < head.length; i++) {
                    const headRow = head[i];
                    let m = -Infinity;
                    for (let jj = 0; jj < headRow.length; jj++) {
                        const v = headRow[jj];
                        if (isFiniteNumber(v) && v > m) m = v;
                    }
                    if (m === -Infinity) continue;
                    let S = 0, weighted = 0;
                    for (let jj = 0; jj < headRow.length; jj++) {
                        const v = headRow[jj];
                        if (!isFiniteNumber(v)) continue;
                        const e = Math.exp(v - m);
                        S += e;
                        weighted += e * (v - m);
                    }
                    if (!(S > 0)) continue;
                    const entropy = Math.max(0, Math.log(S) - weighted / S);
                    totalEntropy += entropy;
                    queryCount++;
                }
            }
            const avgEntropy = queryCount > 0 ? totalEntropy / queryCount : logN;
            attentionSharpness = logN > 0 ? Math.exp(-avgEntropy / logN) : 0;
        }

        let totalAccess = 0;
        for (const p of protos) totalAccess += p.accessCount;

        const accessScore = Math.tanh(totalAccess / (protos.length * 50.0));

        const perf = Math.max(0, Math.min(1, this._performanceScores[transformerIdx] || 0.5));
        const specScore = Math.min(Math.max(this._specializationScores[transformerIdx] || 0.5, 0), 1);
        const confidenceBoost = 0.25 * perf * specScore;

        let uniqueness = 1.0;
        if (!ignoreRecency && memoryList.length > 1) {
            const centroidRep = new Float32Array(hidden);
            let totalCentSize = 0;
            const maxSampled = Math.min(Math.round(this._contextWindow * 0.15), memoryList.length);
            const indicesToUse = [];
            if (memoryList.length > maxSampled) {
                for (let i = 0; i < maxSampled; i++) {
                    indicesToUse.push(Math.floor(i * memoryList.length / maxSampled));
                }
            } else {
                for (let i = 0; i < memoryList.length; i++) indicesToUse.push(i);
            }
            const filtered = indicesToUse.filter(idx => idx !== entryIndex);
            for (const idx of filtered) {
                const mProtos = memoryList[idx].protos;
                for (const pr of mProtos) {
                    for (let j = 0; j < hidden; j++) {
                        centroidRep[j] += pr.mean[j] * pr.size;
                    }
                    totalCentSize += pr.size;
                }
            }
            if (totalCentSize > 0) {
                for (let j = 0; j < hidden; j++) centroidRep[j] /= totalCentSize;
                uniqueness = 1 - this._cosineSimilarity(rep, centroidRep);
                uniqueness = Math.max(0, uniqueness);
            }
        }

        let baseScore =
            0.25 * varianceScore +
            0.15 * clusterDiversityScore +
            0.15 * sparsityScore +
            0.15 * Math.tanh(magnitudeScore / Math.sqrt(totalSize * hidden)) +
            0.10 * attentionSharpness +
            0.15 * accessScore;

        baseScore = baseScore * (1 + confidenceBoost) * Math.pow(uniqueness + 0.5, 1.5);

        let diversityFactor = 1.0;
        if (!ignoreRecency && memoryList.length > 5) {
            const minRecentForDiversity = Math.max(Math.round(3 * this._memoryFactor), Math.round(memoryList.length * 0.15));
            const recentCount = Math.max(minRecentForDiversity, Math.floor(memoryList.length * 0.2));
            let distSum = 0;
            let rCount = 0;
            for (let r = 1; r <= recentCount; r++) {
                const recentIndex = memoryList.length - r;
                if (recentIndex < 0 || recentIndex === entryIndex) continue;
                const recentProtos = memoryList[recentIndex].protos;
                const overlapSim = this._maxPairwiseKernel(protos, recentProtos);
                distSum += 1 - overlapSim;
                rCount++;
            }
            if (rCount > 0) diversityFactor = 1 + (distSum / rCount);
        }

        const age = ignoreRecency ? 0 : memoryList.length - 1 - entryIndex;
        const recencyFactor = Math.exp(-0.03 * age) * (1 + 1.0 / (1 + age / 5));

        return baseScore * diversityFactor * recencyFactor;
    }

};
