#!/usr/bin/env bash
# loom-supervisor-smoke.sh - deterministic smoke tests for loom-supervisor.
#
# Uses a stubbed dag-executor binary. Makes no model or network calls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR="${SCRIPT_DIR}/loom-supervisor.cjs"

TMP_DIR="$(mktemp -d -t loom-supervisor-smoke-XXXXXX)"
export LOOM_SUPERVISOR_CREATE_PR=0

cleanup() {
  if [[ -z "${SMOKE_KEEP_TMP:-}" ]]; then
    rm -rf "$TMP_DIR"
  else
    printf 'loom-supervisor-smoke: keeping tmp dir: %s\n' "$TMP_DIR" >&2
  fi
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS %s\n' "$1"
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  [[ "$expected" == "$actual" ]] || fail "$name expected=<$expected> actual=<$actual>"
  pass "$name"
}

assert_contains() {
  local name="$1" needle="$2" file="$3"
  grep -qF -- "$needle" "$file" || fail "$name missing <$needle> in $file"
  pass "$name"
}

assert_file_exists() {
  local name="$1" file="$2"
  [[ -f "$file" ]] || fail "$name missing file $file"
  pass "$name"
}

json_get() {
  node -e '
    const fs = require("fs");
    const obj = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = obj[process.argv[2]];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1" "$2"
}

queue_item_get() {
  node -e '
    const fs = require("fs");
    const queue = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const item = queue.items.find((entry) => entry.id === process.argv[2]);
    const value = item?.[process.argv[3]];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1" "$2" "$3"
}

write_smoke_dag() {
  local dag="$1"
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      meta: {
        id: "smoke",
        source: {
          type: "description",
          title: "Smoke",
          description: "Smoke DAG",
          figmaUrls: [],
          acceptanceCriteria: []
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        gitCommit: "abc123",
        branch: "main",
        qualityReport: { iterations: 1, checksRun: [], allPassed: true }
      },
      tasks: [{
        id: "task-a",
        name: "Task A",
        description: "Smoke task",
        dependencies: [],
        contracts: { inputs: {}, outputs: {} },
        context: { files: [] },
        completionCriteria: { automated: [], manual: [] },
        estimatedScope: "single-component",
        weight: "standard"
      }],
      executionLayers: [{ layer: 0, description: "Layer 0", taskIds: ["task-a"] }]
    }, null, 2) + "\n");
  ' "$dag"
}

write_lumpy_dag() {
  local dag="$1"
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      meta: {
        id: "lumpy",
        source: {
          type: "description",
          title: "Lumpy",
          description: "Lumpy DAG",
          figmaUrls: [],
          acceptanceCriteria: []
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        gitCommit: "abc123",
        branch: "main",
        qualityReport: { iterations: 1, checksRun: [], allPassed: true }
      },
      tasks: [
        {
          id: "fast-parent",
          name: "fast-parent",
          description: "",
          dependencies: [],
          contracts: { inputs: {}, outputs: {} },
          context: { files: [] },
          completionCriteria: { automated: [], manual: [] },
          estimatedScope: "single-component",
          weight: "standard"
        },
        {
          id: "slow-unrelated",
          name: "slow-unrelated",
          description: "",
          dependencies: [],
          contracts: { inputs: {}, outputs: {} },
          context: { files: [] },
          completionCriteria: { automated: [], manual: [] },
          estimatedScope: "single-component",
          weight: "heavy"
        },
        {
          id: "child",
          name: "child",
          description: "",
          dependencies: ["fast-parent"],
          contracts: { inputs: {}, outputs: {} },
          context: { files: [] },
          completionCriteria: { automated: [], manual: [] },
          estimatedScope: "single-component",
          weight: "standard"
        }
      ],
      executionLayers: [
        { layer: 0, description: "roots", taskIds: ["fast-parent", "slow-unrelated"] },
        { layer: 1, description: "child", taskIds: ["child"] }
      ]
    }, null, 2) + "\n");
  ' "$dag"
}

