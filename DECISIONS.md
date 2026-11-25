# DECISIONS.md

Every non-obvious choice, why it was made, and how to change it. Values live in `config/default.json`;
any of them can be overridden with `SIC_*` env vars or the `SIC_CONFIG_OVERRIDES` repo variable (README).

## 1. The LLM: GitHub Models is gone, so a local model on the runner

**The plan said** to use GitHub Models through the Actions `GITHUB_TOKEN`. **What I found** (19 Nov 2026):
GitHub's docs say *"As of July 30, 2026, GitHub Models has been fully retired. The playground, model
catalog, inference API, and bring your own key (BYOK) are no longer available to any customer."*

**Choice:** a small open-weights model served by **Ollama on the Actions runner itself**, called through its
OpenAI-compatible `/v1/chat/completions` on `127.0.0.1`. It's free (public-repo runners) and needs **no token or
secret at all**, so the job that runs model-written code only has `contents: read`. The client is a generic
`openai-compatible` provider, so another endpoint works by changing `llm.endpoint` (key via `SIC_LLM_API_KEY`).
Ollama's version and download URL are pinned in config; the workflow reads them through `src/ci/config-out.js`.
The context window is set explicitly (`runtime.ollamaContextLength`, 8192) because Ollama silently truncates longer
prompts, and mutation-track prompts (function + failing assertions + lessons) run to several hundred tokens or more.

## 2. Model: `qwen2.5-coder:1.5b` (changed from 0.5b after the first smoke run, before any baseline)

The first smoke run on GitHub Actions (run 44602785479, 2026-11-19) measured **~4 s per request** for
`qwen2.5-coder:0.5b` including test execution (24 requests in ~99 s), i.e. ~28 min for a full 420-request variant
budget, far inside the job limit. Its lessons were problem-specific restatements, not reusable rules. Since the
owner asked for the most capable model the free setup allows, the model moved up to 1.5B (about 3x the
parameters) before any baseline was recorded, so no comparison straddles the change. Time limits were raised
to fit (`budget.maxRunMinutes` 125, `reserveMinutesForHoldout` 70, job timeout 170); a second smoke run checks it.
Still small on purpose: it leaves room to improve, and 7B on a CPU runner would not fit the daily budget.

