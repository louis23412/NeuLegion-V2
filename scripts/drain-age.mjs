// drain-age.mjs — held-bars read (lab CYCLE-192 TODO: read the heldBars
// distribution before any drain change). READ-ONLY: opens controller DBs
// with `{ readonly: true }`, never writes, never trains.
//
// NOTE (measured limitation): `closed_trades` does not persist per-trade
// heldBars (trades.js label lifecycle); the sanctioned record is the
// `global_stats` held_bars_sum/count/max aggregates, which is what this
// prints, plus the closed-trade count as a consistency check.
//
// Usage: node scripts/drain-age.mjs [--dir <stateDir>]
//   --dir defaults to $NEULEGION_STATE, else ./state. Paste back stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : []
  )
);
const DIR = args.dir || process.env.NEULEGION_STATE || path.join(ROOT, 'state');

try {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^hivemind_controller-.*\.db$/.test(f)) : [];
  if (files.length === 0) {
    console.log(`drain-age: no controller DBs in ${DIR} (pass --dir <stateDir>). Nothing to read.`);
    process.exit(0);
  }
  for (const f of files) {
    const db = new Database(path.join(DIR, f), { readonly: true });
    try {
      const get = (k) => {
        try {
          const r = db.prepare('SELECT value FROM global_stats WHERE key = ?').get(k);
          return r ? Number(r.value) : 0;
        } catch { return 0; }
      };
      const sum = get('held_bars_sum'), cnt = get('held_bars_count'), mx = get('held_bars_max');
      let closed = 0;
      try { closed = db.prepare('SELECT COUNT(*) AS n FROM closed_trades').get().n; } catch { closed = -1; }
      const mean = cnt > 0 ? sum / cnt : 0;
      console.log(`drain-age ${f}: closed=${closed} heldCount=${cnt} mean=${mean.toFixed(2)} max=${mx}`);
    } finally {
      db.close();
    }
  }
} catch (e) {
  console.error(`drain-age FATAL: ${e && e.stack ? e.stack : e}`.slice(0, 1000));
  process.exit(1);
}
