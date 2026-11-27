// Recursive self-improvement rounds (see src/rsi/core.js and .github/workflows/rsi.yml). One subcommand per job:
//   node src/rsi/cli.js plan                                          -> GITHUB_OUTPUT lines for this round
//   node src/rsi/cli.js search  --round=r --shard=i --model=<served name> --out=<file>
//   node src/rsi/cli.js exam    --model-round=m --shard=i --model=<served name> --out=<file>
//   node src/rsi/cli.js prepare --round=r --search-dir=<dir> --out=<dir> --base-dir=<hf dir>
//   node src/rsi/cli.js record  --round=r --run-id=<id> --search-dir=<dir> --exam-dir=<dir> --train-dir=<dir>
// search and exam run model-written code in the sandbox (src/judge); they need no credentials.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from '../config.js';
import { variantConfig } from '../variants.js';
import { createTrack } from '../tracks/index.js';
import { createLLM } from '../llm/index.js';
import { buildMessages } from '../agent/solve.js';
import { completionFor } from '../finetune/prepare.js';
import { argValue, hash32, log, writeJson, MS_PER_MINUTE } from '../util.js';
import { rsiSplit, rsiShardOf, planRound, sampleSeed, selectTraining, passAt1, compareModels, rsiVerdict } from './core.js';
import { rsiReport } from './report.js';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const writeJsonl = (f, rows) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); };
const jsonlIn = (dir) => (dir && fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(dir, f))) : []);

export function rsiFiles(cfg) {
  const dir = rootPath(cfg, cfg.rsi.stateDir);
  const f = cfg.rsi.files;
  return { dir, rounds: path.join(dir, f.rounds), solutions: path.join(dir, f.solutions), search: path.join(dir, f.searchStats), exam: path.join(dir, f.exam), report: rootPath(cfg, cfg.rsi.reportFile) };
}

async function setup(cfg, model, deps = {}) {
  const vc = variantConfig(cfg, cfg.rsi.promptVariant);
  const runCfg = { ...vc, llm: { ...vc.llm, model } };
  const track = deps.track ?? (await createTrack(runCfg, deps));
  const split = rsiSplit(track.train, track.holdout, cfg.rsi);
  const llm = deps.llm ?? createLLM(runCfg, deps);
  const sys = fs.readFileSync(rootPath(cfg, cfg.paths.seedPrompt), 'utf8');
  const messagesFor = (task) => buildMessages({ systemPrompt: sys, userTemplate: track.templates.solveUser, problem: task, lessons: [], skills: [], cfg: vc });
  return { track, split, llm, messagesFor };
}

/** k samples per problem of this shard of the search pool; every sample judged by the train problem's tests. */
export async function searchShard(cfg, { round, shard, model, out, deps = {} }) {
  const s = cfg.rsi.search;
  const { track, split, llm, messagesFor } = await setup(cfg, model, deps);
  const ids = split.pool.filter((id) => rsiShardOf(id, s.shards) === shard);
  const exam = new Set(split.exam);
  const deadline = (deps.now?.() ?? Date.now()) + s.maxMinutes * MS_PER_MINUTE;
  const rows = [];
  let samples = 0;
  for (const id of ids) {
    if ((deps.now?.() ?? Date.now()) > deadline) break;
    if (exam.has(id)) throw new Error(`exam problem ${id} selected for search`);
    const task = track.tasks.get(id);
    const passing = [];
    for (let k = 0; k < s.samples; k++) {
      const reply = await llm.chat(messagesFor(task), { temperature: s.temperature, seed: sampleSeed(cfg.llm.seed, cfg.llm.trainSeedRange, 'rsi-search', id, k, round), meta: { kind: 'rsi-search', problemId: id } });
      samples++;
      const code = track.extractCode(reply, task);
      if ((await track.judge(code, task)).type === 'pass') passing.push(code);
    }
    const passFraction = passing.length / s.samples;
    rows.push({ kind: 'stat', round, problemId: id, samples: s.samples, passed: passing.length, passFraction, model });
    const kept = new Set();
    for (const code of passing) {
      const norm = code.replace(/\s+/g, ' ').trim();
      if (kept.has(norm) || kept.size >= s.keepPerProblem) continue;
      kept.add(norm);
      rows.push({ kind: 'solution', round, problemId: id, result: 'pass', passFraction, code, model });
    }
    writeJsonl(out, rows); // after every problem: a job that hits its time limit keeps what it found
  }
  writeJsonl(out, rows);
  const stats = rows.filter((r) => r.kind === 'stat');
  const summary = { round, shard, problems: ids.length, searched: stats.length, samples, solved: stats.filter((r) => r.passed > 0).length };
  log(`rsi search ${JSON.stringify(summary)}`);
  return summary;
}

