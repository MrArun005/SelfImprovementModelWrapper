# BACKLOG.md

Improvement plan for the 3-day hardening pass (2026-11-19 to 2026-11-22). Order = what most reduces the
chance that the real week of runs is wasted or misread. Each item is done in its own commit with tests;
each item records the commit that finished it.

Rules for every item: `npm test` green, actionlint clean, no numbers/URLs/model names outside config,
DECISIONS.md updated for any non-obvious choice, README claims backed by generated numbers.

## Done

- [x] **Smoke mode** (`workflow_dispatch` input `smoke`): tiny real-model run per variant, state in `.smoke/`,
  nothing committed; job summary shows measured seconds per request and whether the full budget fits the time
  limit; exercises the prompt optimizer path. Model latency is recorded on every attempt row and shown in the cost tables.
- [x] **Floor/ceiling detection** (e4ee9cf). `analysis.difficultyCheck` pools every variant's baseline runs per track;
  the report ("Difficulty check") and dashboard (banner) warn below `analysis.floorRate` / above `analysis.ceilingRate`
  and name the config knob that changes difficulty (`analysis.difficultyKnobs`).

- [x] **Workflow robustness.** Ollama download and model pull retry with backoff (`runtime.setupRetries`,
  `setupRetryDelaySec`); setup fails fast with a clear `::error::` and the Ollama log if the server never starts or the
  model doesn't answer a warm-up request (`warmupTimeoutSec`); the optional Pages deploy no longer marks a successful
  training run as failed (warning instead); `test/workflow.test.js` guards permissions and that smoke runs never commit.
  Prompted by real runs: runs 3 and 4 trained and committed fine but showed "failure" only because Pages is off.

- [x] **Missed schedules.** GitHub dropped the first scheduled run (2026-11-20 04:17; no run was created at all).
  Two backup cron times (10:17, 16:17 UTC) plus `src/ci/due.js` in the plan job: the first trigger of a UTC day trains,
  later ones skip every job; `force` input overrides. The missed day was started manually at 07:54 UTC.

- [x] **Verified lessons + stricter retrieval** (prompted by day 1: every learned change scored worse; see
  DECISIONS.md §4d). Lessons kept only if the next attempt with them pinned passes; retrieval minScore 0.2.

## Next, in order

0. **Capability levers (user asked to make the model as capable as possible).** In order of expected gain:
   a. ~~**Bigger model if the smoke run shows time headroom**~~ DONE: 1.5B after smoke run 1 measured ~4 s/request with 0.5B (e.g. `qwen2.5-coder:1.5b`/`3b`): the biggest single lever;
      decide from measured seconds per request, before the baseline runs, never mid-experiment.
   b. ~~**Self-repair inside an attempt**~~ DONE (see DECISIONS.md §4b): on train, show the model its own failing code + test output and let it fix it
      (bounded by `agent.maxAttemptsPerProblem`). On holdout, only the examples already in the problem statement may be
      used as feedback (never the hidden tests), so the score stays honest. Ship as a new lever + variant so its effect
      is measured against the control, not assumed.
   d. ~~**Sample-and-filter**~~ DONE (DECISIONS.md §4c), plus fixes: distinct train seeds, per-task eval costing.
   c. **Better lessons**: give the reflection prompt the exact expected/actual values; keep only lessons that helped
      on a retry (verified lessons) instead of every reflection.
3. **Multiple comparisons.** Holm-adjusted significance across the learning variants' control comparisons, reported
   next to the unadjusted CIs in plain words.
4. **Reflection quality metrics.** Rate of reflections that produced no usable lesson, duplicate-lesson rate,
   near-duplicate merging (token Jaccard above a configured threshold), and the expected/actual values given to the
   reflection prompt explicitly.
5. **Lesson effect estimate (observational, labelled as such).** Per lesson: pass rate of train attempts where it
   was retrieved vs comparable attempts without it.
6. **Gate re-test inflation.** Make the pending re-test rule explicit in numbers: simulate the false-accept rate
   of "keep up to N runs" with the power simulator and report it in docs/power.md.
7. **Dashboard:** curriculum level timeline, gate-log rows linked to their replays, per-variant anchors.
8. **Independent review** (a fresh reviewer, not anchored on my reading) of the sandbox, workflow permissions and the
   statistics; fix what it finds.
9. **Docs:** "how to read the dashboard" section; final pass on README/DECISIONS consistency.
