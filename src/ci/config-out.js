// Prints the runtime values the workflow needs as GITHUB_OUTPUT lines, so the YAML never hard-codes a
// model name, version, URL or variant list.
//   node src/ci/config-out.js                    -> global values + matrix (JSON list of variant names)
//   node src/ci/config-out.js --variant=<name>   -> also that variant's track and state dir
import { loadConfig } from '../config.js';
import { variantConfig, servedModel, activeVariants } from '../variants.js';

const cfg = loadConfig();
const rt = cfg.runtime;
const variant = process.argv.find((a) => a.startsWith('--variant='))?.slice('--variant='.length);
const out = {
  model: cfg.llm.model,
  provider: cfg.llm.provider,
  ollama_version: rt.ollamaVersion,
  ollama_url: rt.ollamaDownloadUrl.replace('{version}', rt.ollamaVersion),
  ollama_host: rt.ollamaHost,
  ollama_ready_timeout: rt.ollamaReadyTimeoutSec,
  ollama_context_length: rt.ollamaContextLength,
  setup_retries: rt.setupRetries,
  setup_retry_delay: rt.setupRetryDelaySec,
  warmup_timeout: rt.warmupTimeoutSec,
  warmup_tokens: rt.warmupTokens,
  artifact_prefix: rt.artifactName,
  publish_artifact: rt.publishArtifactName,
  artifact_retention_days: rt.artifactRetentionDays,
  state_dir: cfg.paths.stateDir,
  variants_dir: `${cfg.paths.stateDir}/${cfg.paths.variantsDir}`,
  site_dir: cfg.site.outFile.split('/').slice(0, -1).join('/') || '.',
  curriculum_cache: cfg.curriculum.cacheDir,
  dataset_cache: cfg.dataset.cacheDir,
  matrix: JSON.stringify(activeVariants(cfg).map((v) => v.name)),
  // stock-model variants start right away; only variants serving the fine-tuned (or reference) model wait for it
  matrix_stock: JSON.stringify(activeVariants(cfg).filter((v) => !servedModel(cfg, variantConfig(cfg, v.name).variant.levers)).map((v) => v.name)),
  matrix_served: JSON.stringify(activeVariants(cfg).filter((v) => servedModel(cfg, variantConfig(cfg, v.name).variant.levers)).map((v) => v.name)),
  // per-variant job time limits (a larger model needs longer); default runtime.improveJobMinutes
  max_parallel: rt.maxParallel,
  chain: String(Boolean(cfg.cycle.chain)),
  // exploration shards: one matrix entry per shard, with the model it pulls and its job time limit
  explore_matrix: JSON.stringify(cfg.explore.shards.map((x) => ({ shard: x.shard, model: x.model, pull_model: cfg.explore.models[x.model].model, minutes: cfg.explore.models[x.model].jobMinutes }))),
  explore_artifact: cfg.explore.artifactPrefix,
  timeouts: JSON.stringify(Object.fromEntries(activeVariants(cfg).map((v) => [v.name, v.jobMinutes ?? rt.improveJobMinutes]))),
};
// fine-tuning (expert iteration): the first variant with the finetune lever, and everything its job needs
// only an ACTIVE fine-tuned variant needs the fine-tuning job (stopped variants keep their history)
const ftVariant = activeVariants(cfg).find((v) => v.levers?.finetune)?.name ?? '';
const ft = cfg.finetune;
Object.assign(out, {
  finetune_variant: ftVariant,
  ft_base_model: ft.baseModel,
  ft_base_revision: ft.baseRevision,
  ft_ollama_model: ft.ollamaModel,
  // file:sha256 pairs; mirrors are URL templates with {file} left for the download script
  ft_base_files: Object.entries(ft.baseFiles).map(([f, sha]) => `${f}:${sha}`).join(' '),
  ft_base_mirrors: ft.baseMirrors.map((m) => m.replace('{model}', ft.baseModel).replace('{revision}', ft.baseRevision)).join(' '),
  ft_download_retries: ft.downloadRetries,
  ft_download_max_seconds: ft.downloadMaxSeconds,
  ft_download_step_minutes: ft.downloadStepMinutes,
  ft_torch_index: ft.pythonIndexUrl,
  ft_torch_package: ft.torchPackage,
  ft_python_packages: ft.pythonPackages.join(' '),
  ft_quantize: ft.quantize,
  ft_out_type: ft.ggufOutType,
  ft_llama_repo: ft.llamaCppRepo,
  ft_llama_commit: ft.llamaCppCommit,
  ft_quantize_tool: ft.quantizeTool,
  ft_model_gguf: ft.modelGguf,
  ft_artifact: ft.artifactName,
  ft_base_artifact: ft.baseArtifactName,
  ft_merged_dir: ft.mergedDir,
  ft_settings_file: ft.settingsFile,
  ft_adapter_dir: ft.adapterDir,
  ft_manifest_file: ft.manifestFile,
  ft_metrics_file: ft.metricsFile,
});
if (variant) {
  const vc = variantConfig(cfg, variant);
  out.track = vc.track;
  out.variant_state_dir = vc.paths.stateDir;
  out.finetune = String(Boolean(vc.variant.levers.finetune));
  const served = servedModel(cfg, vc.variant.levers);
  out.served = String(Boolean(served));
  out.served_artifact = served?.artifact ?? '';
  // the stock Ollama model this job pulls: the variant's own model, or the base its served model is built on
  out.pull_model = served ? cfg.llm.model : vc.llm.model;
  out.variant_model = vc.llm.model;
}
for (const [k, v] of Object.entries(out)) {
  if (/[\r\n]/.test(String(v))) throw new Error(`config value for ${k} contains a newline`);
  console.log(`${k}=${v}`);
}
