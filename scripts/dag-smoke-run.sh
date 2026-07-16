#!/usr/bin/env bash
# Contained end-to-end smoke run of the executor against scripts/smoke-dag.json.
#
# Runs real Codex sessions, so it consumes account capacity and needs `codex`
# on PATH. Fully self-contained: all mutation happens on a throwaway
# branch and a gitignored scratch dir, both removed on exit (success OR failure)
# via the cleanup trap. The branch you start on is restored untouched.
#
# Usage:  scripts/dag-smoke-run.sh
#         DAG_SMOKE_MODEL=<codex-model> scripts/dag-smoke-run.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ORIG_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TMP_BRANCH="dag-smoke-run"
SMOKE_DIR=".claude/ai/smoke"            # gitignored — events/state/lock land here
DAG="$SMOKE_DIR/smoke-dag.json"
MODEL="${DAG_SMOKE_MODEL:-account-default}"

if git show-ref --verify --quiet "refs/heads/$TMP_BRANCH"; then
  echo "refusing to run: branch $TMP_BRANCH already exists — clean it up first" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to run: working tree is dirty — commit or stash first" >&2
  exit 1
fi

cleanup() {
  echo "--- cleanup ---"
  git checkout --quiet "$ORIG_BRANCH" 2>/dev/null || git checkout --force --quiet "$ORIG_BRANCH"
  git worktree prune 2>/dev/null || true
  # delete any per-task worktree branches that did not self-clean
  for b in $(git for-each-ref --format='%(refname:short)' refs/heads/dag/ 2>/dev/null); do
    git branch -D "$b" 2>/dev/null || true
  done
  git branch -D "$TMP_BRANCH" 2>/dev/null || true
  rm -rf smoke-out "$SMOKE_DIR" .worktrees
  echo "restored branch: $(git rev-parse --abbrev-ref HEAD)"
}
trap cleanup EXIT

mkdir -p "$SMOKE_DIR"
cp scripts/smoke-dag.json "$DAG"

git checkout --quiet -b "$TMP_BRANCH"
echo "=== running smoke DAG on throwaway branch $TMP_BRANCH (model=$MODEL) ==="
set +e
node build/index.js "$DAG" --provider=codex --model "$MODEL"
RUN_EXIT=$?
set -e

EVENTS="${DAG%.json}.events.jsonl"
echo
echo "=== run exit code: $RUN_EXIT ==="
echo "=== produced files ==="
for f in smoke-out/alpha.txt smoke-out/bravo.txt smoke-out/combined.md; do
  if [ -f "$f" ]; then echo "--- $f ---"; cat "$f"; else echo "MISSING: $f"; fi
done

echo
echo "=== event kinds ==="
if [ -f "$EVENTS" ]; then
  jq -r '.kind' "$EVENTS" | sort | uniq -c
  echo "=== per-task telemetry (task.completed) ==="
  jq -r 'select(.kind=="task.completed") | "\(.taskId): cost=$\(.usage.costUSD // 0) turns=\(.usage.numTurns // 0) in=\(.usage.inputTokens // 0) out=\(.usage.outputTokens // 0) dur=\(.usage.durationMs // 0)ms"' "$EVENTS"
  echo "=== terminal event ==="
  jq -rc 'select(.kind=="dag.completed" or .kind=="dag.paused" or .kind=="dag.aborted") | {kind, reason}' "$EVENTS" 2>/dev/null || true
else
  echo "no events file at $EVENTS"
fi

exit "$RUN_EXIT"
