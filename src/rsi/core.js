// Recursive self-improvement by expert iteration, in rounds (the pure, tested part).
//   round r:  model M(r-1) + search (k samples per train problem, judged by the problem's tests) -> verified solutions
//             -> LoRA fine-tune of the base model on every round's verified solutions so far -> M(r)
//             -> exam: M(r), one attempt per sample (no search, no tests shown), on problems it never trains on.
// M(0) is the untrained base. The claim "it improves itself" is judged only on the exam set, M(r) vs M(0) and
// M(r) vs M(r-1), paired per problem; how much it solves of its own training problems is reported but is not evidence.
import { hash32, seededShuffle } from '../util.js';
import { bootstrapCI, pairedBootstrapP, mean } from '../stats.js';

const normalise = (code) => String(code).replace(/\s+/g, ' ').trim();

/**
 * Exam set = the track's holdout + `extra` train problems picked by a fixed seed; search pool = the other train
 * problems. Neither ever changes (same inputs, same split), and the two never overlap.
 */
export function rsiSplit(train, holdout, { evalExtraFromTrain, evalSeed }) {
  const extra = seededShuffle([...train].sort(), evalSeed).slice(0, evalExtraFromTrain);
  const exam = [...holdout, ...extra].sort();
  const examSet = new Set(exam);
  const pool = [...train].filter((id) => !examSet.has(id)).sort();
  return { exam, pool };
}

/** Stable assignment of a problem to one of `of` shards. */
export const rsiShardOf = (id, of) => hash32(`rsi:${id}`) % of;

/** Ollama name of round r's model (r = 0 is the untrained base, re-quantized by the same pipeline). */
export const roundModel = (rsi, r) => `${rsi.modelName}-r${r}`;
export const roundArtifact = (rsi, r) => `${rsi.artifactPrefix}-model-r${r}`;

/**
 * What the next round does, from the rounds recorded so far.
 * Stops after maxRounds, or once `stopAfterNonImproving` rounds in a row did not beat the round before them.
 */
export function planRound(rsi, rounds, llmModel) {
  const done = [...rounds].sort((a, b) => a.round - b.round);
  const last = done.at(-1);
  const round = (last?.round ?? 0) + 1;
  const tail = done.slice(-rsi.stopAfterNonImproving);
  const stalled = tail.length >= rsi.stopAfterNonImproving && tail.every((r) => !(r.vsPrevious?.estimate > 0));
  const stop = round > rsi.maxRounds ? 'max-rounds' : stalled ? 'stalled' : '';
  const searchShards = Array.from({ length: rsi.search.shards }, (_, i) => i);
  const evalShards = Array.from({ length: rsi.eval.shards }, (_, i) => i);
  const models = round === 1 ? [0, round] : [round];
  return {
    round,
    stop,
    // round 1 searches with the stock base model; later rounds with the previous round's model (another run's artifact)
    search_model: round === 1 ? llmModel : roundModel(rsi, round - 1),
    search_served: String(round > 1),
    prev_run_id: last?.runId ?? '',
    prev_artifact: round > 1 ? roundArtifact(rsi, round - 1) : '',
    model_name: roundModel(rsi, round),
    model_artifact: roundArtifact(rsi, round),
    base_name: roundModel(rsi, 0),
    base_artifact: roundArtifact(rsi, 0),
    build_base: String(round === 1),
    search_matrix: JSON.stringify(searchShards),
    eval_matrix: JSON.stringify(models.flatMap((m) => evalShards.map((shard) => ({ model: m, shard, name: roundModel(rsi, m), artifact: roundArtifact(rsi, m) })))),
  };
}

/** Seed of sample k of problem id: the same for every model on the exam (paired), fresh every round in the search. */
export function sampleSeed(base, range, ...parts) {
  return base + hash32(parts.join('|')) % range;
}

/**
 * Training pairs from verified search solutions (every round so far, newest kept first per problem).
 * Problems the model solved in at most `hardPassFraction` of its samples are "hard wins": up to maxPerProblem distinct
 * solutions, each repeated hardWeight times; problems it already solves every time get one solution (little to learn).
 * Exam problems are rejected (counted); a non-zero count means a leak and the caller fails the job.
 */
