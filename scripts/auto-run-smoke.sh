#!/usr/bin/env bash
# auto-run-smoke.sh — deterministic smoke harness for the auto-run supervisor.
#
# Drives .claude/scripts/auto-run-supervisor.sh over a fake checkpoint
# progression using stubbed `claude -p` and dag-executor binaries (wired via the
# supervisor's CLAUDE_BIN / DAG_EXECUTOR_BIN env seam). Makes no live model or
# network calls.
#
# Asserts (each failure -> non-zero exit):
#   1. atomic temp+rename writes (no leftover .tmp- files; untouched fields
#      survive merges).
#   2. chat-only-decision field ownership (chat write of `decision` and the
#      needs-decision -> running status flip do not clobber supervisor fields).
#   3. gate park -> decision -> resume across iterations.
#   4. no-progress guard halts after NO_PROGRESS_LIMIT iterations and invokes
#      /handoff.
#   5. per-phase --model flag plumbed from models[phase] map for both claude
#      and dag phases.
#   6. implement phase runs as a CLI process to a logfile, with exit-code
#      routing (0 advance, 1 halt, 2 park-with-retry-bump+--resume on next).
#   7. resume-after-kill: kill the supervisor mid-stub, relaunch over the same
#      checkpoint, confirm the first stub invocation reads the RECORDED phase
#      (not the initial / phase 1).
#   8. one fresh CLAUDE_BIN spawn per claude-phase (distinct PIDs per
#      invocation) — mechanism proxy for distinct chat session IDs.

set -euo pipefail

# Supervisor + helper live next to this script (the dag-executor plugin scripts/ directory),
# NOT in the repo under test — resolve relative to the script's own location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPERVISOR="${SCRIPT_DIR}/auto-run-supervisor.sh"
HELPER="${SCRIPT_DIR}/auto-run-checkpoint.cjs"

if [[ ! -f "$SUPERVISOR" ]]; then
  printf 'supervisor script not found: %s\n' "$SUPERVISOR" >&2
  exit 1
fi
if [[ ! -f "$HELPER" ]]; then
  printf 'checkpoint helper not found: %s\n' "$HELPER" >&2
  exit 1
fi

SMOKE_TMP="$(mktemp -d -t auto-run-smoke-XXXXXX)"
SMOKE_KILL_LIST=""

kill_tree() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && return 0
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  if [[ -n "$SMOKE_KILL_LIST" ]]; then
    local pid
    for pid in $SMOKE_KILL_LIST; do
      kill_tree "$pid" || true
    done
  fi
  if [[ -z "${SMOKE_KEEP_TMP:-}" ]]; then
    rm -rf "$SMOKE_TMP"
  else
    printf 'auto-run-smoke: keeping tmp dir (SMOKE_KEEP_TMP set): %s\n' "$SMOKE_TMP" >&2
  fi
}
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  PASS  %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '  FAIL  %s\n' "$1" >&2
  if [[ -n "${2:-}" ]]; then
    printf '        %s\n' "$2" >&2
  fi
}

assert_eq() {
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    fail "$1" "expected=<$2> actual=<$3>"
  fi
}

assert_contains() {
  if printf '%s' "$3" | grep -qF -- "$2"; then
    pass "$1"
  else
    fail "$1" "needle=<$2> not in haystack"
  fi
}

assert_not_contains() {
  if ! printf '%s' "$3" | grep -qF -- "$2"; then
    pass "$1"
  else
    fail "$1" "needle=<$2> unexpectedly present"
  fi
}

assert_no_glob() {
  local matches
  matches=$(compgen -G "$2" 2>/dev/null || true)
  if [[ -z "$matches" ]]; then
    pass "$1"
  else
    fail "$1" "unexpected files: $matches"
  fi
}

section() {
  printf '\n== %s ==\n' "$1"
}

