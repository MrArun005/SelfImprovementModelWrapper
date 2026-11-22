// Variants are data (config.variants): each toggles levers and gets its own state directory and
// its share of the request budget. variantConfig() returns a config whose paths/budget/features are
// specialised for one variant, so the rest of the code doesn't need to know about variants.
import path from 'node:path';

export function listVariants(cfg) {
  return cfg.variants.map((v) => v.name);
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
  const total = cfg.variants.reduce((s, v) => s + v.budgetShare, 0);
  const share = getVariant(cfg, name).budgetShare / total;
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

export function variantConfig(cfg, name) {
  const v = getVariant(cfg, name);
  const levers = { lessons: false, skills: false, promptOptimizer: false, selfRepair: false, sampleFilter: false, finetune: false, requantizedBase: false, ...v.levers };
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