wait_json_value() {
  local file="$1" field="$2" expected="$3"
  local i value
  for i in $(seq 1 50); do
    if [[ -f "$file" ]]; then
      value="$(json_get "$file" "$field")"
      if [[ "$value" == "$expected" ]]; then
        return 0
      fi
    fi
    sleep 0.1
  done
  value="$(json_get "$file" "$field" 2>/dev/null || true)"
  fail "wait_json_value ${field} expected=<$expected> actual=<${value}> file=${file}"
}

run_status() {
  local dag="$1" ckpt="$2" out="$3"
  set +e
  env LOOM_SUPERVISOR_CHECKPOINT="$ckpt" node "$SUPERVISOR" --status "$dag" >"$out" 2>&1
  STATUS_RC=$?
  set -e
}

STUB="${TMP_DIR}/dag-executor-stub.sh"
cat >"$STUB" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

DAG_PATH="$1"
PLAN="${STUB_PLAN:?STUB_PLAN required}"
INV="${STUB_INV:?STUB_INV required}"
COUNT_FILE="${STUB_COUNT:?STUB_COUNT required}"

count=0
if [[ -f "$COUNT_FILE" ]]; then
  count="$(cat "$COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" >"$COUNT_FILE"
printf '%s\n' "$*" >>"$INV"

line="$(awk -v n="$count" 'NR==n { print; exit }' "$PLAN")"
if [[ -z "$line" ]]; then
  exit 0
fi

code="${line%%	*}"
reason=""
if [[ "$line" == *$'\t'* ]]; then
  reason="${line#*$'\t'}"
fi