write_stub() {
  cat >"$1" <<'STUB'
#!/usr/bin/env bash
set -u

case "$(basename "$0")" in
  claude-stub*) KIND=claude ;;
  dag-stub*)    KIND=dag ;;
  *)            KIND=unknown ;;
esac

INV_LOG="${STUB_INV_LOG:?STUB_INV_LOG required}"
PLAN="${STUB_PLAN_FILE:-}"
CKPT="${STUB_CKPT:?STUB_CKPT required}"
HELPER="${STUB_HELPER:?STUB_HELPER required}"

CUR_PHASE="$(node "$HELPER" get "$CKPT" phase 2>/dev/null || true)"
CUR_STATUS="$(node "$HELPER" get "$CKPT" status 2>/dev/null || true)"

ARG_LINE=""
for a in "$@"; do
  ARG_LINE+=" $(printf '%q' "$a")"
done

printf '%s\t%s\t%s\t%s\t%s\n' "$KIND" "$CUR_PHASE" "$CUR_STATUS" "$$" "${ARG_LINE# }" >>"$INV_LOG"

COUNT="$(awk -F'\t' -v k="$KIND" '$1==k{c++} END{print c+0}' "$INV_LOG")"

if [[ -n "${STUB_SLEEP_BEFORE_MUTATE:-}" ]]; then
  sleep "$STUB_SLEEP_BEFORE_MUTATE"
fi

EXIT_CODE=0
MERGE_JSON=""
if [[ -n "$PLAN" && -f "$PLAN" ]]; then
  LINE="$(awk -F'\t' -v k="$KIND" -v n="$COUNT" '$1==k{c++; if(c==n){print; exit}}' "$PLAN")"
  if [[ -n "$LINE" ]]; then
    EXIT_CODE="$(printf '%s' "$LINE" | awk -F'\t' '{print $2}')"
    MERGE_JSON="$(printf '%s' "$LINE" | awk -F'\t' '{print $3}')"
  fi
fi

if [[ -n "$MERGE_JSON" ]]; then
  node "$HELPER" merge "$CKPT" "$MERGE_JSON" >/dev/null 2>&1 || true
fi

exit "${EXIT_CODE:-0}"
STUB
  chmod +x "$1"
}

CLAUDE_STUB="${SMOKE_TMP}/claude-stub.sh"
DAG_STUB="${SMOKE_TMP}/dag-stub.sh"
write_stub "$CLAUDE_STUB"
write_stub "$DAG_STUB"

run_supervisor() {
  local ckpt="$1" inv_log="$2" plan="$3"
  shift 3
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    CLAUDE_BIN="$CLAUDE_STUB" \
    DAG_EXECUTOR_BIN="$DAG_STUB" \
    STUB_INV_LOG="$inv_log" \
    STUB_PLAN_FILE="$plan" \
    STUB_CKPT="$ckpt" \
    STUB_HELPER="$HELPER" \
    AUTO_RUN_MAX_ITER="${AUTO_RUN_MAX_ITER:-12}" \
    AUTO_RUN_MAX_WALLCLOCK_SEC="${AUTO_RUN_MAX_WALLCLOCK_SEC:-120}" \
    AUTO_RUN_PARK_POLL_SEC="${AUTO_RUN_PARK_POLL_SEC:-1}" \
    AUTO_RUN_PARK_MAX_SEC="${AUTO_RUN_PARK_MAX_SEC:-60}" \
    AUTO_RUN_NO_PROGRESS_LIMIT="${AUTO_RUN_NO_PROGRESS_LIMIT:-2}" \
    bash "$SUPERVISOR" "$ckpt"
}

