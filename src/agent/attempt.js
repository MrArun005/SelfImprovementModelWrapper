// One "attempt" at a task, optionally with inference-time checks that use ONLY the task's public tests
// (the worked examples in its statement; never hidden grading tests):
//   sample-and-filter: draw up to `samples` candidates with different seeds, keep the first that passes them
//   self-repair:       up to `repairs` rounds of "here is your code and how it failed the examples, fix it"
// Without public tests both are skipped: there is nothing honest to check against.
//   self-tests:        the model also writes extra examples from the statement; every candidate is run on them and the
//                      one that passes the statement's examples and the most self-written ones is kept
import { solve } from './solve.js';
import { runTests, RESULT } from '../judge/run-tests.js';
import { fill } from '../util.js';
import { extractExamples, selfTestSource, selfTestsPassed } from './public-tests.js';

/** Ask the model for extra examples of the function's behaviour (statement only; never the hidden tests). */
async function writeSelfTests({ llm, problem, templates, cfg, reserve, add }) {
  const st = cfg.agent.selfTests;
  const prompt = problem.vars?.prompt ?? problem.prompt;
  const user = fill(templates.selfTests, { prompt, entryPoint: problem.entryPoint, count: st.count });
  const reply = await llm.chat([{ role: 'user', content: user }], { temperature: st.temperature, seed: cfg.llm.seed, reserve, meta: { kind: 'self-tests', problemId: problem.id } });
  add({ usage: { ...(llm.lastUsage ?? { tokensIn: 0, tokensOut: 0 }) } });
  const own = new Set(extractExamples(prompt, problem.entryPoint).map((e) => e.call));
  const examples = extractExamples(String(reply), problem.entryPoint).filter((e) => !own.has(e.call)).slice(0, st.count);
  return selfTestSource(examples, cfg.curriculum.ecmaVersion) ? { source: selfTestSource(examples, cfg.curriculum.ecmaVersion), count: examples.length } : null;
}

export async function attemptWithChecks({ llm, problem, memory, templates, cfg, temperature, seed, reserve, extract, publicTests, samples = 1, repairs = 0, feedback = null, feedbackLabel, selfTests = false }) {
  const used = { requests: 0, tokensIn: 0, tokensOut: 0, llmMs: 0 };
  const add = (res) => {
    used.requests++;
    used.tokensIn += res.usage.tokensIn;
    used.tokensOut += res.usage.tokensOut;
    used.llmMs += res.usage.latencyMs ?? 0;
  };
  let first = null;
  let chosen = null;
  let samplesDrawn = 0;
  const candidates = [];
  // with self-tests every candidate is drawn (they are ranked afterwards); otherwise stop at the first that passes
  for (let s = 0; s < (publicTests || selfTests ? samples : 1); s++) {
    // first candidate at the caller's temperature; extra candidates hotter, so the filter has real alternatives
    // to choose from instead of near-copies (day-2 data: sample+filter was the most promising lever)
    const t = s === 0 ? temperature : Math.max(temperature, cfg.agent.sampleTemperature);
    const res = await solve({ llm, problem, memory, templates, cfg, temperature: t, seed: seed === undefined ? undefined : seed + s * cfg.agent.sampleSeedStride, reserve, extract, feedback });
    add(res);
    samplesDrawn++;
    first ??= res;
    candidates.push(res);
    if (!publicTests) { if (!selfTests) { chosen = res; break; } continue; }
    res.publicCheck = await runTests(res.code, publicTests, cfg.judge);
    if (!selfTests && res.publicCheck.type === RESULT.PASS) { chosen = res; break; }
  }
  let selfTestCount = null;
  if (selfTests && candidates.length > 1) {
    const st = await writeSelfTests({ llm, problem, templates, cfg, reserve, add });
    selfTestCount = st?.count ?? 0;
    const passesPublic = (c) => (c.publicCheck ? c.publicCheck.type === RESULT.PASS : true);
    for (const c of candidates) c.selfPassed = st ? selfTestsPassed((await runTests(c.code, st.source, cfg.judge)).output) : 0;
    // statement examples first (they are certainly right), then the most self-written examples; ties keep the earliest
    chosen = candidates.reduce((b, c) => ((Number(passesPublic(c)) - Number(passesPublic(b)) || c.selfPassed - b.selfPassed) > 0 ? c : b));
  }
  chosen ??= first;
  let repairsDone = 0;
  while (publicTests && repairsDone < repairs && chosen.publicCheck?.type !== RESULT.PASS) {
    const res = await solve({ llm, problem, memory, templates, cfg, temperature, seed, reserve, extract,
      feedback: { code: chosen.code, output: chosen.publicCheck.output, label: feedbackLabel } });
    add(res);
    repairsDone++;
    res.publicCheck = await runTests(res.code, publicTests, cfg.judge);
    chosen = res;
  }
  return { res: chosen, ...used, samplesDrawn, repairsDone, selfTestCount, selfTestsPassed: chosen.selfPassed ?? null, publicPassed: chosen.publicCheck ? chosen.publicCheck.type === RESULT.PASS : null };
}

/** Worst-case model requests for one attempt at `task` under the variant's levers. */
export function attemptCost(cfg, hasPublicTests, phase) {
  const lv = cfg.variant.levers;
  // self-tests draw every sample and add one request for the examples, with or without statement examples
  if (lv.selfTests) return (lv.sampleFilter ? cfg.agent.samples : 1) + 1 + (phase === 'eval' && lv.selfRepair && hasPublicTests ? cfg.eval.selfRepairAttempts : 0);
  if (!hasPublicTests) return 1;
  const samples = lv.sampleFilter ? cfg.agent.samples : 1;
  const repairs = phase === 'eval' && lv.selfRepair ? cfg.eval.selfRepairAttempts : 0;
  return samples + repairs;
}