**Smoke run 2 with 1.5B** (run 44603610122): ~6.8 s per request on MultiPL-E (24 requests in 164 s incl. tests)
and ~8.7 s on mutation prompts, so a full 420-request variant budget takes ~48-61 min of the 125-min cycle limit.
Lessons became general rules ("check up to the square root when testing primality", "iterate through the whole
string, including the last character"). On the mutation holdout the 1.5B model fixed 2 of 3 (0.5B: 0 of 3), so
the floor effect is gone, and the gate rejected a set of lessons that lowered that score. 3B was not chosen: about
2x slower again (the full budget would leave little margin under the job limit), and its higher MultiPL-E
starting point would risk a ceiling effect.

## 3. Tracks

### 3a. MultiPL-E (HumanEval + MBPP in JavaScript)
Hugging Face `nuprl/MultiPL-E` Parquet files pinned to revision `28441b60…` (558 problems), parsed with
`hyparquet`. Holdout: 50 problems, seed `split.seed`, stored in each variant's `split.json` and never silently re-made.

### 3b. Mutation repair: the contamination-free track (WOW phase 8)
- **Repo: `fastify/fast-uri` @ `3df33a5ff84eca2bbd0de9bc38fd28c17a11c3e7`, BSD-3-Clause.** Why this one:
  permissive license; **zero runtime dependencies**; small (≈60 named functions in `index.js`, `lib/utils.js`,
  `lib/schemes.js`) but dense with comparisons, offsets and branches, which suits mutation operators; a large
  suite (≈3,300 assertions in ~30 files) that runs in **0.4 s** inside our sandbox, so every mutant and every
  agent attempt can be judged by the real suite; tests need only `tape` (pinned `5.8.1`, installed with
  `--ignore-scripts`). `ajv.test.js` is excluded because it needs `ajv`.
- **Operators and weights** (config `curriculum.operators`): flip-comparison 3, flip-logical 2, off-by-one 2,
  drop-branch 1, swap-arguments 1, wrong-return 1. Weighted toward the bugs small models actually make.
  Functions longer than `maxFunctionChars` (1500) are excluded so a fix fits in the model's output budget.
- **Killed mutants only:** the mutated library's own suite must fail (fail or error, not timeout).
  On the first full generation, 33 of 111 single-mutation candidates **survived** the suite; those are
  discarded (they're either equivalent mutants or holes in the suite).
- **Levels:** 1 = one mutation, 2 = two mutations in one function, 3 = one mutation in each of two functions.
  The agent moves up when its rolling train pass rate over the last `promotion.window` (10) tasks at its
  level reaches `promotion.threshold` (0.6). Level changes are logged in `curriculum-state.json` and the gate log.
- **Holdout** = mutants from `holdoutSeed`, generated first; train generation (from `trainSeed`) skips any
  mutant identical to a holdout one. Holdout covers all three levels (10 each), so the holdout score doesn't
  change meaning as the agent's train level rises.
- **No third-party code in the repo:** state keeps only `curriculum-manifest.json` (seed, level, operators,
  function names, hash of the mutated source). Everything is regenerated from the pinned commit; `reproduce()`
  checks the hash. Train traces for this track store test output and reflections but not code (`tracks.mutation.storeCode: false`),
  and the skills lever is off for this track because a skill would be third-party code.
- **What the agent sees:** the mutated function(s), the failing assertions (TAP `not ok` blocks with the
  test titles, expected/actual), and how many bugs to look for. Never the operator; retrieval keywords come from
  function/file names and failing test titles only (a test asserts this).

## 4. Variants (WOW phase 6)

Variants are data (`config.variants`; this list is checked against the config by `test/docs.test.js`):
`baseline` (**control**: no memory, no inference-time levers), `lessons`, `skills`, `lessons-skills`, `self-repair`
(§4b), `sample-filter` (§4c), `full` (lessons + self-repair + sample-filter + prompt optimizer; skills removed after
day 2, §4e), `finetune` (the model's weights trained on its own verified solutions, §4g), `finetune-base` (its untrained
reference, §4g), `full-finetuned` (every lever stacked on the fine-tuned weights, §4h), `baseline-7b` and `full-7b` (§4i), `sample-filter-5` and `sample-filter-tests` (§4j), `mutation-baseline`
(control) and `mutation-lessons`. Each has its own `state/variants/<name>/`, its own
budget share, and its own job in the matrix.
The workflow's matrix is read from config by the `plan` job, so adding a variant is a config change only.

Control variants exist because day-to-day differences are not only noise: sampling seeds change, the
Ollama build could change, the runner could change. **Every headline comparison is against the control on the
same day and the same problems**, plus a difference-in-differences (variant's change since its start minus the
control's change over the same period).

## 4b. Self-repair lever (added before the baseline runs)

The most reliable inference-time gain for code models is letting them debug from test feedback. New lever
`selfRepair` (variant `self-repair`; also in `full`):
- **Train:** a failed attempt's code and its real test output go into the next attempt's prompt
  (`prompts/repair.md`), within `agent.maxAttemptsPerProblem`.
- **Holdout:** feedback may come **only from the worked examples in the problem statement** (`// >>> f(x)` /
  `// expected`), turned into a test script (`src/agent/public-tests.js`). The hidden grading tests are never shown
  on holdout; a test plants a marker in hidden tests and checks it never reaches a holdout prompt. Up to
  `eval.selfRepairAttempts` (1) repair per problem; the eval budget is planned for the worst case.
- Coverage is honest about its limits: 154 of the 158 HumanEval-JS prompts that have examples yield usable checks
  (439 examples; an example whose expected value is not a JS expression is skipped). MBPP prompts have no
  examples, so on those holdout problems self-repair cannot help. The mutation track has no public examples
  beyond the failing tests already in the prompt, so its holdout gets no repair either.
- Measured like every other lever: against the same-day control, with CIs.

## 4c. Sample-and-filter lever, and two fixes it exposed

Lever `sampleFilter` (variant `sample-filter`, also in `full`): draw up to `agent.samples` (3) candidates with
different seeds and keep the first that passes the problem statement's worked examples (same public tests as
self-repair; hidden tests never used). Where a problem has no examples it is a single attempt. These two variants
get `budgetShare` 1.5 because their evaluation costs more; at the measured ~7 s per request that is ~75 min,
within the cycle limit.

Fixes found while building it:
- **Train retries were copies.** Every train call used the same sampling seed, so a variant without lessons or
  self-repair sent an identical prompt with an identical seed on attempt 2 and got the same answer. Train seeds now
  depend on run, problem and attempt (`trainSeed`).
- **Eval planning was too pessimistic.** Charging every holdout problem the worst-case repair cost would have cut
  the self-repair variant's holdout to about 25 problems once learning runs (champion + candidate) start. Planning
  now charges extra only for problems that have examples (`attemptCost`).

## 4d. Day-1 learning run: every learned change made things worse, so lessons must now be verified

The first learning run (2026-11-20, run 44698384400) is the first real evidence, and it was negative. The gate
rejected every learning variant's candidate: lessons -8.7 pts (95% CI -16.7 to -1.3), full -11.1 (-19.0 to -4.0),
lessons+skills -6.0 (-15.3 to +1.3), skills -5.3 (-11.3 to 0.0), mutation-lessons -4.4 (-13.3 to +2.2). The gate
did its job: nothing harmful was accepted. Looking at the logs:
- 41 lessons in one run, none checked; many still about one problem ("when checking if a number is undulating...",
  "make sure CryptoJS is imported"), and one was the reflection prompt's own example copied word for word.
- Retrieval was far too loose: 126 of 150 candidate eval attempts had lessons injected, mostly unrelated. A 1.5B
  model is easily distracted by irrelevant context.

Changes (before day 2; champions are still empty, so no earlier result is invalidated; day 1 stays in the logs
under the old rules):
- **Verified lessons** (`agent.verifyLessons`): a lesson from a failed attempt is provisional and pinned into the
  next attempt on the same problem; it is kept only if that attempt passes, otherwise discarded (counted in
  `discardedLessons`).
- **Stricter retrieval:** `retrieve.minScore` 0.05 -> 0.2 (measured on day 1's lessons and the holdout: average
  lessons per problem 2.5 -> 0.8; 31 of 50 problems get none), `lessonsTopK` 3 -> 2, `skillsTopK` 2 -> 1.
- **No copyable example** in the reflection prompt; it now gives the form ("When <situation>, <what to do>.").

Measured afterwards with the new reflection-quality table (REPORT.md): under day 1's rules only 2.2-11.4% of
lessons would have been verified (lessons 2 of 41, lessons+skills 4 of 35, full 1 of 46, mutation-lessons 1 of 46).
So about 9 in 10 lessons never helped even on the problem they came from, which fits the score drop. From day 2
only the verified ones are kept, so expect a few lessons per run instead of dozens.

## 4e. Day 2: lessons stopped hurting; skills hurt, more so the more similar they are

Day 2 (2026-11-21, run 44854047467), the first with verified lessons: the lessons variant went from "reject, -8.7"
to "keep, +0.0" (3 of 41 lessons verified; none harmful). The remaining drops all came from variants with skills:
skills -3.3, lessons+skills -5.3, full -7.1 (CIs include 0; none significant after Holm). Per attempt, showing a
stored solution changed the pass rate by -3.9 (skills), -6.9 (lessons+skills) and -10.3 pts (full) against the
champion on the same problem and repeat, and by 0 to -2.1 when none was shown. By similarity of the shown solution's
problem: 0.2-0.3 -2.9 pts (105 attempts), 0.3-0.4 -3.0 (66), 0.4-0.5 -9.0 (78), >=0.5 -13.0 (69). The more similar,
the more the small model copies a solution to a different problem, so a stricter threshold would make it worse.

Changes (before day 3):
- `full` no longer uses skills (its champion was still empty): it is now lessons + self-repair + sample-and-filter +
  prompt optimizer, the best combination the evidence supports.
- The `skills` lever now shows each solution with the earlier problem's statement and a warning that it is a
  different problem (`formatSkills`), as a test of whether comparing specs stops the copying. Measured as usual.

## 4f. Product: `npm run solve`, and hotter extra samples

- After day 2 the most promising lever was sample-and-filter (+4.7 pts vs control, p = 0.09, not significant after
  Holm). Its extra candidates were drawn at the same low temperature (0.2) as the first, so they were often near
  copies and the filter had little to choose from. From day 3 extra candidates use `agent.sampleTemperature` (0.8);
  the first stays at the eval temperature. This changes an inference-time lever of `sample-filter` and `full` (no
  stored state depends on it); days 1-2 of those variants ran with the old setting, which the report's per-day
  rows make visible.
- `npm run solve -- stub.js` turns the system into something usable: it completes a function stub with the chosen
  variant's accepted memory and levers, checking candidates against the stub's own examples in the same sandbox.

## 4g. Fine-tuning on verified solutions (expert iteration), added on day 3

Every other lever changes what the model is *shown*; the weights never change, so gains are capped by what a
fixed 1.5B model can do with better notes. Variant `finetune` (lever `finetune`) changes the weights:

- **Data.** Every train-phase solution that passed the hidden tests, from every MultiPL-E variant
  (`state/variants/*/traces.jsonl`), at most `finetune.maxSolutionsPerProblem` distinct ones per problem, rendered
  as the plain prompt the agent sends (seed system prompt, no lessons or skills) -> the passing code. Solutions found
  with lessons, skills or self-repair are thereby distilled into a model that no longer needs them. Holdout problems
  are excluded by construction (`src/finetune/prepare.js`) and the exclusion is counted in the manifest; traces are
  train-only, so the count should stay 0. Day 3 starts with 340 solutions for 236 train problems.
- **Recursion.** The `finetune` variant's own train attempts use the fine-tuned model, and its passes join the next
  day's data: a better model finds more verified solutions, which train the next model. That is the loop the user
  asked for; it is still bounded by the base model's capacity and the train set's size.
- **Training.** LoRA (rank 16, all attention and MLP projections, lr 1e-4, 2 epochs, loss on the completion only,
  gradient checkpointing: without it a full local run was OOM-killed at ~14 GB)
  on CPU in a separate `finetune` job, retrained **from scratch each cycle** on the whole dataset (deterministic in
  the data; no adapter binaries in git). Measured in a runner-sized container: about 5 s per example, so 340
  examples x 2 epochs is about an hour; `finetune.train.maxTrainSeconds` (3 h; day 3 on the runner ran at 16 s per example and stopped at 1.3 of 2 epochs under the old 2 h cap) caps it as the data grows. Base model
  and every package are pinned (`finetune.baseRevision` + a SHA-256 per file, `pythonPackages`, `llamaCppCommit`). On the runner, with
  gradient checkpointing, expect ~8-10 s per example; `maxTrainSeconds` stops training cleanly if the data outgrows it.
- **Serving and fairness.** Three smoke runs found what Ollama 0.40 no longer does: it refuses LoRA adapters, only
  quantizes safetensors imports, and then only to its own types (int4/int8/fp4/fp8, not the stock model's
  `Q4_K_M`). So the adapter is merged into the base weights (`tools/finetune/merge.py`, bf16), converted to GGUF and
  quantized to `finetune.quantize` with llama.cpp built from the pinned commit (`llamaCppCommit`, cached), the same
  tool family that made the stock GGUF; Ollama imports the finished file with the stock model's own Modelfile
  (template, stop tokens, parameters). It is still not the stock file, so variant `finetune-base` serves the
  **untrained** base files through the identical convert + quantize steps: `finetune` vs `finetune-base` isolates the
  effect of training, `finetune-base` vs the control shows what the pipeline alone does.
- **No gate on the weights.** The adapter is not accepted or rejected by the champion/candidate gate (that would
  need two models evaluated per day); its effect is the daily paired comparison with the control, with the same CIs
  and Holm correction as every other lever. If it is significantly worse, the report says so.
- **Budget.** Adding a variant would have shrunk every other variant's requests; `budget.totalRequestsPerRun` was
  raised to 5,670 (three new variants) so a unit share stays 420 requests and the running experiment is unchanged.
- **Mock / dry run.** The mock ignores model names, so in tests `finetune` behaves like the control; the training
  path is exercised by the smoke run (`smoke.finetune`: 40 examples, 5 minutes).

## 4h. Day 3 → 4: hard wins, the stacked variant, and a product that follows the evidence

- **Hard wins.** Day 3: fine-tuning on all verified solutions did nothing measurable (`finetune` vs `finetune-base`
  -0.7 pts [-8.0, +4.7]; local probe on 60 never-solved problems 32 vs 31). Training loss started at 0.078: the
  model already assigns high probability to its own easy solutions, so there is little to learn from them. From day 4
  the data focuses on what the system learned the hard way: problems that failed at least once somewhere or were only
  solved on a retry keep up to `finetune.maxSolutionsPerProblem` distinct solutions and are repeated `hardWeight`
  times; easy problems keep `easyMaxSolutionsPerProblem`. One epoch over the weighted set (389 solutions, 94 hard
  problems, 539 examples) fits the 3 h cap at the runner's ~16 s/example. Local probe before day 4 (60 train problems
  no variant has solved, so none in the training data; greedy, full precision, judged by the repo's sandbox): base 14,
  hard-win fine-tuned 19 (+8.3 pts; 6 problems only the fine-tuned model solved, 1 only the base; exact McNemar
  p = 0.125). Promising, not significant; the day-4 holdout comparison is the evidence. The day-3 all-solutions model
  on a comparable probe: 31 vs 32 (+1.7 pts, 3 vs 2).
- **`full-finetuned`.** The fine-tuned weights with every inference lever (lessons, self-repair, sample+filter, prompt
  optimizer), share 1.5. If fine-tuning and the levers are complementary, this is the best system; if not, the
  comparison with `full` shows it. Budget raised so every unit share stays 420 requests.
- **The product follows the evidence.** `product.variant` = `auto`: `npm run solve` uses the variant with the highest
  lower 95% bound of its gain over the control in the committed results (the most reliably good, not the luckiest),
  among variants that run on the stock model; `--variant` overrides, `product.fallbackVariant` covers no data. As the
  daily runs change the evidence, the product changes with it.
- **Stable seeds.** Bootstrap seeds were a running counter over the variant list, so adding a variant moved other
  variants' CIs slightly. They are now hashed from the variant's name (one-time shift of every CI by bootstrap noise;
  e.g. `full` Holm p 0.592 -> 0.680), with a test that adding a variant leaves the others unchanged.

## 4i. After day 3: stop what shows nothing, add a 7B track

- **Stopped** (`active: false`; history stays in every report, labelled "stopped"): `lessons`, `skills`,
  `lessons-skills`, `self-repair`, `mutation-baseline`, `mutation-lessons`. After 3 days each was within ±1.3 pts of
  its control with CIs across zero (mutation flat at 16.7%), and each cost a runner and a budget share every day.
- **Why not a bigger exam instead.** The natural fix for wide CIs is more held-out problems, but MultiPL-E JavaScript
  has 558 problems: 50 holdout + 508 train, and after 3 days every train problem has been practised on (lessons
  verified on them, solutions in the fine-tuning data). Moving any of them into the holdout would test on seen
  problems. So the holdout stays at 50.
- **7B track** (`group: multipl-e-7b`, its own control `baseline-7b` and `full-7b` = the `full` levers): same dataset,
  same 50 holdout problems, `qwen2.5-coder:7b` via per-variant `overrides` (`eval.repeats` 1, longer
  `budget.maxRunMinutes`, `jobMinutes` 330 of the 360 a free runner allows) because a 7B model answers ~4-5x slower
  on 4 CPUs. Model size is the largest single lever on these benchmarks; this measures it, and whether the levers
  still help on a stronger base. Fine-tuning stays at 1.5B (7B training needs ~28 GB RAM).
- Budget: every active variant keeps 420 requests per unit share (total = 420 x active shares = 3,780).
- Results are grouped by `group` (default: track): each group has its own control, leaderboard and chart.

## 4j. Day 5: pooled estimates, and full evaluation coverage

- **Pooled over days.** One 50-problem day only detects gains of roughly 5-10 pts (the CI half-width plus the Holm
  margin), while the levers' gains look like 2-4 pts. `analysis.pooledComparison` averages each problem's
  variant-minus-control difference over the last `analysis.poolDays` (7) same-day pairs and bootstraps over
  problems (the same problems recur every day, so days are not treated as independent). It gets its own Holm
  correction (one pooled test per variant) and sits next to the single-day numbers in the README and dashboard. It
  estimates the average gain over the window, including days before later improvements were accepted. First reading
  (day 5): sample+filter +2.3 pts [+0.4, +4.6] over 6 days, the first CI above zero; Holm p 0.16, so not yet
  significant after the correction.
- **All 50 holdout problems for every variant.** `planEval` budgets the worst case (every sample plus a repair on every
  problem with examples); at budget share 1.5, `full` and `full-finetuned` only fit 42 of 50 problems, always dropping
  the same expensive ones, which both widened their CIs and biased them toward cheap problems. Their share is now 2
  (a unit share stays 420 requests); with the evaluation reserve alone all 50 problems fit for every active variant.
- **Push the most promising lever.** `sample-filter-5`: sample+filter with 5 candidates instead of 3 (`overrides.agent.
  samples`), share 2.5 so all 50 problems fit. More candidates give the example filter more chances to find a
  passing one; whether that beats 3 is measured against the same control.
- **Self-written tests** (lever `selfTests`, variant `sample-filter-tests`). Sample+filter only checks candidates
  against the statement's own examples, and stops at the first that passes them. With self-tests the model also
  writes `agent.selfTests.count` extra examples from the statement (one extra request, `prompts/self-tests.md`, same
  `// >>> call` format, statement examples removed); every candidate is drawn and run on them in the sandbox, and the
  one that passes the statement's examples and then the most self-written ones is kept (a simplified CodeT-style
  ranking). The self-written examples can be wrong, so they only rank candidates, never decide pass or fail, and they
  come from the statement alone, so using them on holdout problems is honest. Its real cost equals its worst case
  (every sample + 1), so it gets share 3, 2 eval repeats and 220 job minutes to keep all 50 problems.
- **Time to match the budget.** With all 50 problems at share 2, `full` ran past the 170-minute job limit on 24-25 Nov
  and was cancelled (its state was not uploaded). `full`, `full-finetuned` and `sample-filter-5` now get the 7B
  limits: `budget.maxRunMinutes` 300 / `reserveMinutesForHoldout` 200 and 330 job minutes.
- **Exploration sampling (outside the daily runs).** While the free GPU is not available, the session's own machine
  samples the base 1.5B model 8 times (temperature 0.8) on every train problem no variant has solved, judges each
  sample with that train problem's tests, and writes the passing, distinct solutions to
  `state/exploration/traces.jsonl` (`finetune.extraTraceFiles`). The fine-tuning set reads them like any variant's
  traces: train problems only, holdout rows excluded and counted. These are exactly the hard wins the model lacks.
- **The product uses the pooled evidence.** `npm run solve` (`product.variant` = `auto`) now picks the active
  stock-model variant with the highest lower bound of its pooled multi-day gain (single-day only when no pooled
  estimate exists). Day 5: sample+filter (+2.3 pts pooled over 6 days, CI from +0.4).

## 4k. Use the spare runners every day: exploration and distillation

A free account runs about 20 jobs at once (all of its repos share them, so more repos would not add capacity, and
extra accounts to get around it would break GitHub's terms). The daily cycle used ~11 with at most 7 in parallel.
Now `runtime.maxParallel` is 12 and a new `explore` job uses the rest:

- **6 shards** (`explore.shards`), started right after `plan` (they do not wait for fine-tuning): 3 with the 1.5B
  model (8 samples per problem) and 3 with the 7B model (4 samples). Each shard takes the train problems no variant
  or earlier exploration has solved (a stable hash splits them), samples at `explore.temperature` with seeds that
  change daily, judges every sample with that train problem's own tests in the sandbox and keeps up to
  `keepPerProblem` distinct passing solutions. Holdout problems are never sampled (asserted) and rejected again when
  the aggregate job merges the shards into `state/exploration/traces.jsonl`.
- The fine-tuning set reads that file (`finetune.extraTraceFiles`), so each day's discoveries train the next day's
  model: the loop runs on all 20 slots.
- **The 7B shards are distillation**, not self-improvement in the strict sense: a larger open model's verified
  solutions teach the 1.5B model what it cannot do yet. Every row records which model found it, so the report can
  separate the two sources.
- Same sandbox and permissions as the variant jobs (read-only token, no credentials, model-written code only run in
  the judge). The Ollama install step moved to `tools/ci/ollama-setup.sh` so both jobs share it.

## 4l. Several cycles a day, and no runner waits for one it does not need

- **Cadence.** One cycle per UTC day was a self-imposed rule; a cycle takes ~5 h, so it left the account's ~20 runner
  slots idle most of the day. Cron now fires every 6 h and `src/ci/due.js` starts a cycle when some active variant's
  last cycle began at least `cycle.minHoursBetween` (5) hours ago (run-state `lastRunAt`; the workflow's
  concurrency group still prevents overlap). Up to ~4 cycles a day.
- **Pairing by cycle, not by day.** Comparisons and pooled estimates pair a variant's run with the control run from
  the same workflow run (`cycleKey`: the GitHub run id; the UTC day for local runs), so several cycles a day each
  count once. `analysis.poolDays` therefore now means the last 7 cycles.
- **Nobody waits needlessly.** The variant job is split: `improve` (stock-model variants) starts right after `plan`;
  `improve-finetuned` (the 3 variants serving the fine-tuned model or its reference) waits for `finetune`. Their
  steps are identical (a test compares them). With 11 exploration shards (5 x 1.5B, 16 samples; 6 x 7B, 6 samples)
  the peak is ~19 concurrent jobs.
- **Run all day, each job by itself.** Cron fires hourly and `cycle.minHoursBetween` is 1, so a new cycle is queued
  behind the running one and starts the moment it finishes: cycles run back-to-back all day. Exploration jobs no longer
  stop after one pass: they work in rounds until their time limit (`explore.maxRounds`), retrying the problems still
  unsolved with fresh seeds and a slightly higher temperature each round (`temperatureStep`, capped at
  `maxTemperature`), writing what they found after every problem. A GitHub job is capped at 6 h and parallel jobs
  cannot share what they learn mid-run, so learning moves between cycles (each fine-tunes on everything the previous
  ones verified). Risk, stated plainly: 20 runners busy around the clock is far above typical use of free public-repo
  Actions and could be throttled; `cycle.minHoursBetween` (e.g. 6) turns it down.

## 5. Evaluation and statistics

- **Repeats:** every holdout evaluation runs `eval.repeats` = 3 times at `eval.temperature` 0.2. Repeat `r` of
  run `k` uses seed `llm.seed + ((k-1)·repeats + r)` (`eval.seedMode: per-run`): champion and candidate share the
  seeds within a run (paired), and every run draws fresh seeds, so an unchanged champion is re-measured independently.
  _An earlier version reused the same seeds every day, which made an unchanged champion score identically every
  day and the baseline noise exactly zero. The demo exposed it; fixed._
- **CIs:** 95% percentile bootstrap over **problems** (`stats.method: problems`, 2,000 resamples). Raw 0/1
  results per problem and repeat are stored in `evals.jsonl`.
- **I tried a two-level (hierarchical) bootstrap and reverted it.** After a no-memory control looked
  "significantly" better than its own start in the 7-task demo, I suspected the problems-only bootstrap ignored
  within-problem noise and switched to resampling problems and then repeats. A simulation with the same CI code
  (`src/power.js`, `test/stats.test.js`) showed that was wrong. With no true effect, the problems-only CI excluded zero
  2.8% of the time (n=50; nominal one-sided 2.5%). The hierarchical CI did so 0.5% of the time, and detected a real
  +15 pt gain only 56% vs 80% of the time: it double-counts within-problem noise. The control's "significant"
  drift was a small-sample (n=7) false positive among many comparisons. Kept as an option, labelled conservative;
  a calibration test now pins the false-positive rate.
- **Power** ([docs/power.md](docs/power.md), generated by `npm run power`): at n=50 × 3 repeats a true gain of about
  15–20 points is detected ≥80% of the time; 5 repeats would get that to about 10 points at +67% eval cost;
  80 problems × 3 to about 15. I kept 50 × 3 because the runner's real speed is still unmeasured. The simulation
  assumes independent repeats with per-problem pass probabilities between 0.1 and 0.8. At low temperature a
  real model's repeats are more correlated, which lowers the value of extra repeats.

## 5b. Multiple comparisons (Holm)

Several variants are compared with the same control every day, so with 95% CIs some "significant" differences
are expected by chance. REPORT.md now adds, per track, a two-sided percentile-bootstrap p-value for each variant's
paired difference from the control and the Holm-Bonferroni step-down adjustment (family-wise error 1 - confidence),
and says in words which differences survive. The dashboard marks a difference that is significant on its own but
not after Holm. (The gate itself is per variant and unchanged: it compares a candidate with its own champion.)

## 6. Gate

`gate.method: ci`. Accept if the candidate is ≥ `minImprovement` (2.5 pts) better **and** the paired bootstrap CI
of the difference excludes zero. Reject if the CI is entirely below zero, or the drop exceeds `tolerance` (2.5 pts).
Otherwise **keep**: the champion is unchanged and the candidate's new items stay pending into the next run, where
they're re-tested along with that run's additions. They're dropped after `maxPendingRuns` (3). Rejected items are
deleted. `champion.json` holds only accepted state (run counters live in `run-state.json`), so a rejected
candidate leaves it byte-for-byte unchanged (tested). The first `baselineRuns` (2) runs of every variant only
measure the starting point. Known cost, now measured ([docs/power.md](docs/power.md), simulation with the gate's own `decide()`): for a change
with no real effect, the false-accept rate is 1.0% with one evaluation and 4.5% when the pending rule allows up to 3.
Re-testing more than quadruples it but keeps it under 5%; lowering `gate.maxPendingRuns` trades that against missing
small real gains.

## 7. Budget

`budget.totalRequestsPerRun` is split across variants by `budgetShare`: 420 requests per unit of share (the
sample-based `sample-filter` and `full` have share 1.5, i.e. 630, because their evaluation costs more), so the total
grows with the number of variants (it started at 2,940 for 7 equal variants; 5,670 since `finetune`, `finetune-base` and `full-finetuned` were added). `holdoutFraction` 0.72 of each
variant's share is reserved for evaluation (50 problems x 3 repeats x champion + candidate = 300 at share 1).
Variant jobs run on separate runners in parallel, so the split is about fairness and run time, not a shared quota.
The counter is checked **before** every model call; a time limit (`maxRunMinutes`, with `reserveMinutesForHoldout`)
stops training early enough to evaluate. If evaluation can't finish, its scores are discarded (`no-eval`) and state is still written.

## 8. Failure taxonomy (WOW phase 7)

Rules are config (`taxonomy.rules`), tried in order, first match wins: `timeout` → `syntax` (SyntaxError) →
`spec-misread` (entry point "is not defined"/"is not a function", or checks `entryPointMissing` / `arityMismatch`) →
`runtime-error` (a thrown JS error, including tape's `operator: error`) → `wrong-output` (assertion failed) → `other`
(non-zero exit with no recognisable error, e.g. `process.exit`). Each class has a fixture that goes through the real
judge. Classes are recorded on every attempt row. "Reduced by self-improvement" means a learning variant's share
dropped by ≥ `analysis.taxonomyMinDrop` and clearly more than the control's.

**Cost metrics:** requests include reflection calls; "solved" = distinct train problems passed at least once;
reported as solved per 100 requests, requests per solved and tokens per solved. Tokens come from Ollama's `usage`
field (the mock estimates them as characters / 4).

## 9. Dashboard and report (WOW phases 9-10)

- `site/build.js` writes one self-contained `site/index.html`: inline CSS/JS/SVG, light and dark, mobile layout.
  Headline numbers, charts and tables are static HTML (tested with scripts stripped); JS only adds the replay
  stepper and filters. Everything from state is HTML-escaped (tested with an injected `<script>` lesson).
- `src/report.js` writes `REPORT.md` from `src/analysis.js` only, with no clock and stable sort orders, so regenerating
  gives identical bytes (tested). It always includes: plateau check (no significant gain over the last
  `analysis.plateauRuns` runs), changes the gate blocked and their measured cost, conflicting lessons (pairs retrieved
  together on failed attempts with a lower pass rate together than either alone), and an author TODO.
- The README's results block is regenerated between markers by `npm run report -- --update-readme`.
- Workflow: `plan` → `improve` (matrix, `contents: read`) → `aggregate` (`contents: read`: merges artifacts with
  `src/ci/collect.js`, which accepts only configured variant names and no symlinks, then builds charts, report and site) →
  `commit` (`contents: write`, copies files only) and `pages` (`pages: write`, `id-token: write`).

## 9b. Floor and ceiling effects

A track whose starting pass rate is below 10% or above 90% (`analysis.floorRate` / `ceilingRate`) can show little
in either direction: with almost no passes there is little to build skills or lessons from, and near the top there
is nothing left to gain. The report and dashboard say so and name the knob to turn (`analysis.difficultyKnobs`).
The mutation track is the more likely to hit the floor with a 0.5B model; `curriculum.maxFunctionChars` and the
operator weights are its main difficulty controls.

## 9c. Workflow robustness (after the first real runs)

The first two real baseline runs trained and committed correctly but were shown as failed, only because the optional
Pages deploy fails until Pages is enabled. The deploy step is now `continue-on-error` with a warning saying how to
enable it. Model setup retries the download and pull (3 tries, growing delay) and makes one tiny warm-up request, so
a broken model fails in the first minutes with a clear error instead of after spending the budget.

## 9d. One cycle per day despite dropped schedules

GitHub created no run at all for the first scheduled time (2026-11-20 04:17 UTC). The workflow now has two backup
cron times and the plan job runs `src/ci/due.js`: if every variant already has a cycle dated today (UTC), all
later jobs are skipped, so backups never train twice or spend the daily budget twice. A `force` input overrides.

## 9e. Independent review (2026-11-21) and what changed

A separate reviewer, given the code and not my conclusions, read the sandbox, the workflow and the statistics. Its
confirmed findings, most severe first, and what was done:
1. **Critical: model code could fake a pass.** The verdict was "exit code 0", and the solution ran first in the
   same process as the tests: `process.exit(0)`, replacing `assert.deepEqual`, or an `uncaughtException` handler all
   scored as passes (reproduced). Fixed: a harness loads solution and tests after freezing `node:assert` and
   disabling `process.exit`/`reallyExit`/`abort`, and a pass needs a random completion marker printed only after the
   last test ran. On the mutation track a pass needs tape's own summary (`# tests N` = `# pass N`, no failures).
   Regression tests cover each trick. **Existing data:** none of the recorded passing train attempts used these
   tricks (checked in every traces.jsonl); holdout attempts do not store code, so those cannot be checked the same way.
   Residual: code that deliberately reads the harness file from disk could learn the marker.
2. **High (stats): winner's curse.** On an accept day the reported score was the candidate batch that had just won
   the gate on the same data. Reports and charts now always use the champion's own measurement, so an accepted
   change is reported from the next run's fresh measurement.
3. **Medium: pending changes got one evaluation too many** (`maxPendingRuns` 3 allowed 4). Fixed (`>=`). Still open:
   items added to an existing pending set inherit its start run; no alpha spending across re-tests (measured cost in
   docs/power.md).
4. **Medium (CI): one failed variant made every variant train twice** when a backup cron re-ran the matrix. Fixed:
   each variant skips itself if it already ran that UTC day (`SIC_FORCE=1` overrides); tested.
5. **Medium (CI): a queued run decided on stale state** (checked out the trigger commit). Fixed: jobs check out the
   branch head; Pages deploys only after a successful commit.
6. **Low (stats): "same day" control comparisons could mix days.** Fixed: a variant is compared only with the
   control's run from the same UTC day; otherwise the comparison is reported as missing.
7. **Medium, open: no network isolation** (the sandbox could reach the local Ollama API, e.g. to delete the model,
   affecting only that job). **Medium, open: the heap cap does not cover Buffers** (a solution could allocate GBs
   and get the runner OOM-killed). Both need OS-level isolation (network namespace / cgroup) that GitHub's hosted
   runners do not make simple; documented in the README.

## 10. Reproduction and the synthetic mock

`npm run reproduce -- --variant=<name> --seed=<n>` runs simulated days with a fake clock, entirely offline.
The mock's synthetic mode is **not a model**: each fixture problem belongs to a family with a typical bug
(`test/fixtures/synthetic-problems.json`, 39 problems generated and verified by `tools/make-synthetic-fixtures.cjs`).
Its pass probability rises when a lesson containing the family's fix phrase, or a solved problem of the same family,
is in the prompt. That gives realistic-looking learning dynamics for testing statistics, gate, report and dashboard.
Output is identical for the same seed (tested). Data from it is labelled "Demo data" / "synthetic mock" everywhere.

## 11. Earlier choices that still hold (PLAN.md phases 1-5)

- **Sandbox:** empty env, temp dir, process-group kill on timeout, heap cap, output cap, Node permission model
  (reads only in the temp dir plus pinned test dependencies; no writes, no child processes). Judge output drops
  Node-internal stack frames (config `judge.dropOutputLinePatterns`), which is cleaner for the dashboard and wastes less of the model's context.
- **Retrieval:** keyword overlap (cosine on token sets), no embeddings: offline, free, deterministic. Current
  limits (`retrieve.minScore` 0.2, `agent.lessonsTopK` 2, `agent.skillsTopK` 1) came from day 1's evidence (§4d).
- **Prompt optimizer (phase 5):** `@ax-llm/ax` GEPA with train-only examples, budget-proxied, flag + lever gated,
  every `promptOptimizer.everyNRuns` runs, in the `full` variant only. Errors are caught and logged in the gate log.
  With the mock provider a deterministic stand-in proposes a prompt so the path is exercised offline.
  `@ax-llm/ax`'s postinstall writes files into the project, so installs use `--ignore-scripts` (also `.npmrc`).
- **Actions pinned to commit SHAs**; the cron is a literal (GitHub can't read it from a variable).
- **No hard-coded values:** a test parses every source file with acorn and fails on URLs, model names and
  numeric literals other than 0/1/2/100; the few fixed constants (PRNG/hash constants, unit conversions, the Node
  versions that renamed `--permission`, a float epsilon, ID formats) carry an `allow-number:` comment saying why.

## 12. Not yet measured

Installing Ollama in the build session was blocked, so the first real numbers came from two smoke runs on
GitHub Actions (§2). Baseline run 1 started 2026-11-19 (run 44604991368). Still unverified: whether the GEPA
path works against Ollama (the smoke runs' `full` variant ran it every run; check its gate-log `optimizer` field). The first scheduled runs will produce them;
REPORT.md and the dashboard fill in automatically. Update §5 (repeats) and §7 (budget) once the real per-call
time is known.
