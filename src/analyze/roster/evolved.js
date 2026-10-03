// src/analyze/roster/evolved.js — the B3 evolved-readout genome instrument.
//
// The genome is the per-member LINEAR readout the B2b/B3 probes validated
// (lab CYCLE-220…222): `{ members: [{ w: [...hidden], b }] }`, one entry per
// ensemble member. `applyGenomeToMind` writes it into
// `transformer.outputWeights`/`outputBias` — the only linear map from the
// mean-pooled hidden state to a member's output
// (`hivemind/transformer/forward.js`). Everything upstream stays frozen.
//
// Fail-closed: a shape mismatch or non-finite value throws before anything
// is written (a half-applied genome would be silent corruption). A null
// genome is a no-op, so the registered `evolved-readout` variant is
// bit-identical to stock until a driver injects one.
export function validateGenome(genome, mind) {
  if (!mind || !Array.isArray(mind._transformers) || !mind._transformers.length) {
    return { ok: false, reason: 'mind carries no _transformers ensemble' };
  }
  if (!genome || !Array.isArray(genome.members)) {
    return { ok: false, reason: 'genome needs a members array' };
  }
  if (genome.members.length !== mind._transformers.length) {
    return { ok: false, reason: `genome has ${genome.members.length} members for a ${mind._transformers.length}-member mind` };
  }
  for (let i = 0; i < genome.members.length; i++) {
    const m = genome.members[i];
    const t = mind._transformers[i];
    const hidden = t.outputWeights ? t.outputWeights.length : -1;
    if (!m || !Array.isArray(m.w) || m.w.length !== hidden) {
      return { ok: false, reason: `member ${i}: genome width ${m && m.w ? m.w.length : '?'} != readout width ${hidden}` };
    }
    if (!m.w.every(Number.isFinite) || !Number.isFinite(m.b)) {
      return { ok: false, reason: `member ${i}: genome carries a non-finite value` };
    }
    if (!t.outputBias || t.outputBias.length !== 1) {
      return { ok: false, reason: `member ${i}: mind has no scalar outputBias` };
    }
  }
  return { ok: true, reason: null };
}

export function applyGenomeToMind(mind, genome) {
  const v = validateGenome(genome, mind);
  if (!v.ok) throw new Error(`evolved-readout: refusing to apply genome (${v.reason})`);
  genome.members.forEach((m, i) => {
    const t = mind._transformers[i];
    m.w.forEach((val, j) => { t.outputWeights[j][0] = val; });
    t.outputBias[0] = m.b;
  });
  return true;
}

export function snapshotGenome(mind) {
  if (!mind || !Array.isArray(mind._transformers) || !mind._transformers.length) {
    throw new Error('evolved-readout: cannot snapshot a mind with no _transformers ensemble');
  }
  return {
    members: mind._transformers.map((t) => ({
      w: t.outputWeights.map((r) => r[0]),
      b: t.outputBias[0],
    })),
  };
}
