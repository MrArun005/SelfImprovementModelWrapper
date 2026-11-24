// Exploration: find new verified solutions to train problems no variant has solved yet, to feed fine-tuning.
// One shard of a CI matrix: problems are split across shards by a stable hash; each shard draws `samples` hot samples
// per problem from its model, judges every sample with that TRAIN problem's tests (in the sandbox), and writes the
// passing, distinct solutions as trace rows. Holdout problems are never sampled (asserted).
//   node src/explore.js --shard=<i> --model=<config key> --out=<file>
// A shard with a larger model (e.g. 7B) is distillation: its verified solutions teach the 1.5B model what it lacks;
// rows record which model found them.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from './config.js';
import { variantConfig } from './variants.js';
import { createTrack } from './tracks/index.js';
import { createLLM } from './llm/index.js';
import { buildMessages } from './agent/solve.js';
import { argValue, hash32, log, today, MS_PER_MINUTE } from './util.js';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Train problems with no passing trace anywhere (every variant + earlier exploration), sorted. */
export function unsolvedTrain(cfg, train, holdout) {
  const solved = new Set();
  const files = [
    ...cfg.variants.filter((v) => v.track === 'multipl-e').map((v) => path.join(rootPath(cfg, cfg.finetune.sourceStateDir), cfg.paths.variantsDir, v.name, cfg.paths.traces)),
    ...(cfg.finetune.extraTraceFiles ?? []).map((f) => rootPath(cfg, f)),
  ];
  for (const f of files) for (const r of readJsonl(f)) if (r.result === 'pass') solved.add(r.problemId);
  return train.filter((id) => !solved.has(id) && !holdout.has(id)).sort();
}

/** Stable shard assignment: a problem always lands in the same shard of `of`. */
export const shardOf = (id, of) => hash32(`explore:${id}`) % of;

export async function exploreShard(cfg, { shard, modelKey, out, deps = {} }) {
  const ex = cfg.explore;
  const m = ex.models[modelKey];
  if (!m) throw new Error(`unknown explore model ${modelKey}; known: ${Object.keys(ex.models).join(', ')}`);
  const shards = ex.shards.filter((s) => s.model === modelKey).length;
  const index = ex.shards.filter((s) => s.model === modelKey).findIndex((s) => s.shard === shard);
  if (index < 0) throw new Error(`shard ${shard} is not configured for ${modelKey}`);
  const vc = variantConfig(cfg, ex.promptVariant);
  const runCfg = { ...vc, llm: { ...vc.llm, model: m.model } };
  const track = deps.track ?? (await createTrack(runCfg, deps));
  const holdout = new Set(track.holdout);
  const ids = unsolvedTrain(runCfg, track.train, holdout).filter((id) => shardOf(id, shards) === index).slice(0, m.maxProblems);
  const llm = deps.llm ?? createLLM(runCfg, deps);
  const sys = fs.readFileSync(rootPath(cfg, cfg.paths.seedPrompt), 'utf8');
  const deadline = Date.now() + m.maxMinutes * MS_PER_MINUTE;
  // seeds differ per day, so a problem that stays unsolved gets fresh samples every day
  const day = today(deps.now?.() ?? new Date());
  const rows = [];
  let tried = 0, samples = 0, passing = 0, solved = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break;
    if (holdout.has(id)) throw new Error(`holdout problem ${id} selected for exploration`);
    const task = track.tasks.get(id);
    const messages = buildMessages({ systemPrompt: sys, userTemplate: track.templates.solveUser, problem: task, lessons: [], skills: [], cfg: vc });
    const seen = new Set();
    tried++;
    let any = false;
    for (let k = 0; k < m.samples; k++) {
      const reply = await llm.chat(messages, { temperature: ex.temperature, seed: cfg.llm.seed + hash32(`${id}|${modelKey}|${k}|${day}`) % cfg.llm.trainSeedRange, meta: { kind: 'explore', problemId: id } });
      samples++;
      const code = track.extractCode(reply, task);
      const res = await track.judge(code, task);
      if (res.type !== 'pass') continue;
      passing++;
      any = true;
      const norm = code.replace(/\s+/g, ' ').trim();
      if (seen.has(norm) || seen.size >= ex.keepPerProblem) continue;
      seen.add(norm);
      rows.push({ runId: deps.runId ?? 'explore', ts: (deps.now?.() ?? new Date()).toISOString(), variant: `explore-${modelKey}`, track: 'multipl-e', problemId: id, attempt: 1,
        result: 'pass', failureClass: 'pass', code, source: `exploration: ${m.model}, ${m.samples} samples at temperature ${ex.temperature}, verified by the train problem's tests` });
    }
    if (any) solved++;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const summary = { shard, model: modelKey, unsolvedInShard: ids.length, tried, samples, passingSamples: passing, newlySolved: solved, solutionsKept: rows.length };
  log(`explore ${JSON.stringify(summary)}`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const shard = Number(argValue(process.argv, 'shard'));
  const modelKey = argValue(process.argv, 'model');
  const out = argValue(process.argv, 'out');
  if (!Number.isInteger(shard) || !modelKey || !out) throw new Error('usage: explore.js --shard=<i> --model=<key> --out=<file>');
  const runId = (process.env.GITHUB_RUN_ID ? `gh${process.env.GITHUB_RUN_ID}-` : '') + `explore-${shard}`;
  await exploreShard(cfg, { shard, modelKey, out, deps: { runId } });
}