if [[ -n "$reason" ]]; then
  state="${DAG_PATH%.json}.state.json"
  events="${DAG_PATH%.json}.events.jsonl"
  node -e '
    const fs = require("fs");
    const [statePath, eventsPath, dagPath, reason] = process.argv.slice(1);
    let quota;
    if (reason.includes("stale retry quota")) {
      quota = { category: "daily", reason, resetAt: "2000-01-01T00:00:02.000Z", retryAfterMs: 250 };
    } else if (reason.includes("structured quota")) {
      quota = { category: "daily", reason, resetAt: "2000-01-01T00:00:02.000Z" };
    }
    const state = { status: "paused" };
    const older = {
      kind: "dag.paused",
      schemaVersion: 1,
      ts: "2000-01-01T00:00:00.000Z",
      dagPath,
      dagId: "smoke",
      reason: "older pause reason",
      currentLayer: 0
    };
    const latest = { ...older, ts: "2000-01-01T00:00:01.000Z", reason };
    if (quota) {
      state.quota = quota;
      latest.quota = quota;
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    fs.writeFileSync(eventsPath, JSON.stringify(older) + "\n" + JSON.stringify(latest) + "\n");
  ' "$state" "$events" "$DAG_PATH" "$reason"
fi

exit "$code"
STUB
chmod +x "$STUB"

CODEX_STUB="${TMP_DIR}/codex-stub.sh"
cat >"$CODEX_STUB" <<'CODEX'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex smoke stub\n'
  exit 0
fi
exit 0
CODEX
chmod +x "$CODEX_STUB"

run_case() {
  local name="$1" expected_rc="$2" plan_body="$3"
  local dag_writer="${4:-write_smoke_dag}"
  local dir="${TMP_DIR}/${name}"
  mkdir -p "$dir"
  local dag="${dir}/dag.json"
  local plan="${dir}/plan.tsv"
  local inv="${dir}/inv.log"
  local count="${dir}/count"
  local ckpt="${dir}/ckpt.json"
  local logs="${dir}/logs"
  local supervisor_log="${dir}/supervisor.log"

  "$dag_writer" "$dag"
  printf '%s\n' "$plan_body" >"$plan"
  : >"$inv"

  set +e
  env \
    DAG_EXECUTOR_BIN="$STUB" \
    CODEX_BIN="$CODEX_STUB" \
    STUB_PLAN="$plan" \
    STUB_INV="$inv" \
    STUB_COUNT="$count" \
    LOOM_SUPERVISOR_CHECKPOINT="$ckpt" \
    LOOM_SUPERVISOR_LOG_DIR="$logs" \
    LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
    LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
    LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
    node "$SUPERVISOR" --allow-dirty-repo "$dag" --provider=codex >"$supervisor_log" 2>&1
  local rc=$?
  set -e

  if [[ "$rc" != "$expected_rc" ]]; then
    cat "$supervisor_log" >&2
  fi
  assert_eq "${name}: exit" "$expected_rc" "$rc"
  assert_contains "${name}: backlog flag" "--backlog" "$inv"
  CASE_DIR="$dir"
  CASE_CKPT="$ckpt"
  CASE_INV="$inv"
}

run_case completed 0 $'0'
assert_eq 'completed: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'completed: attempts' 1 "$(json_get "$CASE_CKPT" attempts)"
assert_eq 'completed: PR disabled' disabled "$(node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(o.pullRequest?.status || "");' "$CASE_CKPT")"

GH_STUB="${TMP_DIR}/gh-stub.sh"
GH_INV="${TMP_DIR}/gh-inv.log"
cat >"$GH_STUB" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${GH_INV:?GH_INV required}"
if [[ "${1:-}" == "--version" ]]; then
  printf 'gh version smoke\n'
elif [[ "${1:-} ${2:-}" == "pr list" ]]; then
  printf '[]\n'
elif [[ "${1:-} ${2:-}" == "pr create" ]]; then
  printf 'https://example.test/pull/42\n'
fi
GH
chmod +x "$GH_STUB"

PR_DIR="${TMP_DIR}/create_pr"
PR_REMOTE="${TMP_DIR}/create-pr-remote.git"
mkdir -p "$PR_DIR"
git init -q --bare "$PR_REMOTE"
(
  cd "$PR_DIR"
  git init -q -b main
  git config user.name 'Loom Smoke'
  git config user.email 'loom-smoke@example.test'
  printf 'base\n' >app.txt
  git add app.txt
  git commit -qm 'base'
  git remote add origin "$PR_REMOTE"
  git push -q -u origin main
  printf 'implementation\n' >>app.txt
  git add app.txt
  git commit -qm 'implement smoke DAG'
  write_smoke_dag "$PR_DIR/dag.json"
  printf '0\n' >"$PR_DIR/plan.tsv"
  : >"$PR_DIR/inv.log"
  GH_INV="$GH_INV" \
  GH_BIN="$GH_STUB" \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$PR_DIR/plan.tsv" \
  STUB_INV="$PR_DIR/inv.log" \
  STUB_COUNT="$PR_DIR/count" \
  LOOM_SUPERVISOR_CHECKPOINT="$PR_DIR/ckpt.json" \
  LOOM_SUPERVISOR_LOG_DIR="$PR_DIR/logs" \
  LOOM_SUPERVISOR_CREATE_PR=1 \
  LOOM_SUPERVISOR_GH_BIN="$GH_STUB" \
  node "$SUPERVISOR" --allow-dirty-repo "$PR_DIR/dag.json" --provider=codex >/dev/null 2>&1
)
assert_eq 'create_pr: status' completed "$(json_get "$PR_DIR/ckpt.json" status)"
assert_eq 'create_pr: URL recorded' 'https://example.test/pull/42' "$(node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(o.pullRequest?.url || "");' "$PR_DIR/ckpt.json")"
assert_contains 'create_pr: gh create invoked' 'pr create' "$GH_INV"
assert_contains 'create_pr: loom branch pushed' 'refs/heads/loom/smoke-' <(git --git-dir="$PR_REMOTE" show-ref)

run_case lumpy_backlog 0 $'0' write_lumpy_dag

run_case crash_retry 0 $'1\n0'
assert_eq 'crash_retry: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'crash_retry: attempts' 2 "$(json_get "$CASE_CKPT" attempts)"
assert_contains 'crash_retry: resume flag' '--resume' "$CASE_INV"

run_case quota_retry 0 $'2\tQuota limit reached while running task-a\n0'
assert_eq 'quota_retry: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'quota_retry: attempts' 2 "$(json_get "$CASE_CKPT" attempts)"
assert_eq 'quota_retry: pauses' 1 "$(json_get "$CASE_CKPT" pauses)"
assert_contains 'quota_retry: resume flag' '--resume' "$CASE_INV"

run_case structured_quota_wait 3 $'2\tstructured quota pause\n2\tstructured quota pause\n2\tstructured quota pause\n2\tstructured quota pause\n2\tstructured quota pause'
assert_eq 'structured_quota_wait: status' stopped "$(json_get "$CASE_CKPT" status)"
assert_eq 'structured_quota_wait: attempts' 5 "$(json_get "$CASE_CKPT" attempts)"
assert_eq 'structured_quota_wait: wait kind' quota "$(json_get "$CASE_CKPT" waitKind)"
assert_eq 'structured_quota_wait: quota category' daily "$(node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(o.quota?.category || "");' "$CASE_CKPT")"
assert_contains 'structured_quota_wait: retry time recorded' 'nextRunAt' "$CASE_CKPT"

run_case stale_reset_retry_after 3 $'2\tstale retry quota pause\n2\tstale retry quota pause\n2\tstale retry quota pause\n2\tstale retry quota pause\n2\tstale retry quota pause'
assert_eq 'stale_reset_retry_after: status' stopped "$(json_get "$CASE_CKPT" status)"
assert_eq 'stale_reset_retry_after: retry-after delay' ok "$(node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const delta=Date.parse(o.nextRunAt)-Date.parse(o.lastStartedAt); process.stdout.write(delta >= 200 ? "ok" : String(delta));' "$CASE_CKPT")"

run_case ordinary_pause 2 $'2\tMerge conflict in task-a'
assert_eq 'ordinary_pause: status' paused "$(json_get "$CASE_CKPT" status)"
assert_eq 'ordinary_pause: attempts' 1 "$(json_get "$CASE_CKPT" attempts)"

INVALID_DIR="${TMP_DIR}/invalid_preflight"
mkdir -p "$INVALID_DIR"
INVALID_DAG="${INVALID_DIR}/dag.json"
INVALID_CKPT="${INVALID_DIR}/ckpt.json"
INVALID_OUT="${INVALID_DIR}/out.txt"
printf '{"tasks":[]}\n' >"$INVALID_DAG"
set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  LOOM_SUPERVISOR_CHECKPOINT="$INVALID_CKPT" \
  node "$SUPERVISOR" --allow-dirty-repo "$INVALID_DAG" --provider=codex >"$INVALID_OUT" 2>&1
INVALID_RC=$?
set -e
assert_eq 'invalid_preflight: exit' 1 "$INVALID_RC"
assert_contains 'invalid_preflight: validation message' 'preflight failed: DAG validation failed' "$INVALID_OUT"

SCHEMA_DIR="${TMP_DIR}/schema_preflight"
mkdir -p "$SCHEMA_DIR"
SCHEMA_DAG="${SCHEMA_DIR}/dag.json"
SCHEMA_CKPT="${SCHEMA_DIR}/ckpt.json"
SCHEMA_OUT="${SCHEMA_DIR}/out.txt"
write_smoke_dag "$SCHEMA_DAG"
node -e '
  const fs = require("fs");
  const dag = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete dag.meta.source;
  fs.writeFileSync(process.argv[1], JSON.stringify(dag, null, 2) + "\n");
' "$SCHEMA_DAG"
set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  LOOM_SUPERVISOR_CHECKPOINT="$SCHEMA_CKPT" \
  node "$SUPERVISOR" --allow-dirty-repo "$SCHEMA_DAG" --provider=codex >"$SCHEMA_OUT" 2>&1
SCHEMA_RC=$?
set -e
assert_eq 'schema_preflight: exit' 1 "$SCHEMA_RC"
assert_contains 'schema_preflight: validation message' 'DAG validation failed: meta.source must be an object' "$SCHEMA_OUT"

DIRTY_DIR="${TMP_DIR}/dirty_repo_preflight"
mkdir -p "$DIRTY_DIR"
write_smoke_dag "${DIRTY_DIR}/dag.json"
(
  cd "$DIRTY_DIR"
  git init -q
  printf 'dirty\n' >dirty.txt
  set +e
  env \
    DAG_EXECUTOR_BIN="$STUB" \
    CODEX_BIN="$CODEX_STUB" \
    LOOM_SUPERVISOR_CHECKPOINT="${DIRTY_DIR}/ckpt.json" \
    node "$SUPERVISOR" "${DIRTY_DIR}/dag.json" --provider=codex >"${DIRTY_DIR}/out.txt" 2>&1
  DIRTY_RC=$?
  set -e
  assert_eq 'dirty_repo_preflight: exit' 1 "$DIRTY_RC"
  assert_contains 'dirty_repo_preflight: dirty message' 'git working tree is dirty' "${DIRTY_DIR}/out.txt"
)

STALE_LOCK_DIR="${TMP_DIR}/stale_lock_preflight"
mkdir -p "$STALE_LOCK_DIR"
STALE_LOCK_DAG="${STALE_LOCK_DIR}/dag.json"
STALE_LOCK_PLAN="${STALE_LOCK_DIR}/plan.tsv"
STALE_LOCK_INV="${STALE_LOCK_DIR}/inv.log"
STALE_LOCK_COUNT="${STALE_LOCK_DIR}/count"
STALE_LOCK_CKPT="${STALE_LOCK_DIR}/ckpt.json"
STALE_LOCK_OUT="${STALE_LOCK_DIR}/out.txt"
write_smoke_dag "$STALE_LOCK_DAG"
printf '0\n' >"$STALE_LOCK_PLAN"
: >"$STALE_LOCK_INV"
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ pid: 999999 }) + "\n");' "${STALE_LOCK_DAG}.lock"
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$STALE_LOCK_PLAN" \
  STUB_INV="$STALE_LOCK_INV" \
  STUB_COUNT="$STALE_LOCK_COUNT" \
  LOOM_SUPERVISOR_CHECKPOINT="$STALE_LOCK_CKPT" \
  LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
  LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
  node "$SUPERVISOR" --allow-dirty-repo "$STALE_LOCK_DAG" --provider=codex >"$STALE_LOCK_OUT" 2>&1