scenario_happy_path() {
  section 'scenario 1: happy path (atomic, ownership, park/resume, models, implement-CLI, fresh-spawns)'

  local dir="${SMOKE_TMP}/happy"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-happy",
    "phase":"validate-plan",
    "status":"running",
    "models":{"validate-plan":"opus","mode-selection":"sonnet","mode-selected":"sonnet","reviewing":"haiku","default":"sonnet"},
    "dagPath":"plans/fake-dag.json"
  }' >/dev/null

  # Real phase chain: validate-plan (claude) -> mode-selection (claude, writes
  # mode-selected) -> mode-selected (dag; the SUPERVISOR auto-advances to
  # reviewing on exit 0, so the dag stub does NOT write phase) -> reviewing
  # (claude, parks at a gate) -> reviewing (claude, resume, done).
  {
    printf 'claude\t0\t%s\n' '{"phase":"mode-selection"}'
    printf 'claude\t0\t%s\n' '{"phase":"mode-selected"}'
    printf 'dag\t0\t\n'
    printf 'claude\t2\t%s\n' '{"status":"needs-decision","pendingGate":"warnings-gate"}'
    printf 'claude\t0\t%s\n' '{"status":"done"}'
  } >"$plan"

  (
    i=0
    while (( i < 60 )); do
      s="$(node "$HELPER" get "$ckpt" status 2>/dev/null || true)"
      if [[ "$s" == "needs-decision" ]]; then
        pb="$(node "$HELPER" get "$ckpt" phase)"
        rb="$(node "$HELPER" get "$ckpt" runId)"
        node "$HELPER" set "$ckpt" decision continue >/dev/null
        pa="$(node "$HELPER" get "$ckpt" phase)"
        ra="$(node "$HELPER" get "$ckpt" runId)"
        printf '%s|%s|%s|%s\n' "$pb" "$pa" "$rb" "$ra" >"${dir}/ownership.txt"
        node "$HELPER" set "$ckpt" status running >/dev/null
        exit 0
      fi
      sleep 0.2
      i=$((i + 1))
    done
    exit 1
  ) &
  local unparker_pid=$!
  SMOKE_KILL_LIST="$SMOKE_KILL_LIST $unparker_pid"

  local sup_log="${dir}/sup.log"
  set +e
  run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  wait "$unparker_pid" 2>/dev/null || true

  assert_eq 'supervisor exit code 0 on happy path' 0 "$sup_rc"

  assert_no_glob 'no leftover .tmp- files (atomic rename)' "${dir}/.ckpt.json.tmp-*"

  local last_updated
  last_updated="$(node "$HELPER" get "$ckpt" lastUpdated)"
  if [[ -n "$last_updated" ]]; then
    pass 'lastUpdated stamped by helper'
  else
    fail 'lastUpdated stamped by helper' 'value empty'
  fi

  if [[ -f "${dir}/ownership.txt" ]]; then
    IFS='|' read -r pb pa rb ra <"${dir}/ownership.txt"
    assert_eq 'chat decision write does not clobber phase' "$pb" "$pa"
    assert_eq 'chat decision write does not clobber runId' "$rb" "$ra"
  else
    fail 'field ownership snapshot captured' 'unparker did not observe needs-decision'
  fi
  local decision
  decision="$(node "$HELPER" get "$ckpt" decision)"
  assert_eq 'chat decision persisted on disk' 'continue' "$decision"

  assert_contains 'supervisor logged park' 'parked: status=needs-decision' "$(cat "$sup_log")"
  assert_contains 'supervisor logged resume' 'decision received; resuming loop' "$(cat "$sup_log")"

  local row1 row2 row3 row4 row5
  row1="$(awk -F'\t' '$1=="claude"' "$inv" | sed -n '1p')"
  row2="$(awk -F'\t' '$1=="claude"' "$inv" | sed -n '2p')"
  row3="$(awk -F'\t' '$1=="dag"'    "$inv" | sed -n '1p')"
  row4="$(awk -F'\t' '$1=="claude"' "$inv" | sed -n '3p')"
  row5="$(awk -F'\t' '$1=="claude"' "$inv" | sed -n '4p')"

  assert_eq       'claude inv1 phase=validate-plan' 'validate-plan' "$(printf '%s' "$row1" | awk -F'\t' '{print $2}')"
  assert_contains 'claude inv1 args have --model opus' '--model opus' "$(printf '%s' "$row1" | awk -F'\t' '{print $5}')"

  assert_eq       'claude inv2 phase=mode-selection' 'mode-selection' "$(printf '%s' "$row2" | awk -F'\t' '{print $2}')"
  assert_contains 'claude inv2 args have --model sonnet' '--model sonnet' "$(printf '%s' "$row2" | awk -F'\t' '{print $5}')"

  assert_eq       'dag inv1 phase=mode-selected' 'mode-selected' "$(printf '%s' "$row3" | awk -F'\t' '{print $2}')"
  assert_contains 'dag inv1 args have --model=sonnet' '--model=sonnet' "$(printf '%s' "$row3" | awk -F'\t' '{print $5}')"

  assert_eq       'claude inv3 phase=reviewing (supervisor advanced after dag)' 'reviewing' "$(printf '%s' "$row4" | awk -F'\t' '{print $2}')"
  assert_contains 'claude inv3 args have --model haiku' '--model haiku' "$(printf '%s' "$row4" | awk -F'\t' '{print $5}')"

  assert_eq       'claude inv4 phase=reviewing (post-resume)' 'reviewing' "$(printf '%s' "$row5" | awk -F'\t' '{print $2}')"

  local claude_count distinct_pids
  claude_count="$(awk -F'\t' '$1=="claude"' "$inv" | wc -l | tr -d ' ')"
  distinct_pids="$(awk -F'\t' '$1=="claude"{print $4}' "$inv" | sort -u | wc -l | tr -d ' ')"
  assert_eq 'four claude-phase invocations' 4 "$claude_count"
  assert_eq 'each claude invocation is a fresh spawn (distinct PIDs)' 4 "$distinct_pids"

  local impl_log_count
  impl_log_count="$(grep -c 'implement: ' "$sup_log" || true)"
  assert_eq 'supervisor logged exactly one implement dispatch' 1 "$impl_log_count"
  if grep -Eq 'auto-run-logs/auto-run-.*-iter[0-9]+-mode-selected\.log' "$sup_log"; then
    pass 'implement phase logged to per-iteration logfile path'
  else
    fail 'implement phase logged to per-iteration logfile path' 'no matching log line in sup log'
  fi
}

