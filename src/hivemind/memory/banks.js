// HiveMind component: banks
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
import { surpriseGateFromSimilarity } from './surprise.js';

export const bankMethods = {
    _updateSemanticProtos (transformerIdx, newProtos) {
        if (!Array.isArray(newProtos) || newProtos.length === 0) return;

        let sem = this._semanticProtos[transformerIdx];
        const baseLR = this._semanticLR;
        const maxP = this._effectiveSemanticMax;
        const hidden = this._hiddenSize;

        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const agreement = this._agreementScores[transformerIdx] ?? 0.5;
        const overload = sem.length / maxP;
        const mergePressure = Math.max(0, overload - 0.15) + (perf > 0.7 ? (perf - 0.7) * 0.5 : 0);
        let dynamicThreshold = (0.85 + 0.15 * this._protoCapacityFactor) - 0.50 * mergePressure + 0.30 * (1 - agreement);
        const stagnation = this._isStagnating(transformerIdx);
        if (stagnation) dynamicThreshold += 0.20;
        dynamicThreshold = Math.max(0.50, Math.min(0.98, dynamicThreshold));

        this._decayProtos(sem);

        for (const p of newProtos) {
            if (!p || !p.mean) continue;

            // `p` is always a transient candidate: it is either merged into an
            // existing proto or copied through _createNewProto further down, and
            // is never itself stored in `sem`. Callers no longer pre-register
            // these candidates in the LSH index (they pass transformerIdx=null to
            // _finalizeSemanticProto), so this is a no-op guard in practice - but
            // it stays as cheap insurance so that any caller which does register
            // a candidate here can't fill the bucket sets with dead references
            // (every later retrieval would then waste most of its probes on
            // expired protos, and could even surface them as candidates).
            this._removeProtoFromLSH(transformerIdx, p);

            if (!p.projNorms || p.projNorms.length !== this._numProjections) p.projNorms = this._computeProjNorms(p.mean);

            p.isCore = p.isCore || false;

            for (let j = 0; j < hidden; j++) {
                p.variance[j] = Math.min(Math.max(p.variance[j], 1e-6), this._maxVariancePerDim);
            }

            if (sem.length === 0) {
                const newMean = new Float32Array(p.mean);
                const newVar = new Float32Array(hidden);
                for (let j = 0; j < hidden; j++) {
                    newVar[j] = p.variance[j];
                }

                const addedProto = this._createNewProto(newMean, newVar, p.size, false);
                this._reinforceProto(addedProto, this._baseAccessInc * 0.5, 0, this._baseImpInc * 0.4);
                sem.push(addedProto);
                this._finalizeSemanticProto(addedProto, transformerIdx);
                continue;
            }

            const n = sem.length;
            const topM = Math.round(this._baseProtoCapacity * (4 + 3 * this._protoCapacityFactor + 2 * mergePressure));

            const approxScores = new Float32Array(n);

            for (let i = 0; i < n; i++) {
                if (!sem[i].projNorms || sem[i].projNorms.length !== this._numProjections) sem[i].projNorms = this._computeProjNorms(sem[i].mean);
                approxScores[i] = this._projSimilarity(p.projNorms, sem[i].projNorms);
            }

            const indices = Array.from({length: n}, (_, i) => i);
            indices.sort((a, b) => approxScores[b] - approxScores[a]);

            const topCandidates = indices.slice(0, topM);

            let bestSim = -1;
            let bestIdx = -1;
            for (const idx of topCandidates) {
                const sim = this._kernelSimilarity(p, sem[idx]);
                if (sim > bestSim) {
                    bestSim = sim;
                    bestIdx = idx;
                }
            }

            let noveltyFactor = Math.max(0, (dynamicThreshold - bestSim) / dynamicThreshold);

            // Surprise-gated write (Titans, arXiv 2501.00663). `bestSim` is how
            // well the existing bank already predicts this candidate, so
            // `1 - bestSim` is the write's surprise and `writeGate` scales how
            // strongly it is written. Disabled by default, where `writeGate` is
            // exactly 1 and every multiplication below is an IEEE-754 no-op.
            const writeGate = this._surpriseGateEnabled
                ? surpriseGateFromSimilarity(bestSim, this._surpriseConfig)
                : 1;

            let merged = false;
            if (bestSim >= dynamicThreshold && bestIdx !== -1) {
                const proto = sem[bestIdx];
                const oldMean = new Float32Array(proto.mean);
                const importance = proto.importance || 0;

                let dynamicLR = (baseLR / (1 + 0.8 * importance)) * writeGate;

                proto.size += p.size * 0.8 * writeGate;
                this._reinforceProto(proto, p.size * 0.6 * (1 - dynamicLR) * writeGate, 0, this._baseImpInc * 0.6 * writeGate);

                const diff = this._vectorSub(p.mean, oldMean);
                const diffSqSum = this._vectorDot(diff, diff);

                this._fastVectorAdd(oldMean, p.mean, 1 - dynamicLR, dynamicLR, proto.mean);
                this._invalidateProjCache(proto.mean);

                for (let j = 0; j < hidden; j++) {
                    const d = diff[j];
                    proto.variance[j] = (1 - dynamicLR) * proto.variance[j] + dynamicLR * (p.variance[j] + d * d * 1.5);
                    proto.variance[j] = Math.min(Math.max(proto.variance[j], 1e-6), this._maxVariancePerDim);
                }
                proto.importance = importance + 0.5 * (diffSqSum * dynamicLR * dynamicLR) / hidden;
                proto.projNorms = this._computeProjNorms(proto.mean);
                // _finalizeSemanticProto re-registers the proto in the LSH index
                // and recomputes its content hash, so the explicit
                // _updateProtoInLSH + _computeContentHash that used to sit here
                // did the whole remove/hash/insert cycle twice.
                this._finalizeSemanticProto(proto, transformerIdx);
                merged = true;
            }

            if (!merged) {
                const lowerRepelThresh = Math.max(0.4, dynamicThreshold * 0.65 - 0.25 * mergePressure);
                if (bestSim > lowerRepelThresh && bestIdx !== -1) {
                    const bestProto = sem[bestIdx];
                    const diff = this._vectorSub(p.mean, bestProto.mean);
                    const diffNorm = this._vectorNorm(diff);
                    if (diffNorm > 1e-8) {
                        const direction = this._fastVectorScale(diff, 1 / diffNorm);
                        let closeness = (bestSim - lowerRepelThresh) / (dynamicThreshold - lowerRepelThresh);
                        closeness = Math.min(1, Math.max(0, closeness));
                        let strength = closeness * (0.8 + 1.5 * noveltyFactor);
                        if (stagnation) strength *= 1.1;
                        const avgProtoVar = this._getAvgProtoVariance(transformerIdx);
                        strength *= (0.5 + 0.8 * Math.sqrt(avgProtoVar / this._maxVariancePerDim));
                        const moveAmount = strength * Math.sqrt(this._maxVariancePerDim * 0.08);
                        this._fastVectorAdd(p.mean, direction, 1, moveAmount, p.mean);
                        this._invalidateProjCache(p.mean);

                        for (let j = 0; j < hidden; j++) {
                            const proj = direction[j] * direction[j];
                            p.variance[j] += proj * moveAmount * moveAmount * 4.0;
                            p.variance[j] = Math.min(p.variance[j], this._maxVariancePerDim);
                        }
                        p.projNorms = this._computeProjNorms(p.mean);
                        p.contentHash = this._computeContentHash(p.mean);
                        noveltyFactor += closeness * 0.4;
                        noveltyFactor = Math.min(1.2, noveltyFactor);
                    }
                }

                const newMean = new Float32Array(p.mean);
                const newVar = new Float32Array(hidden);
                for (let j = 0; j < hidden; j++) {
                    newVar[j] = p.variance[j];
                }

                const addedProto = this._createNewProto(newMean, newVar, p.size, false);
                this._reinforceProto(addedProto, this._baseAccessInc * 0.5 * writeGate, 0, this._baseImpInc * 0.4 * writeGate);
                addedProto.size = Math.max(1, addedProto.size * writeGate);
                sem.push(addedProto);
                this._finalizeSemanticProto(addedProto, transformerIdx);
            }
        }

        if (sem.length > maxP * this._tempOverloadFactor) {
            this._sortByUtilityDescInPlace(sem);
            const oldLen = sem.length;
            const trimLen = Math.round(maxP * this._mergeTrimFactor);
            const toRemove = sem.slice(trimLen, oldLen);
            for (const proto of toRemove) {
                this._removeProtoFromLSH(transformerIdx, proto);
            }
            sem.length = trimLen;

            const overloadFactor = sem.length / maxP;
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

        const minAvgVar = 0.08 + 0.50 * (1 - perf) + 0.40 * (1 - agreement);
        const inflationFactor = 1.2 + 0.8 * (1 - perf);
        const noiseBase = 0.06 + 0.20 * (1 - perf);
        for (const proto of sem) {
            let varSum = 0;
            for (let j = 0; j < hidden; j++) {
                varSum += proto.variance[j];
            }
            const avgVar = varSum / hidden;
            if (avgVar < minAvgVar && !proto.isCore) {
                const deficit = minAvgVar - avgVar;
                const noiseScale = noiseBase + 0.6 * deficit;

                for (let j = 0; j < hidden; j++) {
                    proto.mean[j] += this._randomNormal(0, noiseScale * 0.8);
                }

                this._invalidateProjCache(proto.mean);

                for (let j = 0; j < hidden; j++) {
                    proto.variance[j] *= inflationFactor;
                    proto.variance[j] = Math.min(proto.variance[j], this._maxVariancePerDim);
                }

                proto.projNorms = this._computeProjNorms(proto.mean);
                this._updateProtoInLSH(transformerIdx, proto);
                proto.contentHash = this._computeContentHash(proto.mean);
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

    _pruneMemory (transformerIdx, contextWindow, latestAttentionScores) {
        const memory = this._attentionMemory[transformerIdx];
        if (memory.length <= contextWindow) return;

        const numToKeep = contextWindow;
        const baseRecent = Math.round(this._baseProtoCapacity * 0.4);
        const scaledRecent = Math.round(baseRecent * this._memoryFactor);
        const numForcedRecent = Math.min(scaledRecent, Math.floor(numToKeep * 0.6));
        const latestIndex = memory.length - 1;
        let forcedStart = Math.max(0, latestIndex - numForcedRecent + 1);

        const numEntries = memory.length;
        const scores = new Float32Array(numEntries);
        for (let i = 0; i < numEntries; i++) {
            const attScores = (i === latestIndex) ? latestAttentionScores : null;
            scores[i] = this._computeMemoryScoreFromProtos(memory[i].protos, attScores, transformerIdx, i, memory);
        }

        const olderIndices = [];
        for (let i = 0; i < forcedStart; i++) {
            olderIndices.push(i);
        }
        olderIndices.sort((a, b) => scores[b] - scores[a]);

        const actualForcedCount = latestIndex - forcedStart + 1;
        const numFromOlder = Math.max(0, numToKeep - actualForcedCount);

        const selectedIndices = [];
        for (let i = forcedStart; i <= latestIndex; i++) {
            selectedIndices.push(i);
        }
        for (let k = 0; k < numFromOlder && k < olderIndices.length; k++) {
            selectedIndices.push(olderIndices[k]);
        }

        selectedIndices.sort((a, b) => a - b);
        this._attentionMemory[transformerIdx] = selectedIndices.map(idx => memory[idx]);

        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const allIndices = Array.from({length: memory.length}, (_, i) => i);
        const discardedIndices = allIndices.filter(idx => !selectedIndices.includes(idx));

        if (discardedIndices.length > 0) {
            const discardWithScore = discardedIndices.map(idx => ({
                idx,
                score: this._computeMemoryScoreFromProtos(memory[idx].protos, null, transformerIdx, idx, memory, true)
            }));
            discardWithScore.sort((a, b) => b.score - a.score);

            const numPromote = Math.min(Math.round(this._baseProtoCapacity * (0.25 + 0.5 * (1 - perf))), discardWithScore.length);

            const promotedEntries = [];
            for (let k = 0; k < numPromote; k++) {
                const { idx } = discardWithScore[k];
                const entry = memory[idx];
                const newProtos = entry.protos.map(p => {
                    const newMean = new Float32Array(p.mean);
                    const newProto = this._createNewProto(newMean, new Float32Array(p.variance), p.size * 1.1, true);
                    this._reinforceProto(newProto, p.accessCount * 0.4, p.size * 0.2, this._baseImpInc * 3, this._coreBoostMultiplier);
                    this._finalizeSemanticProto(newProto, null);
                    return newProto;
                });
                const repMean = entry.repMean ? new Float32Array(entry.repMean) : this._weightedMean(entry.protos);
                promotedEntries.push({
                    protos: newProtos,
                    repMean,
                    repProj: this._computeProjNorms(repMean)
                });
            }

            this._coreEpisodic[transformerIdx].push(...promotedEntries);

            if (this._coreEpisodic[transformerIdx].length > this._coreEpisodicMaxEntries) {
                const coreWithScore = this._coreEpisodic[transformerIdx].map(entry => ({
                    entry,
                    score: this._computeMemoryScoreFromProtos(entry.protos, null, transformerIdx, -1, [], true)
                }));
                coreWithScore.sort((a, b) => b.score - a.score);
                this._coreEpisodic[transformerIdx] = coreWithScore.slice(0, this._coreEpisodicMaxEntries).map(item => item.entry);
            }
        }
    },

    _updateMemoryBanks (finalOutput, attentionScores, transformerIdx, training, layerNum) {
        const specScore = this._specializationScores[transformerIdx] || 0.5;

        const perf = Math.max(0, Math.min(1, this._performanceScores[transformerIdx] || 0.5));
        const threshMultiplier = 0.75 + 0.5 * perf;
        const maxAddMultiplier = 1.0 + 1.0 * (1 - perf);
        const mergeThreshold = 0.7 + 0.2 * perf * this._protoCapacityFactor;

        const numLayersEffective = Math.max(1, this._numLayers - 1);
        const layerFraction = layerNum / numLayersEffective;
        const layerDepthFactor = 1 - layerFraction;
        const earlyBias = 1.5;
        const lateFloor = 0.4;
        const noiseMultiplier = earlyBias * layerDepthFactor + lateFloor * (1 - layerDepthFactor);

        let outputToAdaptive = finalOutput;
        if (training) {
            const confidence = perf * (0.7 + 0.3 * specScore);
            const baseMaxNoiseScale = 0.03 + 0.3 * (1 - confidence);
            const maxNoiseScale = baseMaxNoiseScale * noiseMultiplier;

            outputToAdaptive = finalOutput.map(tokenVec => {
                return tokenVec.map((val, j) => val + (Math.random() - 0.5) * maxNoiseScale * 
                    (1 + (this._specializationWeights[transformerIdx][j % this._hiddenSize][j % this._hiddenSize] || 1)));
            });
        } else {
            const baseScale = 0.01 + 0.04 * (1 - perf);
            const scaledBase = baseScale * noiseMultiplier;
            const timePhase = this._attentionMemory[transformerIdx].length * 0.05;

            outputToAdaptive = finalOutput.map(tokenVec =>
                tokenVec.map((val, j) => val + scaledBase * Math.sin(j * 0.12 + timePhase))
            );
        }

        const dynamicShortThreshFactor = 4.0 * threshMultiplier;
        const dynamicShortMaxAdd = Math.round(this._shortTermMaxProtos * maxAddMultiplier);
        const shortProtos = this._poolMultiPrototype(outputToAdaptive, dynamicShortMaxAdd, dynamicShortThreshFactor);

        if (shortProtos.length > Math.round(this._shortTermMaxProtos * this._tempOverloadFactor)) {
            this._sortByUtilityDescInPlace(shortProtos);
            shortProtos.length = Math.round(this._shortTermMaxProtos * this._tempOverloadFactor);
        }

        if (shortProtos.length > 0) {
            const shortRepMean = this._weightedMean(shortProtos);
            const shortRepProj = this._computeProjNorms(shortRepMean);

            const adaptMem = this._adaptiveContext[transformerIdx];
            if (adaptMem.length > 0) {
                const last = adaptMem[adaptMem.length - 1];
                if (!last.repMean) last.repMean = this._weightedMean(last.protos);
                const lastTotalSize = last.protos.reduce((s, p) => s + p.size, 0) || 1;
                const sim = this._projSimilarity(last.repProj, shortRepProj);

                if (sim > mergeThreshold) {
                    const shortTotalSize = shortProtos.reduce((s, p) => s + p.size, 0);
                    const combinedTotal = lastTotalSize + shortTotalSize;
                    const combinedMean = new Float32Array(this._hiddenSize);
                    for (let j = 0; j < this._hiddenSize; j++) {
                        combinedMean[j] = (last.repMean[j] * lastTotalSize + shortRepMean[j] * shortTotalSize) / combinedTotal;
                    }
                    last.repMean = combinedMean;
                    last.repProj = this._computeProjNorms(combinedMean);

                    for (const p of shortProtos) {
                        const newP = this._createNewProto(p.mean, p.variance, p.size, p.isCore);
                        this._reinforceProto(newP, 1.2, 0, 0.15, 1.0);
                        this._finalizeSemanticProto(newP, null);
                        last.protos.push(newP);
                    }

                    const maxPerShortEntry = Math.round(this._shortTermMaxProtos * this._mergeTrimFactor);
                    if (last.protos.length > maxPerShortEntry) {
                        last.protos.sort((a, b) => (b.size * b.accessCount) - (a.size * b.accessCount));
                        last.protos = last.protos.slice(0, maxPerShortEntry);
                        last.repMean = this._weightedMean(last.protos);
                        last.repProj = this._computeProjNorms(last.repMean);
                    }
                } else {
                    adaptMem.push({
                        protos: shortProtos,
                        repMean: shortRepMean,
                        repProj: shortRepProj
                    });
                }
            } else {
                adaptMem.push({
                    protos: shortProtos,
                    repMean: shortRepMean,
                    repProj: shortRepProj
                });
            }

            if (adaptMem.length > this._adaptiveWindow) {
                adaptMem.shift();
            }
        }

        if (layerNum + 1 === this._numLayers) {
            const dynamicLongThreshFactor = 4.0 * threshMultiplier;
            const dynamicLongMaxAdd = Math.round(this._longTermMaxProtos * maxAddMultiplier);
            const longProtos = this._poolMultiPrototype(finalOutput, dynamicLongMaxAdd, dynamicLongThreshFactor);

            if (longProtos.length > Math.round(this._longTermMaxProtos * this._tempOverloadFactor)) {
                this._sortByUtilityDescInPlace(longProtos);
                longProtos.length = Math.round(this._longTermMaxProtos * this._tempOverloadFactor);
            }

            if (longProtos.length > 0) {
                const longRepMean = this._weightedMean(longProtos);
                const longRepProj = this._computeProjNorms(longRepMean);

                const attMem = this._attentionMemory[transformerIdx];
                if (attMem.length > 0) {
                    const last = attMem[attMem.length - 1];
                    if (!last.repMean) last.repMean = this._weightedMean(last.protos);
                    const lastTotalSize = last.protos.reduce((s, p) => s + p.size, 0) || 1;
                    const sim = this._projSimilarity(last.repProj, longRepProj);

                    if (sim > mergeThreshold) {
                        const longTotalSize = longProtos.reduce((s, p) => s + p.size, 0);
                        const combinedTotal = lastTotalSize + longTotalSize;
                        const combinedMean = new Float32Array(this._hiddenSize);
                        for (let j = 0; j < this._hiddenSize; j++) {
                            combinedMean[j] = (last.repMean[j] * lastTotalSize + longRepMean[j] * longTotalSize) / combinedTotal;
                        }
                        last.repMean = combinedMean;
                        last.repProj = this._computeProjNorms(combinedMean);

                        for (const p of longProtos) {
                            const newP = this._createNewProto(p.mean, p.variance, p.size, p.isCore);
                            this._reinforceProto(newP, 1.2, 0, 0.15, 1.0);
                            this._finalizeSemanticProto(newP, null);
                            last.protos.push(newP);
                        }

                        const maxPerLongEntry = Math.round(this._longTermMaxProtos * this._mergeTrimFactor);
                        if (last.protos.length > maxPerLongEntry) {
                            last.protos.sort((a, b) => (b.size * b.accessCount) - (a.size * b.accessCount));
                            last.protos = last.protos.slice(0, maxPerLongEntry);
                            last.repMean = this._weightedMean(last.protos);
                            last.repProj = this._computeProjNorms(last.repMean);
                        }
                    } else {
                        attMem.push({
                            protos: longProtos,
                            repMean: longRepMean,
                            repProj: longRepProj
                        });
                    }
                } else {
                    attMem.push({
                        protos: longProtos,
                        repMean: longRepMean,
                        repProj: longRepProj
                    });
                }

                this._pruneMemory(transformerIdx, this._contextWindow, attentionScores);
            }

            const attMem = this._attentionMemory[transformerIdx];
            for (const entry of attMem) this._decayProtos(entry.protos);

            const adaptMem = this._adaptiveContext[transformerIdx];
            for (const entry of adaptMem) this._decayProtos(entry.protos);

            const coreEp = this._coreEpisodic[transformerIdx];
            for (const entry of coreEp) this._decayProtos(entry.protos);

            if (longProtos.length > 0) {
                this._updateSemanticProtos(transformerIdx, longProtos);
                this._updateSemanticStats(transformerIdx);
            }

            if (training) {
                if (this._trainingStepCount % this._faithfulReplayEvery === 0) this._replayOldMemory(transformerIdx);
                if (this._trainingStepCount % this._generativeReplayEvery === 0) this._generativeReplay(transformerIdx);
            }

            this._consolidateSemanticProtos(transformerIdx);
        }
    }

};