assert_eq 'stale_lock_preflight: status' completed "$(json_get "$STALE_LOCK_CKPT" status)"
[[ ! -f "${STALE_LOCK_DAG}.lock" ]] || fail 'stale_lock_preflight lock was not removed'
pass 'stale_lock_preflight: lock removed'
assert_contains 'stale_lock_preflight: warning' 'stale DAG lock detected and removed' "$STALE_LOCK_OUT"

ACTIVE_LOCK_DIR="${TMP_DIR}/active_lock_preflight"
mkdir -p "$ACTIVE_LOCK_DIR"
ACTIVE_LOCK_DAG="${ACTIVE_LOCK_DIR}/dag.json"
ACTIVE_LOCK_OUT="${ACTIVE_LOCK_DIR}/out.txt"
write_smoke_dag "$ACTIVE_LOCK_DAG"
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ pid: Number(process.argv[2]) }) + "\n");' "${ACTIVE_LOCK_DAG}.lock" "$$"
set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  node "$SUPERVISOR" --allow-dirty-repo "$ACTIVE_LOCK_DAG" --provider=codex >"$ACTIVE_LOCK_OUT" 2>&1
ACTIVE_LOCK_RC=$?
set -e
assert_eq 'active_lock_preflight: exit' 1 "$ACTIVE_LOCK_RC"
assert_contains 'active_lock_preflight: lock message' 'DAG lock is held by running pid' "$ACTIVE_LOCK_OUT"