scenario_no_progress() {
  section 'scenario 2: no-progress guard halts and writes /handoff'

  local dir="${SMOKE_TMP}/noprogress"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-noprogress",
    "phase":"validate-plan",
    "status":"running",
    "models":{"default":"sonnet"}
  }' >/dev/null

  {
    printf 'claude\t0\t\n'
    printf 'claude\t0\t\n'
    printf 'claude\t0\t\n'
    printf 'claude\t0\t\n'
  } >"$plan"

  local sup_log="${dir}/sup.log"
  set +e
  AUTO_RUN_MAX_ITER=8 AUTO_RUN_NO_PROGRESS_LIMIT=2 \
    run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  assert_eq 'supervisor exit 3 on no-progress halt' 3 "$sup_rc"
  assert_contains 'no-progress log line emitted' 'no-progress:' "$(cat "$sup_log")"
  assert_contains 'HALT message includes no-progress' 'HALT: no-progress' "$(cat "$sup_log")"

  local handoff_args
  handoff_args="$(awk -F'\t' '$1=="claude"{print $5}' "$inv" | grep -F '/handoff' || true)"
  if [[ -n "$handoff_args" ]]; then
    pass '/handoff dispatched via CLAUDE_BIN after halt'
  else
    fail '/handoff dispatched via CLAUDE_BIN after halt' 'no claude invocation contained /handoff'
  fi

  assert_eq 'checkpoint status=error after halt' 'error' "$(node "$HELPER" get "$ckpt" status)"
}