export function selectTraining(rows, { pool, exam, maxPerProblem, hardPassFraction, hardWeight, maxExamples, seed }) {
  const poolSet = new Set(pool);
  const examSet = new Set(exam);
  let leaked = 0;
  const byProblem = new Map();
  const sorted = [...rows].sort((a, b) => b.round - a.round || String(a.problemId).localeCompare(String(b.problemId)));
  for (const r of sorted) {
    if (examSet.has(r.problemId)) { leaked++; continue; }
    if (!poolSet.has(r.problemId) || r.result !== 'pass' || typeof r.code !== 'string') continue;
    const e = byProblem.get(r.problemId) ?? { problemId: r.problemId, passFraction: r.passFraction, solutions: [] };
    if (e.solutions.length < maxPerProblem && !e.solutions.some((s) => normalise(s) === normalise(r.code))) e.solutions.push(r.code);
    byProblem.set(r.problemId, e);
  }
  const entries = [...byProblem.values()].sort((a, b) => a.problemId.localeCompare(b.problemId));
  const hard = entries.filter((e) => e.passFraction <= hardPassFraction);
  const easy = entries.filter((e) => !(e.passFraction <= hardPassFraction));
  const examples = [];
  for (const e of hard) for (const code of e.solutions) for (let w = 0; w < hardWeight; w++) examples.push({ problemId: e.problemId, code, hard: true });
  for (const e of seededShuffle(easy, seed)) {
    if (examples.length >= maxExamples) break;
    examples.push({ problemId: e.problemId, code: e.solutions[0], hard: false });
  }
  return { examples: examples.slice(0, maxExamples), leaked, problems: entries.length, hardProblems: hard.length };
}

/** Per-problem pass@1 (passed / samples) of one model, from exam rows {problemId, passed, samples}. */
export function passAt1(rows) {
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.problemId) ?? { passed: 0, samples: 0 };
    e.passed += r.passed;
    e.samples += r.samples;
    m.set(r.problemId, e);
  }
  return new Map([...m].map(([id, e]) => [id, e.samples ? e.passed / e.samples : 0]));
}

/** Paired comparison of two models' per-problem pass@1 over the problems both were examined on. */
export function compareModels(a, b, { resamples, confidence, seed }) {
  const ids = [...a.keys()].filter((id) => b.has(id)).sort();
  const xa = ids.map((id) => a.get(id));
  const xb = ids.map((id) => b.get(id));
  const ci = bootstrapCI(xb.map((v, i) => v - xa[i]), { resamples, confidence, seed });
  const pValue = pairedBootstrapP(xa, xb, { resamples, seed });
  return { n: ids.length, a: mean(xa), b: mean(xb), estimate: ci.estimate, low: ci.low, high: ci.high, pValue, significant: ci.low > 0 || ci.high < 0 };
}

/**
 * The pre-registered verdict (config rsi.preregistered), computed the same way whatever the numbers are.
 * Recursive self-improvement is claimed only if round `primaryRound` beats the base with a 95% CI above zero AND
 * it beats round 1 (later rounds add to the first: compounding, not a one-off gain).
 */
export function rsiVerdict(spec, rounds) {
  const target = rounds.find((r) => r.round === spec.primaryRound);
  if (!target) {
    const last = rounds.reduce((m, r) => Math.max(m, r.round), 0);
    return { status: 'collecting', roundsDone: last, primaryRound: spec.primaryRound };
  }
  const first = rounds.find((r) => r.round === 1);
  const beatsBase = target.vsBase.low > 0;
  const compounding = target.round > 1 && target.vsBase.estimate > (first?.vsBase.estimate ?? Infinity);
  return { status: 'complete', primaryRound: spec.primaryRound, vsBase: target.vsBase, firstRoundVsBase: first?.vsBase ?? null,
    beatsBase, compounding, confirmed: beatsBase && compounding };
}