/** The exam: n independent single attempts per exam problem (no search, no tests shown), same seeds for every model. */
export async function examShard(cfg, { modelRound, shard, model, out, deps = {} }) {
  const e = cfg.rsi.eval;
  const { track, split, llm, messagesFor } = await setup(cfg, model, deps);
  const ids = split.exam.filter((id) => rsiShardOf(id, e.shards) === shard);
  const deadline = (deps.now?.() ?? Date.now()) + e.maxMinutes * MS_PER_MINUTE;
  const rows = [];
  for (const id of ids) {
    if ((deps.now?.() ?? Date.now()) > deadline) break;
    const task = track.tasks.get(id);
    let passed = 0;
    for (let k = 0; k < e.samples; k++) {
      const reply = await llm.chat(messagesFor(task), { temperature: e.temperature, seed: sampleSeed(cfg.llm.seed, cfg.llm.trainSeedRange, 'rsi-exam', id, k), meta: { kind: 'rsi-exam', problemId: id } });
      if ((await track.judge(track.extractCode(reply, task), task)).type === 'pass') passed++;
    }
    rows.push({ modelRound, problemId: id, samples: e.samples, passed, model });
    writeJsonl(out, rows);
  }
  writeJsonl(out, rows);
  log(`rsi exam model r${modelRound} shard ${shard}: ${rows.length}/${ids.length} problems, pass@1 ${(rows.reduce((a, r) => a + r.passed / r.samples, 0) / Math.max(1, rows.length)).toFixed(3)}`); // allow-number: display precision
  return rows;
}

/** Training set for round r: every verified search solution so far (committed rounds + this round's shards). */
export async function prepareRound(cfg, { round, searchDir, outDir, baseDir, deps = {} }) {
  const rsi = cfg.rsi;
  const ft = cfg.finetune;
  const { track, split, messagesFor } = await setup(cfg, cfg.llm.model, deps);
  const files = rsiFiles(cfg);
  const earlier = rsi.data.cumulative ? readJsonl(files.solutions).filter((r) => r.round < round) : [];
  const fresh = jsonlIn(searchDir).filter((r) => r.kind === 'solution').map((r) => ({ ...r, round }));
  const sel = selectTraining([...earlier, ...fresh], { pool: split.pool, exam: split.exam, ...rsi.data, seed: rsi.data.seed + round });
  if (sel.leaked) throw new Error(`${sel.leaked} exam-problem rows reached the training data`);
  const lines = sel.examples.map((x) => JSON.stringify({ problemId: x.problemId, messages: messagesFor(track.tasks.get(x.problemId)), completion: completionFor(x.code, ft.completionFence) }));
  fs.mkdirSync(outDir, { recursive: true });
  const datasetFile = path.join(outDir, ft.datasetFile);
  fs.writeFileSync(datasetFile, lines.length ? `${lines.join('\n')}\n` : '');
  const manifest = { round, examples: sel.examples.length, problems: sel.problems, hardProblems: sel.hardProblems, freshSolutions: fresh.length,
    earlierSolutions: earlier.length, examLeaks: sel.leaked, datasetHash: hash32(lines.join('\n')), baseModel: ft.baseModel, baseRevision: ft.baseRevision };
  writeJson(path.join(outDir, ft.settingsFile), {
    ...ft.train, ...rsi.train, seed: ft.seed + round, baseDir: path.resolve(baseDir), datasetFile: path.resolve(datasetFile),
    adapterDir: path.resolve(outDir, ft.adapterDir), metricsFile: path.resolve(outDir, ft.metricsFile),
    mergedDir: path.resolve(outDir, ft.mergedDir), mergedDtype: ft.mergedDtype, checkpointDir: path.resolve(outDir, ft.checkpointDir),
  });
  writeJson(path.join(outDir, ft.manifestFile), manifest);
  log(`rsi round ${round} training set: ${JSON.stringify(manifest)}`);
  return manifest;
}

const statsOpts = (cfg, salt) => ({ resamples: cfg.stats.bootstrapResamples, confidence: cfg.stats.confidence, seed: cfg.stats.seed + hash32(salt) % cfg.llm.trainSeedRange });