scenario_implement_exit_1() {
  section 'scenario 3: implement (dag) exit 1 routes to /handoff'

  local dir="${SMOKE_TMP}/dag-exit1"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-dag-exit1",
    "phase":"mode-selected",
    "status":"running",
    "models":{"mode-selected":"sonnet"},
    "dagPath":"plans/fake-dag.json"
  }' >/dev/null

  printf 'dag\t1\t\n' >"$plan"

  local sup_log="${dir}/sup.log"
  set +e
  run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  assert_eq 'supervisor exit 3 on dag exit=1' 3 "$sup_rc"
  assert_contains 'HALT msg references phase exit=1' 'phase mode-selected exit=1' "$(cat "$sup_log")"
  assert_eq 'checkpoint status=error after dag exit=1' 'error' "$(node "$HELPER" get "$ckpt" status)"
}

scenario_implement_exit_2() {
  section 'scenario 4: implement (dag) exit 2 parks, bumps retryCount, adds --resume next'

  local dir="${SMOKE_TMP}/dag-exit2"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-dag-exit2",
    "phase":"mode-selected",
    "status":"running",
    "models":{"mode-selected":"sonnet","reviewing":"sonnet"},
    "dagPath":"plans/fake-dag.json",
    "retryCount":0
  }' >/dev/null

  # dag exit 2 (park + retry bump), then dag exit 0 (the SUPERVISOR advances
  # mode-selected -> reviewing on exit 0 — the dag stub writes no phase), then
  # claude at reviewing exits done.
  {
    printf 'dag\t2\t\n'
    printf 'dag\t0\t\n'
    printf 'claude\t0\t%s\n' '{"status":"done"}'
  } >"$plan"

  (
    i=0
    while (( i < 60 )); do
      s="$(node "$HELPER" get "$ckpt" status 2>/dev/null || true)"
      if [[ "$s" == "needs-decision" ]]; then
        node "$HELPER" set "$ckpt" status running >/dev/null
        exit 0
      fi
      sleep 0.2
      i=$((i + 1))
    done
    exit 1
  ) &
  local unparker_pid=$!
  SMOKE_KILL_LIST="$SMOKE_KILL_LIST $unparker_pid"

  local sup_log="${dir}/sup.log"
  set +e
  run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  wait "$unparker_pid" 2>/dev/null || true

  assert_eq 'supervisor exit 0 after dag retry succeeds' 0 "$sup_rc"

  local dag1_args dag2_args
  dag1_args="$(awk -F'\t' '$1=="dag"' "$inv" | sed -n '1p' | awk -F'\t' '{print $5}')"
  dag2_args="$(awk -F'\t' '$1=="dag"' "$inv" | sed -n '2p' | awk -F'\t' '{print $5}')"
  assert_not_contains 'first dag invocation has no --resume' '--resume' "$dag1_args"
  assert_contains    'second dag invocation includes --resume' '--resume' "$dag2_args"
}

