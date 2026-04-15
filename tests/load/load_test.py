"""
SAST Load Test Script
---------------------
Copies files from src/ into the sast-test repo ONE FILE AT A TIME.
Each file gets its own branch, commit, and push — triggering a separate
webhook → Lambda invocation per file.

Usage:
    python load_test.py                        # copy all files, one branch each
    python load_test.py --delay 5              # 5s pause between each file/push
    python load_test.py --max-files 10         # only process first 10 files
    python load_test.py --max-files 10 --delay 3
"""

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────
SRC_DIR       = Path(r"C:\Users\YW\CS6620\sast-test\routes")
DEST_DIR      = Path(r"C:\Users\YW\CS6620\sast-test")
BRANCH_PREFIX = "file"
# ───────────────────────────────────────────────────────────────────────────────


def run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Run a git command in cwd, printing it first. Exits on failure."""
    cmd = ["git"] + args
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    if result.stdout.strip():
        print(f"  {result.stdout.strip()}")
    return result


def detect_default_branch(dest: Path) -> str:
    """Return 'main' or 'master' (or whatever origin/HEAD points to)."""
    res = subprocess.run(
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
        cwd=dest, capture_output=True, text=True
    )
    return res.stdout.strip().split("/")[-1] if res.returncode == 0 else "main"


def next_branch_number(dest: Path, prefix: str) -> int:
    """Scan existing local + remote branches to find the next available number."""
    result = subprocess.run(
        ["git", "branch", "-a"],
        cwd=dest, capture_output=True, text=True
    )
    numbers = []
    for line in result.stdout.splitlines():
        name = line.strip().lstrip("* ").split("/")[-1]
        if name.startswith(prefix + "-"):
            suffix = name[len(prefix) + 1:]
            if suffix.isdigit():
                numbers.append(int(suffix))
    return max(numbers, default=0) + 1


def collect_files(src: Path) -> list[Path]:
    """Return all .py files under src, sorted for deterministic ordering."""
    if not src.exists():
        print(f"ERROR: Source directory not found: {src}", file=sys.stderr)
        sys.exit(1)
    return sorted(f for f in src.rglob("*.py") if f.is_file())


def push_single_file(
    src_file: Path,
    src_root: Path,
    dest: Path,
    branch_name: str,
    default_branch: str,
) -> None:
    """
    For one source file:
      1. Switch back to default branch
      2. Create a new branch
      3. Copy just that one file
      4. Commit + push  →  triggers webhook
    """
    relative   = src_file.relative_to(src_root)
    dest_file  = dest / relative

    print(f"\n{'='*60}")
    print(f"  Branch : {branch_name}")
    print(f"  File   : {relative}")
    print(f"{'='*60}")

    # 1. Return to default branch
    print(f"\n[1/4] Checking out '{default_branch}'...")
    run_git(["checkout", default_branch], dest)

    # 2. Create new branch from default
    print(f"\n[2/4] Creating branch '{branch_name}'...")
    run_git(["checkout", "-b", branch_name], dest)

    # 3. Copy the single file
    print(f"\n[3/4] Copying {relative} ...")
    dest_file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_file, dest_file)

    # 4. Commit & push
    print("\n[4/4] Committing and pushing...")
    run_git(["add", str(dest_file)], dest)

    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=dest, capture_output=True, text=True
    )
    if not status.stdout.strip():
        print("  No change detected — skipping commit (file identical).")
        run_git(["checkout", default_branch], dest)
        run_git(["branch", "-d", branch_name], dest)
        return

    run_git(
        ["commit", "-m", f"load-test: add {relative.as_posix()} [{branch_name}]"],
        dest
    )
    run_git(["push", "origin", branch_name], dest)
    print(f"\n  ✓ Pushed '{branch_name}' — webhook should fire now.")


def main() -> None:
    parser = argparse.ArgumentParser(description="SAST load test — one file per branch")
    parser.add_argument(
        "--delay", type=float, default=2.0,
        help="Seconds to wait between each file push (default: 0)"
    )
    parser.add_argument(
        "--max-files", type=int, default=None,
        help="Max number of files to process (default: all)"
    )
    args = parser.parse_args()

    # Collect files
    all_files = collect_files(SRC_DIR)
    files = all_files[: args.max_files] if args.max_files else all_files

    print(f"Source     : {SRC_DIR}")
    print(f"Dest       : {DEST_DIR}")
    print(f"Files found: {len(all_files)}  (processing: {len(files)})")
    print(f"Delay      : {args.delay}s between pushes")

    # Pull latest once before starting
    print("\nFetching latest from origin...")
    run_git(["fetch", "origin"], DEST_DIR)
    default_branch = detect_default_branch(DEST_DIR)
    run_git(["checkout", default_branch], DEST_DIR)
    run_git(["pull", "origin", default_branch], DEST_DIR)

    start_num = next_branch_number(DEST_DIR, BRANCH_PREFIX)

    for i, src_file in enumerate(files):
        branch = f"{BRANCH_PREFIX}-{start_num + i}"
        push_single_file(src_file, SRC_DIR, DEST_DIR, branch, default_branch)

        if i < len(files) - 1 and args.delay > 0:
            print(f"\n  Waiting {args.delay}s before next file...")
            time.sleep(args.delay)

    print(f"\n{'='*60}")
    print(f"  Done! {len(files)} file(s) pushed as separate branches.")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()