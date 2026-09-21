// HiveMind component: retrieval
//
// Extracted verbatim from the original monolithic hiveMind.js. This module
// exports a bag of methods that hiveMind.js installs onto HiveMind.prototype
// (see internal/mixins.js), so every method still runs with a HiveMind
// instance as `this` and reads/writes the underscore-prefixed state declared
// in the class body. Splitting by concern keeps each file reviewable; the
// golden suite (test/browser/entries/golden.test.js) pins the numerics.
export const retrievalMethods = {
    _kernelSimilarity (protoA, protoB) {
        if (!protoA.mean || !protoB.mean) return 0;
        const hidden = this._hiddenSize;
        const eps = 1e-6;
        const quadraticDivisor = 6 + 4 * this._protoCapacityFactor;
        let mahalSum = 0, sumLnPooled = 0, sumLnA = 0, sumLnB = 0;
        const meanA = protoA.mean, meanB = protoB.mean;
        const varA = protoA.variance, varB = protoB.variance;

        for (let j = 0; j < hidden; j++) {
            const diff = meanA[j] - meanB[j];
            const va = Math.max(varA[j], eps);
            const vb = Math.max(varB[j], eps);
            const pooled = (va + vb) * 0.5 + eps;
            mahalSum += diff * diff / pooled;
            sumLnPooled += Math.log(pooled);
            sumLnA += Math.log(va);
            sumLnB += Math.log(vb);
        }

        const avgMahal = mahalSum / hidden;
        const quadratic = avgMahal / quadraticDivisor;
        const detTerm = 0.5 * ((sumLnPooled / hidden) - 0.5 * ((sumLnA + sumLnB) / hidden));
        let D = quadratic + detTerm;
        return Math.exp(-this._kernelGamma * Math.max(0, D));
    },

    _retrieveTopRelevantProtos (transformerIdx, currentProtos, maxRetrieve = this._maxRetrievedProtos) {
        if (currentProtos.length === 0) return [];

        currentProtos.forEach(cp => {
            if (!cp.projNorms || cp.projNorms.length !== this._numProjections) {
                cp.projNorms = this._computeProjNorms(cp.mean);
            }
        });

        const queryMean = this._weightedMean(currentProtos);
        const totalSizeQuery = currentProtos.reduce((s, p) => s + (p.size || 0), 0) || 1;
        const queryVariance = new Float32Array(this._hiddenSize);
        for (const cp of currentProtos) {
            const weight = (cp.size || 1) / totalSizeQuery;
            for (let j = 0; j < this._hiddenSize; j++) {
                const diff = cp.mean[j] - queryMean[j];
                queryVariance[j] += weight * (cp.variance[j] + diff * diff);
            }
        }
        for (let j = 0; j < this._hiddenSize; j++) {
            queryVariance[j] = Math.max(queryVariance[j], 1e-6);
        }
        const queryProjs = this._computeProjNorms(queryMean);

        const avgProj = Array.from({length: this._numProjections}, () => new Float32Array(this._lowDim).fill(0));
        const numCurrent = currentProtos.length;
        for (const cp of currentProtos) {
            for (let np = 0; np < this._numProjections; np++) {
                const a = avgProj[np];
                const c = cp.projNorms[np];
                for (let l = 0; l < this._lowDim; l++) {
                    a[l] += c[l] / numCurrent;
                }
            }
        }

        const attMem = this._attentionMemory[transformerIdx];
        const episodicToConsider = attMem.length > this._maxEpisodicConsider 
            ? attMem.slice(-this._maxEpisodicConsider) 
            : attMem;
        const episodicLen = episodicToConsider.length;

        const adaptMem = this._adaptiveContext[transformerIdx];
        const adaptLen = adaptMem.length;

        const numEntries = episodicLen + adaptLen;

        const perf = this._performanceScores[transformerIdx] ?? 0.5;
        const agreement = this._agreementScores[transformerIdx] ?? 0.5;
        const overconfidence = perf * agreement;

        let explorationRate = 0.35 + 0.65 * (1 - perf) + 0.45 * (1 - agreement) + 0.8 * overconfidence;
        const stagnation = this._isStagnating(transformerIdx);
        const dropBoost = this._detectSuddenDrop(transformerIdx);
        if (stagnation) {
            explorationRate = Math.min(1.0, explorationRate + 0.7);
        }

        const avgProtoVar = this._getAvgProtoVariance(transformerIdx);
        const lowProtoVariance = avgProtoVar < this._maxVariancePerDim * 0.12;
        if (lowProtoVariance) {
            explorationRate = Math.min(1.0, explorationRate + 0.8);
        }

        let candProtos = [];
        let candIsSem = [];

        const basePerEntry = Math.max(this._longTermMaxProtos, this._shortTermMaxProtos / 2);
        const maxPerMemoryEntry = Math.round(basePerEntry * (1 + explorationRate));

        if (numEntries > 0) {
            const entryScores = new Float32Array(numEntries);

            for (let e = 0; e < episodicLen; e++) {
                const entry = episodicToConsider[e];
                if (entry && entry.repProj && entry.repProj.length === this._numProjections) {
                    entryScores[e] = this._projSimilarity(avgProj, entry.repProj);
                }
            }

            for (let a = 0; a < adaptLen; a++) {
                const entry = adaptMem[a];
                if (entry && entry.repProj && entry.repProj.length === this._numProjections) {
                    entryScores[episodicLen + a] = this._projSimilarity(avgProj, entry.repProj);
                }
            }

            for (let e = 0; e < episodicLen; e++) {
                const age = episodicLen - 1 - e;
                entryScores[e] += 0.8 * Math.exp(-0.01 * age);
            }
            for (let a = 0; a < adaptLen; a++) {
                const age = adaptLen - 1 - a;
                entryScores[episodicLen + a] += 0.7 * Math.exp(-0.01 * age);
            }

            const entryIndices = Array.from({length: numEntries}, (_, i) => i);
            entryIndices.sort((a, b) => entryScores[b] - entryScores[a]);

            const numEpCand = Math.min(Math.round(this._numRetrievalCandidates * 1.2 * (1 + 2.5 * explorationRate)), numEntries);

            for (let ii = 0; ii < numEpCand && ii < entryIndices.length; ii++) {
                const eIdx = entryIndices[ii];
                let protos = [];
                if (eIdx < episodicLen) {
                    const entry = episodicToConsider[eIdx];
                    if (entry && entry.protos && entry.protos.length > 0) protos = entry.protos;
                } else {
                    const aIdx = eIdx - episodicLen;
                    const entry = adaptMem[aIdx];
                    if (entry && entry.protos && entry.protos.length > 0) protos = entry.protos;
                }

                if (protos.length > 0) {
                    const sortedProtos = this._sortedByUtilityDesc(protos);
                    const takeNum = Math.min(Math.round(maxPerMemoryEntry * 2), sortedProtos.length);
                    for (let pp = 0; pp < takeNum; pp++) {
                        const p = sortedProtos[pp];
                        if (!p.projNorms || p.projNorms.length !== this._numProjections) {
                            p.projNorms = this._computeProjNorms(p.mean);
                        }
                        candProtos.push(p);
                        candIsSem.push(false);
                    }
                }
            }
        }

        const coreEp = this._coreEpisodic[transformerIdx];
        if (coreEp.length > 0) {
            for (const entry of coreEp) {
                if (entry.protos && entry.protos.length > 0) {
                    const sortedProtos = this._sortedByUtilityDesc(entry.protos);
                    const takeNum = Math.min(maxPerMemoryEntry * 8, sortedProtos.length);
                    for (let pp = 0; pp < takeNum; pp++) {
                        const p = sortedProtos[pp];
                        if (!p.projNorms || p.projNorms.length !== this._numProjections) {
                            p.projNorms = this._computeProjNorms(p.mean);
                        }
                        candProtos.push(p);
                        candIsSem.push(false);
                    }
                }
            }
        }

        let protectedProtos = [];
        const semProtos = this._semanticProtos[transformerIdx];
        semProtos.forEach(p => { if (p.isCore) protectedProtos.push(p); });
        coreEp.forEach(entry => { if (entry.protos) protectedProtos.push(...entry.protos); });

        if (protectedProtos.length > 0) {
            protectedProtos.forEach(p => {
                if (!p.projNorms || p.projNorms.length !== this._numProjections) {
                    p.projNorms = this._computeProjNorms(p.mean);
                }
            });

            const protectedSims = protectedProtos.map(p => this._kernelSimilarity(
                { mean: queryMean, variance: queryVariance },
                p
            ));

            const protectedIndices = Array.from({length: protectedProtos.length}, (_, i) => i);
            protectedIndices.sort((a, b) => protectedSims[b] - protectedSims[a]);

            const numProtected = Math.min(Math.round(this._maxRetrievedProtos * 0.35 * (1 + explorationRate)), protectedProtos.length);
            for (let k = 0; k < numProtected; k++) {
                const p = protectedProtos[protectedIndices[k]];
                candProtos.push(p);
                candIsSem.push(true);
            }
        }

        const numSem = semProtos.length;
        let semCandProtos = [];
        if (numSem > 0) {
            semProtos.forEach(p => {
                if (!p.projNorms || p.projNorms.length !== this._numProjections) {
                    p.projNorms = this._computeProjNorms(p.mean);
                }
            });

            const semCandidates = new Set();

            const hashesPerSet = new Array(this._numLshSets);
            for (let s = 0; s < this._numLshSets; s++) {
                hashesPerSet[s] = this._computeLSHHashesLow(queryProjs[s], this._lshHyperplanes[s]);
            }

            const baseProbes = Math.round(this._numRetrievalCandidates * explorationRate * 0.8);
            const scaledAdditive = Math.round(this._baseProtoCapacity * (4 + 4 * this._memoryFactor));

            let numProbes = baseProbes + scaledAdditive;

            const stagnationAdd = Math.round(this._baseProtoCapacity * (8 + 16 * this._memoryFactor) * (stagnation ? 1 : 0));
            const dropAdd = Math.round(this._baseProtoCapacity * (7 + 14 * this._memoryFactor) * (dropBoost > 1.5 ? 1 : 0));
            const lowPerfAdd = Math.round(this._baseProtoCapacity * (6 + 12 * this._memoryFactor) * (perf < 0.6 ? 1 : 0));
            let lowVarAdd = 0;
            if (lowProtoVariance) lowVarAdd = Math.round(this._baseProtoCapacity * (24 + 48 * this._memoryFactor));

            numProbes += stagnationAdd + dropAdd + lowPerfAdd + lowVarAdd;

            const maxCandidateCap = Math.round(this._effectiveSemanticMax * (6 + 4 * this._memoryFactor));

            // Both of these are loop-invariant; they used to be rebuilt for
            // every (set, table) pair and the bit masks rebuilt for every
            // single flipped bit.
            const bitMasks = this._getLshBitMasks();
            const flipsPerLevel = [2, 3, 4, Math.round(this._lshHashBits * 0.08), Math.round(this._lshHashBits * 0.15)];
            const probesPerLevel = Math.round(numProbes / flipsPerLevel.length);

            for (let s = 0; s < this._numLshSets; s++) {
                const hashes = hashesPerSet[s];
                const tableArray = this._semanticLSHBuckets[transformerIdx][s];
                for (let t = 0; t < this._lshNumTables; t++) {
                    let key = hashes[t];
                    let bucket = tableArray[t].get(key);
                    if (bucket) for (const proto of bucket) semCandidates.add(proto);

                    for (let b = 0; b < this._lshHashBits; b++) {
                        const flipped = key ^ bitMasks[b];
                        bucket = tableArray[t].get(flipped);
                        if (bucket) for (const proto of bucket) semCandidates.add(proto);
                    }

                    for (let level = 0; level < flipsPerLevel.length && semCandidates.size < maxCandidateCap; level++) {
                        const flipBits = flipsPerLevel[level];
                        for (let pr = 0; pr < probesPerLevel && semCandidates.size < maxCandidateCap; pr++) {
                            let flippedHash = key;
                            for (let f = 0; f < flipBits; f++) {
                                const bit = Math.floor(Math.random() * this._lshHashBits);
                                flippedHash ^= bitMasks[bit];
                            }
                            bucket = tableArray[t].get(flippedHash);
                            if (bucket) for (const proto of bucket) semCandidates.add(proto);
                        }
                    }
                }
            }

            semCandProtos = Array.from(semCandidates);

            let desiredSem = Math.round(this._numRetrievalCandidates * 0.7 * (1 + 4.0 * explorationRate));
            if (stagnation) desiredSem = Math.round(desiredSem * 2.2);
            if (dropBoost > 1.5) desiredSem = Math.round(desiredSem * 1.8);
            if (lowProtoVariance) desiredSem = Math.round(desiredSem * 3.0);

            const lowThresh = Math.round(desiredSem * 0.6);
            if (semCandProtos.length < lowThresh) {
                let extraProbes = Math.round(this._baseProtoCapacity * (8 + 24 * explorationRate) * (stagnation ? 2 : 1) * (dropBoost > 1.5 ? 1.8 : 1));
                if (lowProtoVariance) extraProbes *= 4;

                const farFlipFrac = 0.09 + 0.15 * explorationRate + 0.10 * (stagnation ? 1 : 0);

                for (let ex = 0; ex < extraProbes; ex++) {
                    if (semCandProtos.length >= maxCandidateCap) break;
                    const ss = Math.floor(Math.random() * this._numLshSets);
                    const tt = Math.floor(Math.random() * this._lshNumTables);
                    let baseKey = hashesPerSet[ss][tt];
                    let numFlips = Math.max(4, Math.round(this._lshHashBits * farFlipFrac));
                    let flipped = baseKey;
                    for (let ff = 0; ff < numFlips; ff++) {
                        const bit = Math.floor(Math.random() * this._lshHashBits);
                        flipped ^= bitMasks[bit];
                    }
                    const bucket = this._semanticLSHBuckets[transformerIdx][ss][tt].get(flipped);
                    if (bucket) for (const proto of bucket) semCandidates.add(proto);
                }
                semCandProtos = Array.from(semCandidates);
            }

            if (semCandProtos.length < desiredSem * 0.3) {
                const projScores = new Float32Array(numSem);
                for (let i = 0; i < numSem; i++) {
                    projScores[i] = this._projSimilarity(queryProjs, semProtos[i].projNorms);
                }
                const projIndices = Array.from({length: numSem}, (_, i) => i);
                projIndices.sort((a, b) => projScores[b] - projScores[a]);
                const need = Math.min(numSem, Math.round(desiredSem * (3 + 2 * explorationRate) - semCandProtos.length));
                for (let k = 0; k < need; k++) {
                    const proto = semProtos[projIndices[k]];
                    if (!semCandidates.has(proto)) {
                        semCandProtos.push(proto);
                    }
                }
            }

            if (semCandProtos.length < desiredSem * 0.2) {
                const lowAccess = semProtos.map((p, i) => ({p, acc: p.accessCount || 0}));
                lowAccess.sort((a, b) => a.acc - b.acc);
                const need = Math.min(lowAccess.length, Math.round(desiredSem * (1.5 + explorationRate) - semCandProtos.length));
                for (let k = 0; k < need; k++) {
                    const proto = lowAccess[k].p;
                    if (!semCandidates.has(proto)) {
                        semCandProtos.push(proto);
                    }
                }
            }

            let targetTotal = Math.round(desiredSem * (2.5 + explorationRate));
            if (stagnation || explorationRate > 0.6) {
                targetTotal = Math.round(targetTotal * 2.0);
            }
            while (semCandProtos.length < targetTotal && semCandProtos.length < numSem * 0.95) {
                const randProto = semProtos[Math.floor(Math.random() * numSem)];
                if (!semCandidates.has(randProto)) {
                    semCandProtos.push(randProto);
                }
            }

            semProtos.forEach(p => {
                if (p.isCore && !semCandidates.has(p)) semCandProtos.push(p);
            });
            const priorityProtos = this._priorityIndices[transformerIdx].map(i => semProtos[i]);
            priorityProtos.forEach(p => {
                if (!semCandidates.has(p)) semCandProtos.push(p);
            });
        }

        semCandProtos = semCandProtos.filter(p => 
            this._projSimilarity(queryProjs, p.projNorms) > 0.35 - 0.15 * (1 - perf)
        );

        candProtos.push(...semCandProtos);
        candIsSem.push(...semCandProtos.map(() => true));

        const totalCandLimit = Math.round(this._numRetrievalCandidates * (1 + 5.0 * explorationRate));
        if (candProtos.length > totalCandLimit) {
            const approxScores = candProtos.map(p => this._projSimilarity(queryProjs, p.projNorms));
            const sortedIdx = Array.from({length: candProtos.length}, (_, i) => i);
            sortedIdx.sort((a, b) => approxScores[b] - approxScores[a]);
            const newCandProtos = [];
            const newCandIsSem = [];
            for (let t = 0; t < totalCandLimit; t++) {
                const oldi = sortedIdx[t];
                newCandProtos.push(candProtos[oldi]);
                newCandIsSem.push(candIsSem[oldi]);
            }
            candProtos = newCandProtos;
            candIsSem = newCandIsSem;
        }

        const numCandProtos = candProtos.length;
        if (numCandProtos === 0) return [];

        const baseThresh = 0.55;
        let threshAdjust = 0.60 * explorationRate;

        const semScale = this._effectiveSemanticMax;
        if (numSem < semScale * 1.5) threshAdjust += 0.55;
        else if (numSem < semScale * 3) threshAdjust += 0.35;

        if (stagnation) threshAdjust += 0.45;

        let threshold = Math.max(-0.6, baseThresh - threshAdjust);

        const candidatesForExact = [];
        for (let i = 0; i < numCandProtos; i++) {
            const proto = candProtos[i];
            const approxSim = this._projSimilarity(queryProjs, proto.projNorms);
            if (approxSim > threshold || proto.isCore) {
                candidatesForExact.push({i, approxSim});
            }
        }
        candidatesForExact.sort((a, b) => b.approxSim - a.approxSim);

        let maxExactCompute = Math.round(this._baseProtoCapacity * (12 + 8 * explorationRate + 6 * this._memoryFactor) * (1 + 0.5 * this._protoCapacityFactor));
        if (stagnation) maxExactCompute = Math.round(maxExactCompute * 1.8);

        candidatesForExact.length = Math.min(maxExactCompute, candidatesForExact.length);

        const protoScores = new Float32Array(numCandProtos).fill(-100);

        for (const {i} of candidatesForExact) {
            const proto = candProtos[i];
            const sim = this._kernelSimilarity(
                { mean: queryMean, variance: queryVariance },
                proto
            );

            let score = sim * 1.4;

            score += candIsSem[i] ? 4.0 : 0;

            const coreBoostFactor = 20 + 30 * this._protoCapacityFactor;
            if (proto.isCore) score += coreBoostFactor;

            score += 0.4 * Math.log(1 + proto.size / 8);

            const accessBonus = explorationRate / Math.sqrt(proto.accessCount + 1);
            score += accessBonus * 12.0;

            let varSum = 0;
            for (let j = 0; j < this._hiddenSize; j++) {
                varSum += proto.variance[j];
            }
            const avgVar = varSum / this._hiddenSize;
            const varBoost = Math.tanh(Math.sqrt(avgVar + 1e-6) * 2.5);
            score += explorationRate * 3.5 * varBoost;

            protoScores[i] = score;
        }

        const protoIndices = Array.from({length: numCandProtos}, (_, i) => i);
        protoIndices.sort((a, b) => protoScores[b] - protoScores[a]);

        const diversityAdjust = Math.tanh(numCandProtos / 80.0);
        const baseThreshDiv = 0.45;
        let DIVERSITY_THRESHOLD = baseThreshDiv - 0.55 * explorationRate - 0.4 * diversityAdjust;
        if (stagnation) DIVERSITY_THRESHOLD -= 0.45;
        if (dropBoost > 1.5) DIVERSITY_THRESHOLD -= 0.25;
        DIVERSITY_THRESHOLD = Math.max(0.01, Math.min(0.75, DIVERSITY_THRESHOLD));

        let effectiveMaxRetrieve = Math.round(maxRetrieve * (1 + 3.0 * explorationRate + 2.0 * this._memoryFactor));
        if (stagnation) effectiveMaxRetrieve = Math.round(effectiveMaxRetrieve * 1.6);

        const topNum = Math.min(effectiveMaxRetrieve, numCandProtos);

        const selectedProtoIndices = [];
        let pi = 0;
        while (selectedProtoIndices.length < topNum && pi < numCandProtos) {
            const candIdx = protoIndices[pi];
            const pProjs = candProtos[candIdx].projNorms;

            let maxSimToSelected = -1;
            for (const selIdx of selectedProtoIndices) {
                const sProjs = candProtos[selIdx].projNorms;
                const sim = this._projSimilarity(pProjs, sProjs);
                if (sim > maxSimToSelected) maxSimToSelected = sim;
            }

            let effectiveThresh = candProtos[candIdx].isCore ? DIVERSITY_THRESHOLD + 0.5 : DIVERSITY_THRESHOLD;

            const diversityBypassMin = Math.max(20, Math.round(this._maxRetrievedProtos * 0.2 * this._memoryFactor));
            if (maxSimToSelected < effectiveThresh || selectedProtoIndices.length < diversityBypassMin) {
                selectedProtoIndices.push(candIdx);
                this._reinforceProto(candProtos[candIdx], this._baseAccessInc, 0, this._baseImpInc * 0.2, 1.0);
            }
            pi++;
        }

        const selectedProtos = selectedProtoIndices.map(idx => candProtos[idx]);

        return selectedProtos;
    }

};