scenario_resume_after_kill() {
  section 'scenario 5: resume-after-kill dispatches at RECORDED phase'

  local dir="${SMOKE_TMP}/kill"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv_first="${dir}/inv1.log"
  local inv_second="${dir}/inv2.log"
  local plan_first="${dir}/plan1.tsv"
  local plan_second="${dir}/plan2.tsv"
  : >"$inv_first"
  : >"$inv_second"

  # Mid-progression: phase=reviewing, NOT phase 1 (would be validate-plan).
  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-kill",
    "phase":"reviewing",
    "status":"running",
    "models":{"reviewing":"haiku"}
  }' >/dev/null

  printf 'claude\t0\t%s\n' '{"status":"done"}' >"$plan_first"

  env -i \
    PATH="$PATH" HOME="$HOME" \
    CLAUDE_BIN="$CLAUDE_STUB" \
    DAG_EXECUTOR_BIN="$DAG_STUB" \
    STUB_INV_LOG="$inv_first" \
    STUB_PLAN_FILE="$plan_first" \
    STUB_CKPT="$ckpt" \
    STUB_HELPER="$HELPER" \
    STUB_SLEEP_BEFORE_MUTATE=30 \
    AUTO_RUN_MAX_ITER=4 \
    AUTO_RUN_MAX_WALLCLOCK_SEC=120 \
    AUTO_RUN_PARK_POLL_SEC=1 \
    AUTO_RUN_PARK_MAX_SEC=10 \
    bash "$SUPERVISOR" "$ckpt" >"${dir}/sup1.log" 2>&1 &
  local sup_pid=$!
  SMOKE_KILL_LIST="$SMOKE_KILL_LIST $sup_pid"

  local waited=0
  while [[ ! -s "$inv_first" && $waited -lt 100 ]]; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if [[ ! -s "$inv_first" ]]; then
    fail 'first-run stub recorded an invocation before kill' 'inv1.log stayed empty'
    kill_tree "$sup_pid"
    return
  fi

  kill_tree "$sup_pid"
  wait "$sup_pid" 2>/dev/null || true

  local first_phase
  first_phase="$(awk -F'\t' '$1=="claude"' "$inv_first" | sed -n '1p' | awk -F'\t' '{print $2}')"
  assert_eq 'pre-kill: stub saw phase=reviewing on disk' 'reviewing' "$first_phase"

  local ckpt_phase_after_kill ckpt_status_after_kill
  ckpt_phase_after_kill="$(node "$HELPER" get "$ckpt" phase)"
  ckpt_status_after_kill="$(node "$HELPER" get "$ckpt" status)"
  assert_eq 'post-kill: ckpt phase still reviewing (mutation did not land)' 'reviewing' "$ckpt_phase_after_kill"
  assert_eq 'post-kill: ckpt status still running (mutation did not land)' 'running'   "$ckpt_status_after_kill"

  printf 'claude\t0\t%s\n' '{"status":"done"}' >"$plan_second"

  set +e
  env -i \
    PATH="$PATH" HOME="$HOME" \
    CLAUDE_BIN="$CLAUDE_STUB" \
    DAG_EXECUTOR_BIN="$DAG_STUB" \
    STUB_INV_LOG="$inv_second" \
    STUB_PLAN_FILE="$plan_second" \
    STUB_CKPT="$ckpt" \
    STUB_HELPER="$HELPER" \
    AUTO_RUN_MAX_ITER=4 \
    AUTO_RUN_MAX_WALLCLOCK_SEC=60 \
    AUTO_RUN_PARK_POLL_SEC=1 \
    AUTO_RUN_PARK_MAX_SEC=10 \
    bash "$SUPERVISOR" "$ckpt" >"${dir}/sup2.log" 2>&1
  local sup2_rc=$?
  set -e

  assert_eq 'relaunch supervisor exits cleanly' 0 "$sup2_rc"

  local resume_phase
  resume_phase="$(awk -F'\t' '$1=="claude"' "$inv_second" | sed -n '1p' | awk -F'\t' '{print $2}')"
  assert_eq 'resume-after-kill: dispatch at RECORDED phase (not phase 1)' 'reviewing' "$resume_phase"
}

