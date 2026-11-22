// Decides whether a scheduled run should train today. The workflow has backup cron times because GitHub
// sometimes drops scheduled runs; this guard makes sure only ONE cycle per UTC day happens: the first trigger
// that finds a variant without a cycle today runs; later backups find every variant done and skip everything.
//   node src/ci/due.js [--force] >> "$GITHUB_OUTPUT"   -> due=true|false and a human-readable reason
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from '../config.js';
import { variantStateDir, activeVariants } from '../variants.js';
import { today, ISO_DATE_LEN } from '../util.js';

export function isDue(cfg, { force = false, now = new Date() } = {}) {
  if (force) return { due: true, reason: 'forced' };
  const day = today(now);
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const pending = activeVariants(cfg).filter((v) => {
    const dir = rootPath(cfg, variantStateDir(cfg, v.name));
    // run-state.lastRunDay; for cycles written before that field existed, last-run.json's timestamp
    const ranOn = read(path.join(dir, cfg.paths.runState))?.lastRunDay ?? read(path.join(dir, cfg.paths.lastRun))?.timestamp?.slice(0, ISO_DATE_LEN);
    return ranOn !== day;
  }).map((v) => v.name);
  return pending.length ? { due: true, reason: `no cycle yet today (${day}) for: ${pending.join(', ')}` } : { due: false, reason: `every variant already ran today (${day})` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force') || process.env.SIC_FORCE === '1' || process.env.SIC_SMOKE === '1';
  const r = isDue(loadConfig(), { force });
  console.log(`due=${r.due}`);
  console.error(`due: ${r.reason}`);
}
