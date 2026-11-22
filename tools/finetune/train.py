"""LoRA fine-tune of the base model on the system's own verified solutions (CPU, GitHub runner).

Every value comes from the JSON settings file written by `node src/finetune/prepare.js` (which reads
config/default.json), so nothing here is hard-coded: model id, revision, LoRA shape, learning rate,
sequence length and the wall-clock budget.

    python tools/finetune/train.py --settings <dir>/settings.json

Inputs (paths in the settings file): the base model directory (Hugging Face snapshot) and sft.jsonl, one
{"problemId", "messages": [system, user], "completion"} per line. Loss is on the completion tokens only.
Output: a PEFT adapter directory plus train-metrics.json (examples seen, steps, losses, seconds).
The dataset is data written by the model and checked by tests; nothing in it is executed here.
"""
import argparse
import json
import math
import os
import random
import shutil
import time

import torch
from peft import LoraConfig, get_peft_model, set_peft_model_state_dict
from safetensors.torch import load_file
from transformers import AutoModelForCausalLM, AutoTokenizer


def load_examples(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def encode(tok, ex, max_len):
    prompt = tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=True)
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    c_ids = tok(ex["completion"] + tok.eos_token, add_special_tokens=False)["input_ids"]
    if len(p_ids) + len(c_ids) > max_len:
        return None  # skipped (counted), never truncated into a broken target
    ids = p_ids + c_ids
    labels = [-100] * len(p_ids) + c_ids
    return torch.tensor([ids]), torch.tensor([labels])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", required=True)
    s = json.load(open(ap.parse_args().settings, encoding="utf-8"))
    t0 = time.time()
    random.seed(s["seed"])
    torch.manual_seed(s["seed"])
    torch.set_num_threads(s.get("threads") or os.cpu_count())

    tok = AutoTokenizer.from_pretrained(s["baseDir"])
    model = AutoModelForCausalLM.from_pretrained(s["baseDir"], dtype=getattr(torch, s["dtype"]))
    if s.get("gradientCheckpointing"):
        # recompute activations in the backward pass: long examples otherwise exceed the runner's memory
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=s["loraRank"], lora_alpha=s["loraAlpha"], lora_dropout=s["loraDropout"],
                                             target_modules=s["targetModules"], task_type="CAUSAL_LM"))
    examples = load_examples(s["datasetFile"])
    encoded, skipped = [], 0
    for ex in examples:
        e = encode(tok, ex, s["maxSeqTokens"])
        if e is None:
            skipped += 1
        else:
            encoded.append(e)
    order = []
    for _ in range(s["epochs"]):
        ep = list(range(len(encoded)))
        random.shuffle(ep)
        order += ep
    accum = s["gradAccumSteps"]
    total_steps = max(1, math.ceil(len(order) / accum))
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=s["learningRate"], weight_decay=s["weightDecay"])
    warm = max(1, int(total_steps * s["warmupFraction"]))
    # linear warm-up, then linear decay to zero at the planned last step
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda st: (st + 1) / warm if st < warm else max(0.0, (total_steps - st) / max(1, total_steps - warm)))

    # Checkpoint/resume: a killed or restarted process continues where it stopped (same order, optimizer state,
    # elapsed time counted against the budget) instead of starting over.
    ckpt = s.get("checkpointDir")
    every = s.get("checkpointEverySteps") or 0
    losses, seen, steps, stopped, start_i, spent = [], 0, 0, "finished", 0, 0.0
    if ckpt and os.path.exists(os.path.join(ckpt, "state.json")):
        st = json.load(open(os.path.join(ckpt, "state.json"), encoding="utf-8"))
        set_peft_model_state_dict(model, load_file(os.path.join(ckpt, "adapter", "adapter_model.safetensors")))
        o = torch.load(os.path.join(ckpt, "optim.pt"), weights_only=False)
        opt.load_state_dict(o["opt"])
        sched.load_state_dict(o["sched"])
        losses, seen, steps, start_i, spent = st["losses"], st["seen"], st["steps"], st["nextIndex"], st["seconds"]
        print(f"resumed from checkpoint at step {steps} ({seen} examples, {spent:.0f}s already spent)", flush=True)

    def save_checkpoint(next_i):
        tmp = ckpt + ".tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        model.save_pretrained(os.path.join(tmp, "adapter"))
        torch.save({"opt": opt.state_dict(), "sched": sched.state_dict()}, os.path.join(tmp, "optim.pt"))
        with open(os.path.join(tmp, "state.json"), "w", encoding="utf-8") as f:
            json.dump({"losses": losses, "seen": seen, "steps": steps, "nextIndex": next_i,
                       "seconds": spent + time.time() - train_start}, f)
        shutil.rmtree(ckpt, ignore_errors=True)
        os.replace(tmp, ckpt)

    model.train()
    deadline = time.time() + s["maxTrainSeconds"] - spent
    train_start = time.time()
    running = 0.0
    for i, idx in enumerate(order):
        if i < start_i:
            continue
        if time.time() > deadline:
            stopped = "time-limit"
            break
        ids, labels = encoded[idx]
        loss = model(input_ids=ids, labels=labels).loss / accum
        loss.backward()
        running += loss.item()
        seen += 1
        if seen % accum == 0 or i == len(order) - 1:
            torch.nn.utils.clip_grad_norm_(params, s["maxGradNorm"])
            opt.step()
            sched.step()
            opt.zero_grad()
            steps += 1
            losses.append(round(running, 4))
            running = 0.0
            if steps % s["logEverySteps"] == 0:
                el = spent + time.time() - train_start
                print(f"step {steps}/{total_steps} loss {losses[-1]:.4f} examples {seen} {el / seen:.1f}s/example", flush=True)
            if ckpt and every and steps % every == 0:
                save_checkpoint(i + 1)
    model.save_pretrained(s["adapterDir"])
    metrics = {
        "examples": len(examples), "usable": len(encoded), "skippedTooLong": skipped, "examplesSeen": seen,
        "epochsPlanned": s["epochs"], "steps": steps, "stepsPlanned": total_steps, "stopped": stopped,
        "lossFirst": losses[0] if losses else None, "lossLast": losses[-1] if losses else None,
        "lossMeanLastTenth": round(sum(losses[-max(1, len(losses) // 10):]) / max(1, len(losses[-max(1, len(losses) // 10):])), 4) if losses else None,
        "secondsTotal": round(time.time() - t0 + spent, 1), "secondsPerExample": round((spent + time.time() - train_start) / max(1, seen), 2),
    }
    with open(s["metricsFile"], "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)
    print(json.dumps(metrics), flush=True)


if __name__ == "__main__":
    main()