STALE_PID_DIR="${TMP_DIR}/stale_pid_preflight"
mkdir -p "$STALE_PID_DIR"
STALE_PID_DAG="${STALE_PID_DIR}/dag.json"
STALE_PID_PLAN="${STALE_PID_DIR}/plan.tsv"
STALE_PID_INV="${STALE_PID_DIR}/inv.log"
STALE_PID_COUNT="${STALE_PID_DIR}/count"
STALE_PID_CKPT="${STALE_PID_DIR}/ckpt.json"
STALE_PID_OUT="${STALE_PID_DIR}/out.txt"
write_smoke_dag "$STALE_PID_DAG"
printf '0\n' >"$STALE_PID_PLAN"
: >"$STALE_PID_INV"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ status: "running", supervisorPid: 999999 }, null, 2) + "\n");
' "$STALE_PID_CKPT"
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$STALE_PID_PLAN" \
  STUB_INV="$STALE_PID_INV" \
  STUB_COUNT="$STALE_PID_COUNT" \
  LOOM_SUPERVISOR_CHECKPOINT="$STALE_PID_CKPT" \
  LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
  LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
  node "$SUPERVISOR" --allow-dirty-repo "$STALE_PID_DAG" --provider=codex >"$STALE_PID_OUT" 2>&1
