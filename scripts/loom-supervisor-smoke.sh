#!/usr/bin/env bash
# loom-supervisor-smoke.sh - deterministic smoke tests for loom-supervisor.
#
# Uses a stubbed dag-executor binary. Makes no model or network calls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR="${SCRIPT_DIR}/loom-supervisor.cjs"

TMP_DIR="$(mktemp -d -t loom-supervisor-smoke-XXXXXX)"

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
    fs.writeFileSync(statePath, JSON.stringify({ status: "paused" }, null, 2) + "\n");
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
  local dir="${TMP_DIR}/${name}"
  mkdir -p "$dir"
  local dag="${dir}/dag.json"
  local plan="${dir}/plan.tsv"
  local inv="${dir}/inv.log"
  local count="${dir}/count"
  local ckpt="${dir}/ckpt.json"
  local logs="${dir}/logs"

  write_smoke_dag "$dag"
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
    node "$SUPERVISOR" --allow-dirty-repo "$dag" --provider=codex >/dev/null 2>&1
  local rc=$?
  set -e

  assert_eq "${name}: exit" "$expected_rc" "$rc"
  assert_contains "${name}: backlog flag" "--backlog" "$inv"
  CASE_DIR="$dir"
  CASE_CKPT="$ckpt"
  CASE_INV="$inv"
}

run_case completed 0 $'0'
assert_eq 'completed: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'completed: attempts' 1 "$(json_get "$CASE_CKPT" attempts)"

run_case crash_retry 0 $'1\n0'
assert_eq 'crash_retry: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'crash_retry: attempts' 2 "$(json_get "$CASE_CKPT" attempts)"
assert_contains 'crash_retry: resume flag' '--resume' "$CASE_INV"

run_case quota_retry 0 $'2\tQuota limit reached while running task-a\n0'
assert_eq 'quota_retry: status' completed "$(json_get "$CASE_CKPT" status)"
assert_eq 'quota_retry: attempts' 2 "$(json_get "$CASE_CKPT" attempts)"
assert_eq 'quota_retry: pauses' 1 "$(json_get "$CASE_CKPT" pauses)"
assert_contains 'quota_retry: resume flag' '--resume' "$CASE_INV"

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
