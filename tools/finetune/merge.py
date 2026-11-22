"""Merge the trained LoRA adapter into the base weights and save a plain Hugging Face model directory.

Ollama no longer loads LoRA adapters, so the fine-tuned model is served as merged weights, converted to GGUF and
quantized by Ollama the same way as the untrained base model it is compared with (variant `finetune-base`).

    python tools/finetune/merge.py --settings <dir>/settings.json
"""
import argparse
import json
import shutil
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", required=True)
    s = json.load(open(ap.parse_args().settings, encoding="utf-8"))
    model = AutoModelForCausalLM.from_pretrained(s["baseDir"], dtype=getattr(torch, s["dtype"]))
    model = PeftModel.from_pretrained(model, s["adapterDir"]).merge_and_unload()
    out = Path(s["mergedDir"])
    model.to(getattr(torch, s["mergedDtype"])).save_pretrained(out, safe_serialization=True)
    AutoTokenizer.from_pretrained(s["baseDir"]).save_pretrained(out)
    # keep the base model's generation settings
    gen = Path(s["baseDir"]) / "generation_config.json"
    if gen.exists():
        shutil.copy(gen, out / "generation_config.json")
    print(f"merged model written to {out}", flush=True)


if __name__ == "__main__":
    main()