assert_eq 'stale_pid_preflight: status' completed "$(json_get "$STALE_PID_CKPT" status)"
assert_contains 'stale_pid_preflight: warning' 'stale supervisor PID 999999' "$STALE_PID_OUT"

STATUS_OUT="${CASE_DIR}/status.txt"
run_status "${CASE_DIR}/dag.json" "$CASE_CKPT" "$STATUS_OUT"
assert_eq 'ordinary_pause status command: exit' 2 "$STATUS_RC"
assert_contains 'ordinary_pause status command: status' 'status: paused' "$STATUS_OUT"
assert_contains 'ordinary_pause status command: attempt' 'attempt: 1' "$STATUS_OUT"
assert_contains 'ordinary_pause status command: exit code' 'lastExitCode: 2' "$STATUS_OUT"
assert_contains 'ordinary_pause status command: pause reason' 'pauseReason: Merge conflict in task-a' "$STATUS_OUT"
assert_contains 'ordinary_pause status command: task counts' 'tasks: completed=0 failed=0 pending=1 blocked=0' "$STATUS_OUT"

MISSING_DIR="${TMP_DIR}/missing_status"
mkdir -p "$MISSING_DIR"
MISSING_DAG="${MISSING_DIR}/dag.json"
MISSING_CKPT="${MISSING_DIR}/missing.json"
MISSING_OUT="${MISSING_DIR}/status.txt"
printf '{}\n' >"$MISSING_DAG"
run_status "$MISSING_DAG" "$MISSING_CKPT" "$MISSING_OUT"
assert_eq 'missing status command: exit' 1 "$STATUS_RC"
assert_contains 'missing status command: status' 'status: missing' "$MISSING_OUT"

BLOCKED_DIR="${TMP_DIR}/blocked_status"
mkdir -p "$BLOCKED_DIR"
BLOCKED_DAG="${BLOCKED_DIR}/dag.json"
BLOCKED_STATE="${BLOCKED_DIR}/dag.state.json"
BLOCKED_CKPT="${BLOCKED_DIR}/ckpt.json"
BLOCKED_OUT="${BLOCKED_DIR}/status.txt"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    tasks: [
      { id: "task-a", dependencies: [] },
      { id: "task-b", dependencies: ["task-a"] },
      { id: "task-c", dependencies: ["task-b"] }
    ]
  }, null, 2) + "\n");
  fs.writeFileSync(process.argv[2], JSON.stringify({
    status: "running",
    tasks: {
      "task-a": { status: "failed" },
      "task-b": { status: "pending" },
      "task-c": { status: "pending" }
    }
  }, null, 2) + "\n");
  fs.writeFileSync(process.argv[3], JSON.stringify({
    status: "running",
    attempts: 3,
    lastExitCode: 2,
    lastLogPath: "/tmp/last.log",
    nextRunAt: "2030-01-01T00:00:00.000Z"
  }, null, 2) + "\n");
' "$BLOCKED_DAG" "$BLOCKED_STATE" "$BLOCKED_CKPT"
run_status "$BLOCKED_DAG" "$BLOCKED_CKPT" "$BLOCKED_OUT"
assert_eq 'blocked status command: exit' 2 "$STATUS_RC"
assert_contains 'blocked status command: status' 'status: running' "$BLOCKED_OUT"
assert_contains 'blocked status command: retry' 'nextRetryAt: 2030-01-01T00:00:00.000Z' "$BLOCKED_OUT"
assert_contains 'blocked status command: task counts' 'tasks: completed=0 failed=1 pending=0 blocked=2' "$BLOCKED_OUT"

