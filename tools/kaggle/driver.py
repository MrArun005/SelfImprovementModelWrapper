"""Advance the Kaggle self-improvement loop by one step (idempotent; run it as often as you like).

    KAGGLE_API_TOKEN=... KAGGLE_USER=<kaggle username> python3 tools/kaggle/driver.py [--profile rsi-7b] [--kaggle <cli>]

Reads the recorded rounds (SIC_PROFILE plan), then for the next round's Kaggle job:
  not created yet  -> creates it: a GPU job that clones this repo at origin/main's commit and runs tools/kaggle/round.sh,
                      mounting the previous round's job output (its model.gguf)
  queued / running -> nothing to do
  complete         -> downloads its results (not the model), folds them in (src/rsi/cli.js record), commits rsi state
                      and the report, pushes; the next call starts the following round
  error            -> prints the log tail and exits 2 (nothing is retried automatically)
The token comes from the environment and is never written anywhere. Prints one status line.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def sh(*cmd, env=None, capture=True, check=True):
    r = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=capture)
    if check and r.returncode != 0:
        raise SystemExit(f"command failed ({r.returncode}): {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r.stdout if capture else ""


def plan(profile):
    env = dict(os.environ, SIC_PROFILE=profile)
    out = sh("node", "src/rsi/cli.js", "plan", env=env)
    return dict(line.split("=", 1) for line in out.strip().splitlines())


def status(kaggle, slug):
    r = subprocess.run([kaggle, "kernels", "status", slug], text=True, capture_output=True)
    text = (r.stdout + r.stderr).lower()
    for s in ("complete", "error", "cancel", "running", "queued"):
        if s in text:
            return s
    missing = ("404" in text or "not found" in text or "cannot access kernel" in text)
    return "missing" if missing else f"unknown: {text.strip()[-200:]}"


def run_py(repo, commit, profile, overrides=""):
    return (
        "import os, subprocess, sys\n"
        "# Clone the experiment code at a fixed commit and run one round (tools/kaggle/round.sh).\n"
        f"subprocess.run(['git', 'clone', '-q', {repo!r}, '/tmp/sic-repo'], check=True)\n"
        f"subprocess.run(['git', '-C', '/tmp/sic-repo', 'checkout', '-q', {commit!r}], check=True)\n"
        f"env = dict(os.environ, SIC_PROFILE={profile!r}, PREV_MODEL_DIR='/kaggle/input', SIC_CONFIG_OVERRIDES={overrides!r})\n"
        "sys.exit(subprocess.run(['bash', '/tmp/sic-repo/tools/kaggle/round.sh'], env=env).returncode)\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="rsi-7b")
    ap.add_argument("--kaggle", default="kaggle")
    ap.add_argument("--restart", action="store_true", help="with --smoke: start a new smoke job even if one finished")
    ap.add_argument("--smoke", action="store_true", help="start a short job that exercises every step (config kaggle.smokeOverrides); records nothing")
    a = ap.parse_args()
    user = os.environ.get("KAGGLE_USER")
    if not user or not os.environ.get("KAGGLE_API_TOKEN"):
        raise SystemExit("KAGGLE_USER and KAGGLE_API_TOKEN must be set")
    cfg = json.loads((ROOT / "config/default.json").read_text())
    kg = cfg["kaggle"]
    sh("git", "fetch", "-q", "origin", "main")
    sh("git", "merge", "-q", "--no-edit", "origin/main")
    p = plan(a.profile)
    if p.get("stop"):
        print(f"stopped: {p['stop']} (after round {int(p['round']) - 1})")
        return
    r = int(p["round"])
    if a.smoke:
        slug = f"{user}/{kg['kernelPrefix']}smoke"
        st = status(a.kaggle, slug)
        if st in ("queued", "running"):
            print(f"smoke: {slug} {st}")
            return
        if st == "missing" or a.restart:
            commit = sh("git", "rev-parse", "origin/main").strip()
            with tempfile.TemporaryDirectory() as d:
                Path(d, "run.py").write_text(run_py(kg["repoUrl"], commit, a.profile, json.dumps(kg["smokeOverrides"])))
                Path(d, "kernel-metadata.json").write_text(json.dumps({"id": slug, "title": f"{kg['kernelPrefix']}smoke", "code_file": "run.py",
                    "language": "python", "kernel_type": "script", "is_private": True, "enable_gpu": True, "enable_internet": True,
                    "dataset_sources": [], "competition_sources": [], "kernel_sources": [], "machine_shape": kg["machineShape"]}))
                out = subprocess.run([a.kaggle, "kernels", "push", "-p", d], text=True, capture_output=True)
                print(out.stdout.strip() or out.stderr.strip())
            return
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([a.kaggle, "kernels", "output", slug, "-p", d, "--file-pattern", r"\.log$"], capture_output=True)
            for f in Path(d).glob("*.log"):
                print("".join(e.get("data", "") for e in json.loads(f.read_text()))[-4000:])
        print(f"smoke: {slug} {st}")
        return
    slug = f"{user}/{kg['kernelPrefix']}{r}"
    st = status(a.kaggle, slug)
    if st == "missing":
        commit = sh("git", "rev-parse", "origin/main").strip()
        with tempfile.TemporaryDirectory() as d:
            Path(d, "run.py").write_text(run_py(kg["repoUrl"], commit, a.profile))
            meta = {"id": slug, "title": f"{kg['kernelPrefix']}{r}", "code_file": "run.py", "language": "python",
                    "kernel_type": "script", "is_private": True, "enable_gpu": True, "enable_internet": True,
                    "dataset_sources": [], "competition_sources": [],
                    "kernel_sources": [f"{user}/{kg['kernelPrefix']}{r - 1}"] if r > 1 else [],
                    "machine_shape": kg["machineShape"]}
            Path(d, "kernel-metadata.json").write_text(json.dumps(meta))
            out = subprocess.run([a.kaggle, "kernels", "push", "-p", d], text=True, capture_output=True)
            print(out.stdout.strip() or out.stderr.strip())
        print(f"round {r}: started {slug} at commit {commit[:8]}")
        return
    if st in ("queued", "running"):
        print(f"round {r}: {slug} {st}")
        return
    if st != "complete":
        with tempfile.TemporaryDirectory() as d:
            subprocess.run([a.kaggle, "kernels", "output", slug, "-p", d, "--file-pattern", r"\.log$"], capture_output=True)
            for f in Path(d).glob("*.log"):
                lines = "".join(e.get("data", "") for e in json.loads(f.read_text()))
                print(lines[-3000:])
        print(f"round {r}: {slug} {st}")
        sys.exit(2)
    with tempfile.TemporaryDirectory() as d:
        sh(a.kaggle, "kernels", "output", slug, "-p", d, "--file-pattern", r"\.(jsonl|json|txt|log)$")
        out = next((x for x in Path(d).rglob("plan.txt")), None)
        if out is None:
            raise SystemExit(f"round {r}: {slug} finished without results")
        base = out.parent
        env = dict(os.environ, SIC_PROFILE=a.profile)
        sh("node", "src/rsi/cli.js", "record", f"--round={r}", f"--run-id=kaggle:{slug}", f"--search-dir={base / 'search'}",
           f"--exam-dir={base / 'exam'}", f"--train-dir={base / 'train'}", env=env, capture=False)
    prof = json.loads(json.dumps(cfg["profiles"][a.profile]["rsi"]))
    sh("git", "add", "--", prof["stateDir"], prof["reportFile"])
    sh("git", "commit", "-q", "-m", f"{a.profile}: round {r} (Kaggle job {slug})")
    for ref in ("main", sh("git", "rev-parse", "--abbrev-ref", "HEAD").strip()):
        for _ in range(4):
            if subprocess.run(["git", "push", "-q", "origin", f"HEAD:{ref}"], cwd=ROOT, capture_output=True).returncode == 0:
                break
            sh("git", "pull", "-q", "--no-rebase", "--no-edit", "origin", "main")
    print(f"round {r}: recorded and pushed")


if __name__ == "__main__":
    main()