/** Pure-ish: fold one finished round into the recorded state; returns the new state (nothing written). */
export function foldRound(cfg, state, { round, runId, ts, searchModel, searchRows, examRows, manifest, metrics }) {
  const stats = searchRows.filter((r) => r.kind === 'stat').map((r) => ({ ...r, round }));
  const sols = searchRows.filter((r) => r.kind === 'solution').map((r) => ({ ...r, round }));
  const exam = [...state.exam.filter((r) => !examRows.some((x) => x.modelRound === r.modelRound)), ...examRows];
  const of = (m) => passAt1(exam.filter((r) => r.modelRound === m));
  const cur = of(round);
  const summary = {
    round, runId, ts, searchModel,
    search: { problems: stats.length, solved: stats.filter((r) => r.passed > 0).length, meanPassFraction: stats.length ? stats.reduce((a, r) => a + r.passFraction, 0) / stats.length : null, solutionsKept: sols.length },
    data: manifest ?? null,
    train: metrics ?? null,
    exam: { problems: cur.size, passAt1: cur.size ? [...cur.values()].reduce((a, b) => a + b, 0) / cur.size : null },
    vsBase: compareModels(of(0), cur, statsOpts(cfg, `rsi-base-${round}`)),
    vsPrevious: compareModels(of(round - 1), cur, statsOpts(cfg, `rsi-prev-${round}`)),
  };
  const base = of(0);
  return {
    rounds: [...state.rounds.filter((r) => r.round !== round), summary].sort((a, b) => a.round - b.round),
    solutions: [...state.solutions.filter((r) => r.round !== round), ...sols],
    search: [...state.search.filter((r) => r.round !== round), ...stats],
    exam,
    baseExam: { problems: base.size, passAt1: base.size ? [...base.values()].reduce((a, b) => a + b, 0) / base.size : null },
  };
}

function main() {
  const cfg = loadConfig();
  const [cmd] = process.argv.slice(2);
  const arg = (k) => argValue(process.argv, k);
  const num = (k) => { const v = Number(arg(k)); if (!Number.isInteger(v)) throw new Error(`--${k}=<integer> required`); return v; };
  const files = rsiFiles(cfg);
  const rounds = fs.existsSync(files.rounds) ? JSON.parse(fs.readFileSync(files.rounds, 'utf8')) : [];
  if (cmd === 'plan') {
    const p = planRound(cfg.rsi, rounds, cfg.llm.model);
    const out = { ...p, enabled: String(Boolean(cfg.rsi.enabled)), search_minutes: cfg.rsi.search.jobMinutes, exam_minutes: cfg.rsi.eval.jobMinutes, train_minutes: cfg.rsi.trainJobMinutes,
      artifact_prefix: cfg.rsi.artifactPrefix, retention_days: cfg.rsi.artifactRetentionDays, state_dir: cfg.rsi.stateDir, report_file: cfg.rsi.reportFile, max_parallel: cfg.rsi.maxParallel };
    for (const [k, v] of Object.entries(out)) {
      if (/[\r\n]/.test(String(v))) throw new Error(`value for ${k} contains a newline`);
      console.log(`${k}=${v}`);
    }
    return null;
  }
  if (cmd === 'search') return searchShard(cfg, { round: num('round'), shard: num('shard'), model: arg('model'), out: arg('out') });
  if (cmd === 'exam') return examShard(cfg, { modelRound: num('model-round'), shard: num('shard'), model: arg('model'), out: arg('out') });
  if (cmd === 'prepare') return prepareRound(cfg, { round: num('round'), searchDir: arg('search-dir'), outDir: arg('out'), baseDir: arg('base-dir') });
  if (cmd === 'record') {
    const round = num('round');
    const trainDir = arg('train-dir');
    const readIf = (f) => (trainDir && fs.existsSync(path.join(trainDir, f)) ? JSON.parse(fs.readFileSync(path.join(trainDir, f), 'utf8')) : null);
    const searchRows = jsonlIn(arg('search-dir'));
    const state = { rounds, solutions: readJsonl(files.solutions), search: readJsonl(files.search), exam: readJsonl(files.exam) };
    const next = foldRound(cfg, state, { round, runId: arg('run-id'), ts: new Date().toISOString(), searchModel: searchRows.find((r) => r.model)?.model ?? null,
      searchRows, examRows: jsonlIn(arg('exam-dir')), manifest: readIf(cfg.finetune.manifestFile), metrics: readIf(cfg.finetune.metricsFile) });
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(files.rounds, `${JSON.stringify(next.rounds, null, 2)}\n`);
    writeJsonl(files.solutions, next.solutions);
    writeJsonl(files.search, next.search);
    writeJsonl(files.exam, next.exam);
    const plan = planRound(cfg.rsi, next.rounds, cfg.llm.model);
    const verdict = rsiVerdict(cfg.rsi.preregistered, next.rounds);
    fs.writeFileSync(files.report, rsiReport(cfg, next, verdict, plan.stop));
    const r = next.rounds.at(-1);
    log(`rsi round ${round}: exam pass@1 ${r.exam.passAt1}, vs base ${JSON.stringify(r.vsBase)}, vs previous ${JSON.stringify(r.vsPrevious)}`);
    const flag = `continue=${plan.stop ? 'false' : 'true'}`;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${flag}\n`);
    log(flag);
    return null;
  }
  throw new Error('usage: cli.js plan|search|exam|prepare|record ...');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
