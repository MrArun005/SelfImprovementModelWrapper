// One "attempt" at a task, optionally with inference-time checks that use ONLY the task's public tests
// (the worked examples in its statement; never hidden grading tests):
//   sample-and-filter: draw up to `samples` candidates with different seeds, keep the first that passes them
//   self-repair:       up to `repairs` rounds of "here is your code and how it failed the examples, fix it"
// Without public tests both are skipped: there is nothing honest to check against.
import { solve } from './solve.js';
import { runTests, RESULT } from '../judge/run-tests.js';

export async function attemptWithChecks({ llm, problem, memory, templates, cfg, temperature, seed, reserve, extract, publicTests, samples = 1, repairs = 0, feedback = null, feedbackLabel }) {
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
  for (let s = 0; s < (publicTests ? samples : 1); s++) {
    const res = await solve({ llm, problem, memory, templates, cfg, temperature, seed: seed === undefined ? undefined : seed + s * cfg.agent.sampleSeedStride, reserve, extract, feedback });
    add(res);
    samplesDrawn++;
    first ??= res;
    if (!publicTests) { chosen = res; break; }
    res.publicCheck = await runTests(res.code, publicTests, cfg.judge);
    if (res.publicCheck.type === RESULT.PASS) { chosen = res; break; }
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
  return { res: chosen, ...used, samplesDrawn, repairsDone, publicPassed: chosen.publicCheck ? chosen.publicCheck.type === RESULT.PASS : null };
}

/** Worst-case model requests for one attempt at `task` under the variant's levers. */
export function attemptCost(cfg, hasPublicTests, phase) {
  const lv = cfg.variant.levers;
  if (!hasPublicTests) return 1;
  const samples = lv.sampleFilter ? cfg.agent.samples : 1;
  const repairs = phase === 'eval' && lv.selfRepair ? cfg.eval.selfRepairAttempts : 0;
  return samples + repairs;
}