scenario_real_chain() {
  section 'scenario 6: full real phase chain (dag fires once at mode-selected; claude at every other phase)'

  # Drives the supervisor over the REAL phase vocabulary from auto-step.md's
  # dispatch table (single source of truth) end to end:
  #   validate-plan -> mode-selection -> mode-selected -> reviewing ->
  #   figma-verified -> cleaned -> simplified -> evaluate-review -> done
  # Each claude phase writes the NEXT phase; the dag (implement) phase writes
  # nothing — the SUPERVISOR advances mode-selected -> reviewing on dag exit 0.
  # This is the assertion that catches C1-class Phase 2 -> Phase 3 vocab drift:
  # if the supervisor stops triggering dag on `mode-selected`, the dag stub
  # fires 0 times (or claude gets spawned at mode-selected) and these fail.

  local dir="${SMOKE_TMP}/realchain"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-realchain",
    "phase":"validate-plan",
    "status":"running",
    "runMode":"autonomous",
    "mode":null,
    "models":{
      "validate-plan":"opus",
      "mode-selection":"sonnet",
      "mode-selected":"sonnet",
      "reviewing":"sonnet",
      "figma-verified":"sonnet",
      "cleaned":"sonnet",
      "simplified":"opus",
      "evaluate-review":"opus",
      "default":"sonnet"
    },
    "dagPath":"plans/fake-dag.json"
  }' >/dev/null

  {
    printf 'claude\t0\t%s\n' '{"phase":"mode-selection"}'
    printf 'claude\t0\t%s\n' '{"phase":"mode-selected"}'
    printf 'dag\t0\t\n'
    printf 'claude\t0\t%s\n' '{"phase":"figma-verified"}'
    printf 'claude\t0\t%s\n' '{"phase":"cleaned"}'
    printf 'claude\t0\t%s\n' '{"phase":"simplified"}'
    printf 'claude\t0\t%s\n' '{"phase":"evaluate-review"}'
    printf 'claude\t0\t%s\n' '{"phase":"done","status":"done"}'
  } >"$plan"

  local sup_log="${dir}/sup.log"
  set +e
  run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  assert_eq 'real-chain supervisor exit code 0' 0 "$sup_rc"
  assert_eq 'real-chain reaches done' 'done' "$(node "$HELPER" get "$ckpt" phase)"

  # (a) dag stub fires EXACTLY ONCE, and exactly at the mode-selected step.
  local dag_count dag_phase
  dag_count="$(awk -F'\t' '$1=="dag"' "$inv" | wc -l | tr -d ' ')"
  dag_phase="$(awk -F'\t' '$1=="dag"' "$inv" | sed -n '1p' | awk -F'\t' '{print $2}')"
  assert_eq 'dag stub fires exactly once across the whole chain' 1 "$dag_count"
  assert_eq 'the single dag invocation is at phase=mode-selected' 'mode-selected' "$dag_phase"

  # No claude spawn ever happens at mode-selected (it is supervisor-CLI only).
  local claude_at_modeselected
  claude_at_modeselected="$(awk -F'\t' '$1=="claude" && $2=="mode-selected"' "$inv" | wc -l | tr -d ' ')"
  assert_eq 'no claude spawn at mode-selected (supervisor-CLI only)' 0 "$claude_at_modeselected"

  # (b) claude stub fires at every other non-terminal phase, in order.
  local claude_phases expected_phases
  claude_phases="$(awk -F'\t' '$1=="claude"{print $2}' "$inv" | tr '\n' ',')"
  expected_phases="validate-plan,mode-selection,reviewing,figma-verified,cleaned,simplified,evaluate-review,"
  assert_eq 'claude fires at every non-implement phase, in dispatch-table order' "$expected_phases" "$claude_phases"
}

