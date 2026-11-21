// The product: complete a JavaScript function from a stub, using everything the system has learned.
//   npm run solve -- path/to/stub.js [--variant=<name>] [--mock]
// A stub is a comment describing the function, optionally worked examples, and the signature:
//   // Return true if the balance ever drops below zero.
//   // >>> below_zero([1, 2, -4, 5])
//   // true
//   function below_zero(operations){
// It uses the chosen variant's accepted memory (lessons, skills, system prompt) and its inference-time levers
// (sample + filter, self-repair). With examples, candidates are checked against them in the sandbox; the final
// code is printed to stdout and a short verdict to stderr. Needs the configured model (Ollama) unless --mock.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { variantConfig } from './variants.js';
import { createLLM } from './llm/index.js';
import { loadMemory, readPrompt } from './memory.js';
import { attemptWithChecks } from './agent/attempt.js';
import { publicTestSource, extractExamples } from './agent/public-tests.js';
import { extractCode } from './agent/solve.js';
import { entryPointOf } from './dataset/fetch.js';
import { loadSharedTemplates } from './run.js';
import { runTests, RESULT } from './judge/run-tests.js';
import { rootPath } from './config.js';
import { argValue } from './util.js';

/** Normalise a stub to the MultiPL-E prompt shape: everything up to and including the opening brace. */
export function stubToTask(stub) {
  let prompt = stub.replace(/\s+$/, '');
  prompt = prompt.replace(/\{\s*\}$/, '{'); // "function f(x) {}" -> "function f(x) {"
  if (!prompt.endsWith('{')) throw new Error('the stub must end with the function signature and its opening "{"');
  const entryPoint = entryPointOf(prompt);
  if (!entryPoint) throw new Error('no "function name(...)" signature found in the stub');
  const comments = prompt.split('\n').filter((l) => l.trim().startsWith('//')).join(' ');
  return { id: 'cli', prompt: `${prompt}\n`, entryPoint, vars: { prompt }, keywordText: `${comments} ${entryPoint}` };
}

export async function solveStub({ cfg: baseCfg, stub, variant, llm }) {
  const cfg = variantConfig(baseCfg, variant ?? baseCfg.product.variant);
  const task = stubToTask(stub);
  const mem = loadMemory(cfg);
  const lv = cfg.variant.levers;
  const memory = {
    systemPrompt: readPrompt(cfg, mem.champion.promptVersion),
    lessons: lv.lessons ? mem.champion.lessonIds.map((id) => mem.lessons.get(id)).filter(Boolean) : [],
    skills: lv.skills ? mem.champion.skillIds.map((id) => mem.skills.get(id)).filter(Boolean) : [],
  };
  const tplDir = rootPath(cfg, cfg.paths.templatesDir);
  const templates = { ...loadSharedTemplates(cfg), solveUser: fs.readFileSync(`${tplDir}/${cfg.tracks['multipl-e'].solveUserTemplate}`, 'utf8') };
  const publicTests = publicTestSource(task.prompt, task.entryPoint, cfg.curriculum.ecmaVersion);
  const a = await attemptWithChecks({ llm, problem: task, memory, templates, cfg, temperature: cfg.eval.temperature, seed: cfg.llm.seed, reserve: 0,
    extract: extractCode, publicTests, samples: lv.sampleFilter ? cfg.agent.samples : cfg.product.maxAttemptsWithoutExamples,
    repairs: lv.selfRepair ? cfg.eval.selfRepairAttempts : 0, feedbackLabel: cfg.agent.feedbackLabels.eval });
  const check = publicTests ? await runTests(a.res.code, publicTests, cfg.judge) : null;
  return {
    code: a.res.code,
    examples: extractExamples(task.prompt, task.entryPoint).length,
    examplesPass: check ? check.type === RESULT.PASS : null,
    output: check?.output ?? '',
    requests: a.requests, samples: a.samplesDrawn, repairs: a.repairsDone,
    variant: cfg.variant.name, lessonsAvailable: memory.lessons.length, promptVersion: mem.champion.promptVersion,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: npm run solve -- path/to/stub.js [--variant=<name>] [--mock]');
  const cfg = loadConfig({ overrides: argv.includes('--mock') ? { llm: { provider: 'mock' } } : undefined });
  const r = await solveStub({ cfg, stub: fs.readFileSync(file, 'utf8'), variant: argValue(argv, 'variant'), llm: createLLM(cfg) });
  process.stdout.write(r.code);
  const verdict = r.examplesPass === null ? 'no worked examples in the stub, so the answer is unchecked'
    : r.examplesPass ? `passes all ${r.examples} worked examples`
      : `does NOT pass the worked examples:\n${r.output.split('\n').filter((l) => / should be /.test(l)).join('\n') || r.output}`;
  process.stderr.write(`\n[${r.variant}, prompt ${r.promptVersion}, ${r.lessonsAvailable} lessons, ${r.samples} sample(s), ${r.repairs} repair(s), ${r.requests} model calls] ${verdict}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