DETACH_DIR="${TMP_DIR}/detach_completed"
mkdir -p "$DETACH_DIR"
DETACH_DAG="${DETACH_DIR}/dag.json"
DETACH_PLAN="${DETACH_DIR}/plan.tsv"
DETACH_INV="${DETACH_DIR}/inv.log"
DETACH_COUNT="${DETACH_DIR}/count"
DETACH_CKPT="${DETACH_DIR}/ckpt.json"
DETACH_LOG_DIR="${DETACH_DIR}/logs"
DETACH_SUPERVISOR_LOG="${DETACH_DIR}/supervisor.log"
write_smoke_dag "$DETACH_DAG"
printf '0\n' >"$DETACH_PLAN"
: >"$DETACH_INV"

env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$DETACH_PLAN" \
  STUB_INV="$DETACH_INV" \
  STUB_COUNT="$DETACH_COUNT" \
  LOOM_SUPERVISOR_CHECKPOINT="$DETACH_CKPT" \
  LOOM_SUPERVISOR_LOG_DIR="$DETACH_LOG_DIR" \
  LOOM_SUPERVISOR_DETACH_LOG="$DETACH_SUPERVISOR_LOG" \
  LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
  LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
  node "$SUPERVISOR" --allow-dirty-repo --detach "$DETACH_DAG" --provider=codex >/dev/null 2>&1
wait_json_value "$DETACH_CKPT" status completed
assert_file_exists 'detach_completed: supervisor log' "$DETACH_SUPERVISOR_LOG"
assert_contains 'detach_completed: backlog flag' '--backlog' "$DETACH_INV"
assert_eq 'detach_completed: attempts' 1 "$(json_get "$DETACH_CKPT" attempts)"

QUEUE_DIR="${TMP_DIR}/queue_run"
mkdir -p "$QUEUE_DIR"
QUEUE_PATH="${QUEUE_DIR}/queue.json"
QUEUE_DAG_LOW="${QUEUE_DIR}/low.json"
QUEUE_DAG_HIGH="${QUEUE_DIR}/high.json"
QUEUE_DAG_CANCEL="${QUEUE_DIR}/cancel.json"
QUEUE_PLAN="${QUEUE_DIR}/plan.tsv"
QUEUE_INV="${QUEUE_DIR}/inv.log"
QUEUE_COUNT="${QUEUE_DIR}/count"
QUEUE_ADD_LOW_OUT="${QUEUE_DIR}/add-low.txt"
QUEUE_ADD_HIGH_OUT="${QUEUE_DIR}/add-high.txt"
QUEUE_ADD_CANCEL_OUT="${QUEUE_DIR}/add-cancel.txt"
QUEUE_STATUS_OUT="${QUEUE_DIR}/status.txt"
write_smoke_dag "$QUEUE_DAG_LOW"
write_smoke_dag "$QUEUE_DAG_HIGH"
write_smoke_dag "$QUEUE_DAG_CANCEL"
printf '0\n0\n' >"$QUEUE_PLAN"
: >"$QUEUE_INV"

env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-add "$QUEUE_DAG_LOW" --priority=1 --allow-dirty-repo --provider=codex >"$QUEUE_ADD_LOW_OUT"
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-add "$QUEUE_DAG_HIGH" --priority=10 --allow-dirty-repo --provider=codex >"$QUEUE_ADD_HIGH_OUT"
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-add "$QUEUE_DAG_CANCEL" --priority=5 --allow-dirty-repo --provider=codex >"$QUEUE_ADD_CANCEL_OUT"
QUEUE_LOW_ID="$(awk '/^queued:/ { print $2 }' "$QUEUE_ADD_LOW_OUT")"
QUEUE_CANCEL_ID="$(awk '/^queued:/ { print $2 }' "$QUEUE_ADD_CANCEL_OUT")"

env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-pause "$QUEUE_LOW_ID" >/dev/null
assert_eq 'queue pause: status' paused "$(queue_item_get "$QUEUE_PATH" "$QUEUE_LOW_ID" status)"
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-resume "$QUEUE_LOW_ID" >/dev/null
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-priority "$QUEUE_LOW_ID" 20 >/dev/null
assert_eq 'queue priority: updated' 20 "$(queue_item_get "$QUEUE_PATH" "$QUEUE_LOW_ID" priority)"
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-cancel "$QUEUE_CANCEL_ID" >/dev/null

