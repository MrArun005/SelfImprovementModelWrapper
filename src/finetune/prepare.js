// Fine-tuning dataset from the system's own verified work (expert iteration / self-distillation):
// every train-phase solution that passed the hidden unit tests, from every MultiPL-E variant, rendered as the
// exact plain prompt the agent sends (seed system prompt, no lessons or skills) -> the passing code.
// Holdout problems are excluded by construction and the exclusion is counted, so leakage would show up.
//   node src/finetune/prepare.js --variant=<finetune variant> --out=<dir> --base-dir=<hf snapshot dir>
// Writes <out>/sft.jsonl, <out>/settings.json (read by tools/finetune/train.py), <out>/manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from '../config.js';
import { variantConfig } from '../variants.js';
import { createMultiplETrack } from '../tracks/multipl-e.js';
import { buildMessages } from '../agent/solve.js';
import { writeJson, argValue, hash32, seededShuffle, log } from '../util.js';

const TRACK = 'multipl-e';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const normalise = (code) => code.replace(/\s+/g, ' ').trim();

/**
 * Pure part (tested): pick training pairs from trace rows.
 * @param rows   trace rows ({variant, problemId, result, code, ts}) from every variant
 * @param train  Set of train problem ids; holdout Set of holdout ids
 * @returns {{picked: Array<{problemId, code, variant, ts}>, excludedHoldout: number, notTrain: number}}
 */
export function selectSolutions(rows, { train, holdout, maxPerProblem, maxExamples, seed }) {
  let excludedHoldout = 0;
  let notTrain = 0;
  const byProblem = new Map();
  const sorted = [...rows].filter((r) => r.result === 'pass' && r.code)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || String(a.variant).localeCompare(String(b.variant)));
  for (const r of sorted) {
    if (holdout.has(r.problemId)) { excludedHoldout++; continue; }
    if (!train.has(r.problemId)) { notTrain++; continue; }
    const list = byProblem.get(r.problemId) ?? [];
    if (list.length >= maxPerProblem || list.some((x) => normalise(x.code) === normalise(r.code))) continue;
    list.push({ problemId: r.problemId, code: r.code, variant: r.variant, ts: r.ts });
    byProblem.set(r.problemId, list);
  }
  let picked = [...byProblem.keys()].sort().flatMap((id) => byProblem.get(id));
  if (picked.length > maxExamples) picked = seededShuffle(picked, seed).slice(0, maxExamples);
  return { picked, excludedHoldout, notTrain };
}

export function completionFor(code, fence) {
  return `${fence}\n${code.trimEnd()}\n\`\`\``;
}

export async function prepare(cfg, { variant, outDir, baseDir }) {
  const vc = variantConfig(cfg, variant);
  if (!vc.variant.levers.finetune) throw new Error(`variant ${variant} does not have the finetune lever`);
  if (vc.track !== TRACK) throw new Error(`fine-tuning is only implemented for the ${TRACK} track`);
  const ft = cfg.finetune;
  const track = await createMultiplETrack(vc);
  const rows = cfg.variants.filter((v) => v.track === TRACK)
    // always the committed state (finetune.sourceStateDir), so a smoke run trains on real data too
    .flatMap((v) => readJsonl(path.join(rootPath(cfg, ft.sourceStateDir), cfg.paths.variantsDir, v.name, cfg.paths.traces)).map((r) => ({ ...r, variant: r.variant ?? v.name })));
  const { picked, excludedHoldout, notTrain } = selectSolutions(rows, {
    train: new Set(track.train), holdout: new Set(track.holdout), maxPerProblem: ft.maxSolutionsPerProblem, maxExamples: ft.maxExamples, seed: ft.seed,
  });
  const systemPrompt = fs.readFileSync(rootPath(cfg, cfg.paths.seedPrompt), 'utf8');
  const lines = picked.map((p) => JSON.stringify({
    problemId: p.problemId,
    messages: buildMessages({ systemPrompt, userTemplate: track.templates.solveUser, problem: track.tasks.get(p.problemId), lessons: [], skills: [], cfg: vc }),
    completion: completionFor(p.code, ft.completionFence),
  }));
  fs.mkdirSync(outDir, { recursive: true });
  const datasetFile = path.join(outDir, ft.datasetFile);
  fs.writeFileSync(datasetFile, lines.length ? `${lines.join('\n')}\n` : '');
  const sources = {};
  for (const p of picked) sources[p.variant] = (sources[p.variant] ?? 0) + 1;
  const manifest = {
    variant, examples: picked.length, problems: new Set(picked.map((p) => p.problemId)).size, sources, excludedHoldout, notTrain,
    datasetHash: hash32(lines.join('\n')), baseModel: ft.baseModel, baseRevision: ft.baseRevision,
  };
  const t = ft.train;
  writeJson(path.join(outDir, ft.settingsFile), {
    ...t, seed: ft.seed, baseDir: path.resolve(baseDir), datasetFile: path.resolve(datasetFile),
    adapterDir: path.resolve(outDir, ft.adapterDir), metricsFile: path.resolve(outDir, ft.metricsFile),
    mergedDir: path.resolve(outDir, ft.mergedDir), mergedDtype: ft.mergedDtype, checkpointDir: path.resolve(outDir, ft.checkpointDir),
  });
  writeJson(path.join(outDir, ft.manifestFile), manifest);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const variant = argValue(process.argv, 'variant') ?? cfg.variants.find((v) => v.levers?.finetune)?.name;
  const outDir = argValue(process.argv, 'out');
  const baseDir = argValue(process.argv, 'base-dir');
  if (!variant || !outDir || !baseDir) throw new Error('usage: prepare.js --variant=<name> --out=<dir> --base-dir=<dir>');
  const m = await prepare(cfg, { variant, outDir, baseDir });
  log(`fine-tuning set: ${m.examples} verified solutions for ${m.problems} train problems (${JSON.stringify(m.sources)}); ${m.excludedHoldout} holdout rows excluded`);
  if (m.excludedHoldout) log('note: holdout rows found in traces were excluded (traces are train-only, so this should be 0)');
}
