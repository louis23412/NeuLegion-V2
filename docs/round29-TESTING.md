# Round 29 → 30 — operator test guide (commands in order + what to send back)

This is the **final** state of the round-29 work. `PLAN-round29.md` is implemented and measured
(P1–P4; P6/P7 closed by gate G-A), with **one explicitly-conditional item not built: P5
(continuous TTA)** — it is deferred with gate **G-D OPEN** (`RUN-ANALYSIS.md` §16.6, `TODO.md` 96),
by the plan's own DoD item 4 ("*If* P5 is built…"). Everything else is frozen and green.

Run every command from the **repository root** (the directory containing `package.json`), i.e.
`src/NeuLegion-master/NeuLegion-master/` in the shipped tree.

---

## 0. Prerequisites (once)

* **Node ≥ 22** (`node -v`) — the test script passes a glob to `node --test`, which needs ≥ 22
  (`BUGS.md` #14).
* `npm install` — the only runtime dependency is `better-sqlite3`; the test suite also needs it.

```bash
npm install
```

---

## 1. The full test suite (the gate — run this FIRST)

```bash
npm test
```

Expect **all green** (`node --test` prints `pass 127`, `fail 0`). This single command is the whole
check: it runs

* the **30 mirrored browser entries → 2558 checks** — all 30 assert zero failures, and **22 of
  them also pin their entry's exact count**, so any drift fails loudly
  (`analyze` 269, `analysis` 621, `candles` 192, `fetcher` 111, `multiprobe` 77, `lsh` 75,
  `observer` 76, `guards` 65, `golden` 23, … — see the table in `RUNBOOK.md` §6), and
* the **13 node-only suites** (real `worker_threads` / SQLite / HTTP / process machinery:
  `parallel_folds`, `analyze_cli`, `checkpoint_throttle`, `report_lifecycle`, `shutdown`,
  `worker_pool`, `runner_smoke`, `dryrun`, `preflight`, `http_view`, `config_env`,
  `engine_portability`, `mirrors`).

> **If anything is red, stop and send me the failing output.** The round is not testable beyond
> this point until the suite is green.

---

## 2. Environment preflight + smoke

```bash
npm run preflight
npm run dryrun
```

`preflight` checks the runtime (Node version, SQLite driver, writable state dir, dataset presence);
`dryrun` is a short end-to-end smoke that must exit 0.

---

## 3. The round-29 acceptance runs

Each writes a run directory. Set the file lists once (bash; adapt if you use another shell):

```bash
CANDLES_15M="src/data/candles_btcusdt_15m.jsonl,src/data/candles_ethusdt_15m.jsonl,src/data/candles_solusdt_15m.jsonl,src/data/candles_bnbusdt_15m.jsonl,src/data/candles_xrpusdt_15m.jsonl,src/data/candles_adausdt_15m.jsonl,src/data/candles_dogeusdt_15m.jsonl,src/data/candles_linkusdt_15m.jsonl"
FUND="src/data/funding_btcusdt_8h.jsonl,src/data/funding_ethusdt_8h.jsonl,src/data/funding_solusdt_8h.jsonl,src/data/funding_bnbusdt_8h.jsonl,src/data/funding_xrpusdt_8h.jsonl,src/data/funding_adausdt_8h.jsonl,src/data/funding_dogeusdt_8h.jsonl,src/data/funding_linkusdt_8h.jsonl"
```

Order matters only in that **3a is the fast sanity run** — do it first and check the box before
committing to the longer ones. Sizing guidance (cost law, measured wall times): `RUNBOOK.md`
"How to test / sizing a run".

### 3a. P2 — configuration-robust promotion + exposure matching (fast)

```bash
npm run analyze -- --symbols=all --bars=200 --train=60 --test=15 --audit-probes=1 --reuse-base --cost-ladder=0,2,5,10 --cadences=10,15,30 --exposure-match
```

In the run's `report.json`, confirm:

* `configurationRobust.cadences` is `[10,15,30]`; every **active** candidate has a
  `configurationRobust.candidates.<id>.promotion` (`available`, `passes`, `promote`, `reasons`);
* `exposureMatched.candidates.<id>.available === true` with `baseline.achievedFraction` ≈
  `candidate.achievedFraction`;
* **nothing else moved**: the `baseline.pooledMetrics` and `candidates[*].pooledMetrics.netSharpe`
  are identical to a run of the same command **without** the last two flags (the passes are pure
  post-processing).

### 3b. P1 — model-class benchmark

```bash
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --variants=bench-base-rate,bench-linear,bench-mlp --cost-ladder=0,2,5,10
```

In `report.json`, confirm the `forecast` block scores `base-rate` / `linear` / `mlp` in the
**probability-calibrated MCS group** beside the baseline, each row carrying `brierSkill` and
`accuracySkill` (the P1 readout is negative: nothing beats the base rate — see `RUN-ANALYSIS.md`
§16.2).

### 3c. P3 — short-horizon reversal on the 15m basket

```bash
npm run analyze -- --files="$CANDLES_15M" --bars=2000 --train=60 --test=15 --audit-probes=1 --reuse-base --variants=sig-reversal,sig-reversal-4,sig-reversal-vol,sig-reversal-xs --cost-ladder=0,2,5,10
```

Confirm the 15m files load (the run reports 8 streams and a candle count ≈ 8 × 2000) and the four
reversal arms appear with `audit.clean`. Expected verdict: **non-acceptance** on cost
(break-even ≪ 5 bps; `RUN-ANALYSIS.md` §16.4).

### 3d. P4 — funding/carry sleeve (+ the P2 chain)

```bash
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --carry-files="$FUND" --cadences=10,15,30 --cost-ladder=0,2,5,10
```

Confirm in `report.json`:

* `carry.panelStreams === 1`, `carry.unavailable` is absent/false, and every symbol row carries its
  `offGrid` / `zeroRates` audit;
* `dependence.streams === 9` and `dependenceWithoutExtras.streams === 8` (the sleeve is an extra
  panel stream, the price-only panel is retained beside it);
* each cadence evaluation in `configurationRobust` carries `panelStreams === 1` (the P4+P2 chain:
  the sleeve survives the cadence restatement).

### 3e. Full-size verdict (optional — the real one; hours)

The identical design at full width with the shipped defaults (all 14 candidates, 8 symbols ×
600 bars, no opt-in additions). This is the run the verdict is read from:

```bash
npm run analyze -- --symbols=all --bars=600 --train=60 --test=15 --audit-probes=1 --reuse-base --concurrency=4 --cost-ladder=0,2,5,10
```

---

## 4. What to send back for me to investigate

**For each run you want me to read**, attach that run's directory (or the files inside it):

| priority | file | why |
| --- | --- | --- |
| **required** | `run.json` | the manifest: config, streams, folds, roster, `trials`, gate options |
| **required** | `report.json` | the canonical verdict: pooled metrics, decisions, audit, power, forecast, `configurationRobust` / `exposureMatched` / `carry` |
| **required** | `run.log` | the structured event journal (a warn/error line is how failures surface) |
| **recommended** | `folds.jsonl` | lets me recompute the pooled metrics and re-run the no-lookahead audit offline |
| optional | `partial-report.json`, `progress.json` | diagnostics only (a checkpoint is *not* a full report) |
| **never** | `models/` | per-fit SQLite state (~0.7 MiB/fit); reclaimed by default anyway |

Runs land under `state/runs/<runId>/`. (The older **retained** journals the round-29 readouts cite —
`20260923T211549-seed1`, `20260924T045601-seed1`, `20260924T071546-seed1`, `20260920T094400-seed1` —
live at `src/<runId>-seed1/` in this generator's tree, *beside* the repo rather than inside it
(`docs/PLAN-round29.md` and `docs/research/round29-*.md` cite them by the shorter
`src/<runId>-seed1/…` path); include one only if you want me to reconcile a fresh run against the
recorded numbers.)

A quick way to bundle one run (keeps every byte):

```bash
tar -czf nl-<runId>.tgz -C state/runs <runId>
```

then attach `nl-<runId>.tgz` to your next message. (If `tar` is unavailable, attach the four files
above directly.)

**If `npm test` is red**, attach the failing output (the `node --test` tail is enough) and tell me
which entry failed; I can re-run any single entry offline.
