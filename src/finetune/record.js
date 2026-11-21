// Appends what the fine-tuning job did (dataset manifest + training metrics) to the variant's state, so the
// report and dashboard can show how much verified data the model was trained on each cycle.
//   node src/finetune/record.js --variant=<name> --dir=<downloaded fine-tuning artifact>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from '../config.js';
import { variantConfig } from '../variants.js';
import { argValue, log } from '../util.js';

export function finetuneRow(manifest, metrics, ts) {
  return { ts, ...manifest, train: metrics };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const variant = argValue(process.argv, 'variant');
  const dir = argValue(process.argv, 'dir');
  if (!variant || !dir) throw new Error('usage: record.js --variant=<name> --dir=<dir>');
  const vc = variantConfig(cfg, variant);
  const ft = cfg.finetune;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const row = finetuneRow(read(ft.manifestFile), read(ft.metricsFile), new Date().toISOString());
  const file = path.join(rootPath(cfg, vc.paths.stateDir), ft.logFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  log(`fine-tuning recorded: ${row.examples} examples, ${row.train.steps} steps, loss ${row.train.lossFirst} -> ${row.train.lossLast}`);
}