scenario_sequential_not_supported() {
  section 'scenario 7: sequential outcome (dagPath null at mode-selected) parks at sequential-not-supported gate'

  # Seeds the post-Phase-2 SEQUENTIAL outcome: mode=sequential, dagPath=null,
  # phase=mode-selected, status=running. This is the now-reachable path that
  # previously hard-halted via handoff_and_exit. The supervisor must instead
  # fail-closed into a needs-decision PARK at the sequential-not-supported gate:
  #   - it must NOT invoke the dag-executor (nothing to run on a null dagPath),
  #   - it must NOT handoff_and_exit (no /handoff dispatch, no exit 3),
  #   - it must write status=needs-decision + pendingGate=sequential-not-supported.
  # An operator resolves the park by aborting (here), and the supervisor exits 0.

  local dir="${SMOKE_TMP}/seqpark"
  mkdir -p "$dir"
  local ckpt="${dir}/ckpt.json"
  local inv="${dir}/inv.log"
  local plan="${dir}/plan.tsv"
  : >"$inv"
  : >"$plan"

  node "$HELPER" init "$ckpt" '{
    "runId":"smoke-seqpark",
    "phase":"mode-selected",
    "status":"running",
    "runMode":"autonomous",
    "mode":"sequential",
    "dagPath":null,
    "retryCount":0,
    "models":{"mode-selected":"sonnet","default":"sonnet"}
  }' >/dev/null

  # Operator side: on seeing needs-decision, capture the gate, then abort.
  (
    i=0
    while (( i < 60 )); do
      s="$(node "$HELPER" get "$ckpt" status 2>/dev/null || true)"
      if [[ "$s" == "needs-decision" ]]; then
        g="$(node "$HELPER" get "$ckpt" pendingGate)"
        printf '%s|%s\n' "$s" "$g" >"${dir}/gate.txt"
        node "$HELPER" merge "$ckpt" '{"status":"aborted"}' >/dev/null
        exit 0
      fi
      sleep 0.2
      i=$((i + 1))
    done
    exit 1
  ) &
  local unparker_pid=$!
  SMOKE_KILL_LIST="$SMOKE_KILL_LIST $unparker_pid"

  local sup_log="${dir}/sup.log"
  set +e
  run_supervisor "$ckpt" "$inv" "$plan" >"$sup_log" 2>&1
  local sup_rc=$?
  set -e

  wait "$unparker_pid" 2>/dev/null || true

  # Supervisor exits 0 (clean abort from park), NOT 3 (handoff_and_exit halt).
  assert_eq 'supervisor exit 0 (parked then aborted, no halt)' 0 "$sup_rc"

  # Gate captured by the operator side: needs-decision + sequential-not-supported.
  if [[ -f "${dir}/gate.txt" ]]; then
    IFS='|' read -r seen_status seen_gate <"${dir}/gate.txt"
    assert_eq 'parked with status=needs-decision' 'needs-decision' "$seen_status"
    assert_eq 'parked with pendingGate=sequential-not-supported' 'sequential-not-supported' "$seen_gate"
  else
    fail 'sequential park gate captured' 'operator never observed needs-decision'
  fi

  # dag-executor was NEVER invoked (null dagPath — nothing to run).
  local dag_count
  dag_count="$(awk -F'\t' '$1=="dag"' "$inv" | wc -l | tr -d ' ')"
  assert_eq 'dag stub never invoked on sequential path' 0 "$dag_count"
  assert_not_contains 'supervisor logged no implement dispatch' 'implement: ' "$(cat "$sup_log")"

  # No handoff_and_exit: no HALT line, no /handoff dispatch.
  assert_not_contains 'no HALT (did not handoff_and_exit)' 'HALT:' "$(cat "$sup_log")"
  local handoff_args
  handoff_args="$(awk -F'\t' '$1=="claude"{print $5}' "$inv" | grep -F '/handoff' || true)"
  assert_eq 'no /handoff dispatched' '' "$handoff_args"

  # retryCount NOT bumped (fail-closed park is not a retryable dag pause).
  assert_eq 'retryCount not bumped on sequential park' '0' "$(node "$HELPER" get "$ckpt" retryCount)"
}

main() {
  printf 'auto-run-smoke: harness=%s\n' "$0"
  printf 'auto-run-smoke: supervisor=%s\n' "$SUPERVISOR"
  printf 'auto-run-smoke: tmp=%s\n' "$SMOKE_TMP"

  scenario_happy_path
  scenario_no_progress
  scenario_implement_exit_1
  scenario_implement_exit_2
  scenario_resume_after_kill
  scenario_real_chain
  scenario_sequential_not_supported

  printf '\n== summary ==\n'
  printf '  passed: %d\n' "$PASS_COUNT"
  printf '  failed: %d\n' "$FAIL_COUNT"

  if [[ "$FAIL_COUNT" -ne 0 ]]; then
    return 1
  fi
  return 0
}

main "$@"
