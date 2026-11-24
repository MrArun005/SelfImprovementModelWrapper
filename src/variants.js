// Variants are data (config.variants): each toggles levers and gets its own state directory and
// its share of the request budget. variantConfig() returns a config whose paths/budget/features are
// specialised for one variant, so the rest of the code doesn't need to know about variants.
import path from 'node:path';
import { deepMerge } from './config.js';

/** Variants that still run daily (`active: false` keeps a stopped variant's history in the reports). */
export function activeVariants(cfg) {
  return cfg.variants.filter((v) => v.active !== false);
}

/** Comparison group: variants are compared with the control of their group (default: their track). */
export const groupOf = (v) => v.group ?? v.track;

export function listVariants(cfg) {
  return activeVariants(cfg).map((v) => v.name);
}

export function getVariant(cfg, name) {
  const v = cfg.variants.find((x) => x.name === name);
  if (!v) throw new Error(`unknown variant "${name}"; known: ${listVariants(cfg).join(', ')}`);
  return v;
}

export function variantStateDir(cfg, name) {
  return path.join(cfg.paths.stateDir, cfg.paths.variantsDir, name);
}

/** Budget for one variant = total x share / sum(shares), floored. */
export function variantBudget(cfg, name) {
  const self = getVariant(cfg, name);
  const pool = activeVariants(cfg).some((v) => v.name === name) ? activeVariants(cfg) : [...activeVariants(cfg), self];
  const total = pool.reduce((s, v) => s + v.budgetShare, 0);
  const share = self.budgetShare / total;
  const b = cfg.budget;
  const requestsPerRun = Math.floor(b.totalRequestsPerRun * share);
  return {
    ...b,
    requestsPerRun,
    requestsPerDay: Math.floor(b.totalRequestsPerDay * share),
    reserveForHoldout: Math.floor(requestsPerRun * b.holdoutFraction),
  };
}

/** Model this variant serves from the fine-tuning job's artifacts, or null for the stock Ollama model. */
export function servedModel(cfg, levers) {
  if (levers.finetune) return { model: cfg.finetune.ollamaModel, artifact: cfg.finetune.artifactName };
  if (levers.requantizedBase) return { model: cfg.finetune.baseOllamaModel, artifact: cfg.finetune.baseArtifactName };
  return null;
}

export function variantConfig(baseCfg, name) {
  const v = getVariant(baseCfg, name);
  // per-variant config overrides (e.g. a larger model with fewer eval repeats and a longer time budget)
  const cfg = v.overrides ? deepMerge(baseCfg, v.overrides) : baseCfg;
  const levers = { lessons: false, skills: false, promptOptimizer: false, selfRepair: false, sampleFilter: false, finetune: false, requantizedBase: false, selfTests: false, ...v.levers };
  return {
    ...cfg,
    variant: { ...v, levers },
    track: v.track,
    paths: { ...cfg.paths, stateDir: variantStateDir(cfg, name) },
    budget: variantBudget(cfg, name),
    // finetune: base weights + merged LoRA trained on verified solutions; requantizedBase: the untrained base through
    // the same convert + quantize pipeline (the reference that isolates the effect of training)
    llm: servedModel(cfg, levers) ? { ...cfg.llm, model: servedModel(cfg, levers).model } : cfg.llm,
    features: { ...cfg.features, promptOptimizer: Boolean(cfg.features.promptOptimizer && levers.promptOptimizer) },
  };
}
