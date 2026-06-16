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
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({ status: "paused", reason: process.argv[2] }, null, 2) + "\n");
  ' "$state" "$reason"
fi

exit "$code"
STUB
chmod +x "$STUB"

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

  printf '{}\n' >"$dag"
  printf '%s\n' "$plan_body" >"$plan"
  : >"$inv"

  set +e
  env \
    DAG_EXECUTOR_BIN="$STUB" \
    STUB_PLAN="$plan" \
    STUB_INV="$inv" \
    STUB_COUNT="$count" \
    LOOM_SUPERVISOR_CHECKPOINT="$ckpt" \
    LOOM_SUPERVISOR_LOG_DIR="$logs" \
    LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
    LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
    LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
    node "$SUPERVISOR" "$dag" --provider=codex >/dev/null 2>&1
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

DETACH_DIR="${TMP_DIR}/detach_completed"
mkdir -p "$DETACH_DIR"
DETACH_DAG="${DETACH_DIR}/dag.json"
DETACH_PLAN="${DETACH_DIR}/plan.tsv"
DETACH_INV="${DETACH_DIR}/inv.log"
DETACH_COUNT="${DETACH_DIR}/count"
DETACH_CKPT="${DETACH_DIR}/ckpt.json"
DETACH_LOG_DIR="${DETACH_DIR}/logs"
DETACH_SUPERVISOR_LOG="${DETACH_DIR}/supervisor.log"
printf '{}\n' >"$DETACH_DAG"
printf '0\n' >"$DETACH_PLAN"
: >"$DETACH_INV"

env \
  DAG_EXECUTOR_BIN="$STUB" \
  STUB_PLAN="$DETACH_PLAN" \
  STUB_INV="$DETACH_INV" \
  STUB_COUNT="$DETACH_COUNT" \
  LOOM_SUPERVISOR_CHECKPOINT="$DETACH_CKPT" \
  LOOM_SUPERVISOR_LOG_DIR="$DETACH_LOG_DIR" \
  LOOM_SUPERVISOR_DETACH_LOG="$DETACH_SUPERVISOR_LOG" \
  LOOM_SUPERVISOR_CRASH_DELAY_SEC=0 \
  LOOM_SUPERVISOR_QUOTA_DELAY_SEC=0 \
  LOOM_SUPERVISOR_MAX_ATTEMPTS=5 \
  node "$SUPERVISOR" --detach "$DETACH_DAG" --provider=codex >/dev/null 2>&1
wait_json_value "$DETACH_CKPT" status completed
assert_file_exists 'detach_completed: supervisor log' "$DETACH_SUPERVISOR_LOG"
assert_contains 'detach_completed: backlog flag' '--backlog' "$DETACH_INV"
assert_eq 'detach_completed: attempts' 1 "$(json_get "$DETACH_CKPT" attempts)"

DUP_DIR="${TMP_DIR}/duplicate_refusal"
mkdir -p "$DUP_DIR"
DUP_DAG="${DUP_DIR}/dag.json"
DUP_CKPT="${DUP_DIR}/ckpt.json"
printf '{}\n' >"$DUP_DAG"
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ status: "running", supervisorPid: Number(process.argv[2]) }, null, 2) + "\n");
' "$DUP_CKPT" "$$"

set +e
env \
  DAG_EXECUTOR_BIN="$STUB" \
  STUB_PLAN="$DETACH_PLAN" \
  STUB_INV="${DUP_DIR}/inv.log" \
  STUB_COUNT="${DUP_DIR}/count" \
  LOOM_SUPERVISOR_CHECKPOINT="$DUP_CKPT" \
  node "$SUPERVISOR" --detach "$DUP_DAG" --provider=codex >/dev/null 2>&1
DUP_RC=$?
set -e
assert_eq 'duplicate_refusal: exit' 4 "$DUP_RC"

printf 'loom-supervisor-smoke: all checks passed\n'
