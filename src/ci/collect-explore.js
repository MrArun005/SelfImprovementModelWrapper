// Used by the aggregate job: merge every exploration shard's verified solutions into the committed exploration file
// (append, de-duplicated by problem + normalised code, holdout problems rejected). Data only; nothing is executed.
//   node src/ci/collect-explore.js <download dir>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath, statePath } from '../config.js';
import { variantConfig } from '../variants.js';
import { log } from '../util.js';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const key = (r) => `${r.problemId}\u0000${String(r.code).replace(/\s+/g, ' ').trim()}`;

export function mergeExploration(existing, incoming, holdout) {
  const seen = new Set(existing.map(key));
  const added = [];
  let rejected = 0;
  for (const r of incoming) {
    if (r.result !== 'pass' || r.track !== 'multipl-e' || typeof r.code !== 'string') continue;
    if (holdout.has(r.problemId)) { rejected++; continue; }
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    added.push(r);
  }
  return { rows: [...existing, ...added], added: added.length, rejected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const dir = process.argv[2];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
  const split = JSON.parse(fs.readFileSync(statePath(variantConfig(cfg, cfg.explore.promptVariant), 'split'), 'utf8'));
  const out = rootPath(cfg, cfg.explore.outFile);
  const { rows, added, rejected } = mergeExploration(readJsonl(out), files.flatMap(readJsonl), new Set(split.holdout));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  log(`exploration: +${added} verified solutions from ${files.length} shard file(s) (${rows.length} total; ${rejected} holdout rows rejected)`);
  if (rejected) process.exitCode = 1;
}