set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$QUEUE_PLAN" \
  STUB_INV="$QUEUE_INV" \
  STUB_COUNT="$QUEUE_COUNT" \
  LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" \
  LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
  LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
  node "$SUPERVISOR" --queue-run >/dev/null 2>&1
QUEUE_RUN_RC=$?
set -e
assert_eq 'queue run: exit' 0 "$QUEUE_RUN_RC"
assert_contains 'queue run: first dag follows updated priority' "$QUEUE_DAG_LOW" "$QUEUE_INV"
assert_eq 'queue run: first invocation' "$QUEUE_DAG_LOW" "$(awk 'NR==1 { print $1 }' "$QUEUE_INV")"
assert_eq 'queue run: low completed' completed "$(queue_item_get "$QUEUE_PATH" "$QUEUE_LOW_ID" status)"
assert_eq 'queue run: canceled preserved' canceled "$(queue_item_get "$QUEUE_PATH" "$QUEUE_CANCEL_ID" status)"
env LOOM_SUPERVISOR_QUEUE="$QUEUE_PATH" node "$SUPERVISOR" --queue-status >"$QUEUE_STATUS_OUT"
assert_contains 'queue status: prints queue' "queue: $QUEUE_PATH" "$QUEUE_STATUS_OUT"

STALE_QUEUE_DIR="${TMP_DIR}/queue_stale_live_supervisor"
mkdir -p "$STALE_QUEUE_DIR"
STALE_QUEUE_PATH="${STALE_QUEUE_DIR}/queue.json"
STALE_QUEUE_DAG="${STALE_QUEUE_DIR}/dag.json"
STALE_QUEUE_STATUS="${STALE_QUEUE_DIR}/status.txt"
write_smoke_dag "$STALE_QUEUE_DAG"
node -e '
  const fs = require("fs");
  const [queuePath, dagPath, supervisorPid] = process.argv.slice(1);
  fs.writeFileSync(queuePath, JSON.stringify({
    schemaVersion: 1,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    items: [{
      id: "stale-worker-live-supervisor",
      dagPath,
      args: [],
      priority: 0,
      status: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      workerPid: 999999,
      supervisorPid: Number(supervisorPid),
      attempts: 1
    }]
  }, null, 2) + "\n");
' "$STALE_QUEUE_PATH" "$STALE_QUEUE_DAG" "$$"
env LOOM_SUPERVISOR_QUEUE="$STALE_QUEUE_PATH" node "$SUPERVISOR" --queue-status >"$STALE_QUEUE_STATUS"
assert_eq 'queue stale live supervisor: stays running' running "$(queue_item_get "$STALE_QUEUE_PATH" stale-worker-live-supervisor status)"
assert_contains 'queue stale live supervisor: status output' 'status=running' "$STALE_QUEUE_STATUS"

DUP_DIR="${TMP_DIR}/duplicate_refusal"
mkdir -p "$DUP_DIR"
DUP_DAG="${DUP_DIR}/dag.json"
DUP_CKPT="${DUP_DIR}/ckpt.json"
write_smoke_dag "$DUP_DAG"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ status: "running", supervisorPid: Number(process.argv[2]) }, null, 2) + "\n");
' "$DUP_CKPT" "$$"

set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  CODEX_BIN="$CODEX_STUB" \
  STUB_PLAN="$DETACH_PLAN" \
  STUB_INV="${DUP_DIR}/inv.log" \
  STUB_COUNT="${DUP_DIR}/count" \
  LOOM_SUPERVISOR_CHECKPOINT="$DUP_CKPT" \
  node "$SUPERVISOR" --allow-dirty-repo --detach "$DUP_DAG" --provider=codex >/dev/null 2>&1
DUP_RC=$?
set -e
assert_eq 'duplicate_refusal: exit' 4 "$DUP_RC"

printf 'loom-supervisor-smoke: all checks passed\n'
