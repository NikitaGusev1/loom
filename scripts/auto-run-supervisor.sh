#!/usr/bin/env bash
# auto-run-supervisor.sh — background loop driving the /auto-step pipeline.
#
# Per iteration:
#   1. Read checkpoint (status, phase, models, dagPath, retryCount) via the helper.
#   2. Terminal status (done|aborted) -> exit. status=error -> structured halt.
#      status=needs-decision -> park (poll, do NOT relaunch) until chat flips
#      it back to running.
#   3. Pick `models[phase]` from the checkpoint (default: account-default).
#   4. Run the phase in a fresh process:
#        - phase=mode-selected -> dag-executor CLI to a logfile (zero
#          supervisor context spent on agent output).
#        - any other phase            -> `codex exec "$loom:auto-step --resume-run
#          <ckpt>"` (fresh Codex session, full skills/project instructions
#          cold-start every iteration; phase boundary IS the refresh).
#   5. Infer the phase result from the checkpoint. `codex exec` reports whether
#      the agent session itself completed, not the auto-step's logical 0/1/2.
#   6. Safety guards: max iterations, max wall-clock, and a no-progress check
#      (phase unchanged AND checkpoint content unchanged across an iteration ->
#      halt instead of relaunching forever).
#
# Binary seam: CODEX_BIN and DAG_EXECUTOR_BIN are env-overridable so the
# smoke harness (task-smoke) can stub them to drive the loop deterministically.

set -euo pipefail

# --------------------------------------------------------------------------
# Config (override via env)
# --------------------------------------------------------------------------

CODEX_BIN="${CODEX_BIN:-codex}"
# Headless `codex exec` has no human to answer permission prompts, so every chat
# phase runs with approvals and the inner sandbox bypassed — otherwise tool
# calls (dag-checkpoint, Edit, Bash, the dag-executor CLI, subagents) come back
# un-actioned, the phase exits 0 having mutated nothing, and the no-progress
# guard halts the run. This is required for BOTH human and autonomous modes: the
# human/autonomous split governs gate decisions, not per-tool approval — every
# phase is always a headless Codex session. Override to "" only in an externally
# sandboxed environment where
# the needed tools are pre-allowlisted.
CODEX_PERM_FLAGS="${AUTO_RUN_CODEX_PERM_FLAGS:---dangerously-bypass-approvals-and-sandbox --ephemeral}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ARTIFACTS_ROOT="${LOOM_ARTIFACTS_DIR:-$(dirname "$REPO_ROOT")/dag-executor-artifacts}"
# Headless phases rely on the repo-shipped helper. Make it directly
# discoverable so an agent never needs to search the user's home directory.
export PATH="${REPO_ROOT}/bin:${PATH}"
# DAG_EXECUTOR_CMD is an argv array (kept for parity with the env seam below).
# The DAG_EXECUTOR_BIN env seam keeps command-string semantics (intentional
# word-split) so task-smoke can stub it with a single path or a multi-word
# command alike. Default resolves the dag-executor binary from PATH (one-time
# setup: clone + npm link the Visma-Manager/dag-executor repo).
if [[ -n "${DAG_EXECUTOR_BIN:-}" ]]; then
  read -r -a DAG_EXECUTOR_CMD <<<"$DAG_EXECUTOR_BIN"
else
  DAG_EXECUTOR_CMD=(dag-executor)
fi

# Helper lives next to this script (the dag-executor plugin scripts/ directory), NOT in the
# target repo — resolve relative to the script's own location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CKPT_HELPER="${SCRIPT_DIR}/auto-run-checkpoint.cjs"

MAX_ITER="${AUTO_RUN_MAX_ITER:-40}"
MAX_WALLCLOCK_SEC="${AUTO_RUN_MAX_WALLCLOCK_SEC:-21600}"   # 6h default
PARK_POLL_SEC="${AUTO_RUN_PARK_POLL_SEC:-15}"
PARK_MAX_SEC="${AUTO_RUN_PARK_MAX_SEC:-86400}"             # 24h default
NO_PROGRESS_LIMIT="${AUTO_RUN_NO_PROGRESS_LIMIT:-2}"

# --------------------------------------------------------------------------
# Args
# --------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage: auto-run-supervisor.sh <checkpoint-path>

  checkpoint-path  Path (absolute or repo-relative) to the auto-run checkpoint
                   JSON, e.g. .claude/ai/auto-run-vmm-7218.json. The supervisor
                   does not initialize the checkpoint; init it first via
                   .claude/scripts/auto-run-checkpoint.cjs init <path> <json>.

Env overrides:
  CODEX_BIN                  default: codex
  DAG_EXECUTOR_BIN           default: dag-executor (resolved from PATH; npm link)
  AUTO_RUN_MAX_ITER          default: 40
  AUTO_RUN_MAX_WALLCLOCK_SEC default: 21600 (6h)
  AUTO_RUN_PARK_POLL_SEC     default: 15
  AUTO_RUN_PARK_MAX_SEC      default: 86400 (24h)
  AUTO_RUN_NO_PROGRESS_LIMIT default: 2
EOF
  exit 1
}

[[ $# -eq 1 ]] || usage
CKPT="$1"
case "$CKPT" in
  /*) ;;
  *)  CKPT="${REPO_ROOT}/${CKPT}" ;;
esac

if [[ ! -f "$CKPT" ]]; then
  printf '[supervisor] checkpoint not found: %s\n' "$CKPT" >&2
  exit 1
fi

LOG_DIR="${REPO_ROOT}/.claude/ai/auto-run-logs"
mkdir -p "$LOG_DIR"

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

log() {
  printf '[supervisor %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

ck_get() {
  # ck_get <field> -> stdout value (empty if missing). Never aborts the loop.
  node "$CKPT_HELPER" get "$CKPT" "$1" 2>/dev/null || true
}

ck_merge() {
  # ck_merge '<json-object>'
  node "$CKPT_HELPER" merge "$CKPT" "$1"
}

ckpt_fingerprint() {
  # Content fingerprint of the checkpoint minus the always-changing lastUpdated
  # stamp. Used for no-progress detection — byte size alone cannot see a
  # same-length value change (lastUpdated is a fixed-width ISO string, so a
  # real-work merge can leave the byte count identical).
  if [[ -f "$CKPT" ]]; then
    sed 's/"lastUpdated":"[^"]*"//' "$CKPT" | cksum | tr -d ' '
  else
    echo 0
  fi
}

model_for_phase() {
  # Resolve models[phase] from the checkpoint. Falls back to models.default,
  # then to the authenticated Codex account default.
  local phase="$1"
  node -e '
    const ck = require(process.argv[1]);
    const state = ck.read(process.argv[2]) || {};
    const models = state.models || {};
    const phase = process.argv[3];
    const m = models[phase] || models.default || "account-default";
    process.stdout.write(String(m));
  ' "$CKPT_HELPER" "$CKPT" "$phase"
}

reasoning_for_phase() {
  # Resolve reasoning[phase] from the checkpoint, then use the lowest default
  # appropriate to the phase's work. This is independent from model choice so
  # callers can tune cost without changing the selected Codex tier.
  local phase="$1"
  node -e '
    const ck = require(process.argv[1]);
    const state = ck.read(process.argv[2]) || {};
    const phase = process.argv[3];
    const configured = state.reasoning || {};
    const defaults = {
      "validate-plan": "high",
      "mode-selection": "low",
      "reviewing": "low",
      "figma-verified": "medium",
      "cleaned": "medium",
      "simplified": "high",
      "evaluate-review": "high",
      "fix-issues": "medium",
    };
    process.stdout.write(String(configured[phase] || configured.default || defaults[phase] || "medium"));
  ' "$CKPT_HELPER" "$CKPT" "$phase"
}

resolve_repo_path() {
  # Echo absolute path: passes absolute through, prefixes REPO_ROOT otherwise.
  local p="$1"
  case "$p" in
    /*) printf '%s' "$p" ;;
    *)  printf '%s/%s' "$REPO_ROOT" "$p" ;;
  esac
}

handoff_and_exit() {
  # Halt path: preserve the structured reason in the checkpoint. Do not launch
  # another model session merely to restate a supervisor failure.
  local reason="$1"
  log "HALT: ${reason}"
  ck_merge "{\"status\":\"error\",\"pendingGate\":\"supervisor-halt\",\"haltReason\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$reason")}" || true
  exit 3
}

park_on_decision() {
  # Poll the checkpoint until status leaves needs-decision. Chat session is
  # the only writer that may flip needs-decision -> running.
  local park_start
  park_start=$(date +%s)
  log "parked: status=needs-decision; polling every ${PARK_POLL_SEC}s"
  while :; do
    local status
    status=$(ck_get status)
    case "$status" in
      running)
        log "decision received; resuming loop"
        return 0
        ;;
      done)
        log "decision: done — exit"
        exit 0
        ;;
      aborted)
        log "decision: aborted — exit"
        exit 0
        ;;
      error)
        handoff_and_exit "checkpoint status flipped to error while parked"
        ;;
      needs-decision|"")
        : # keep polling
        ;;
      *)
        handoff_and_exit "unknown status while parked: ${status}"
        ;;
    esac
    local now elapsed
    now=$(date +%s)
    elapsed=$(( now - park_start ))
    if (( elapsed >= PARK_MAX_SEC )); then
      handoff_and_exit "park exceeded ${PARK_MAX_SEC}s without decision"
    fi
    sleep "$PARK_POLL_SEC"
  done
}

run_implement_phase() {
  # Phase 3: dag-executor CLI direct. ZERO supervisor Codex context spent.
  # Reads exit code only; the run-total cost line (the `Total` table row from
  # dagCostSummary — see references/auto-step-phase-implement.md in this plugin) is
  # grepped post-exit for the supervisor log.
  local model="$1"
  local logfile="$2"
  local dag_path retry_count extra=()
  dag_path=$(ck_get dagPath)
  if [[ -z "$dag_path" ]]; then
    # Sequential runs reach the implement phase with a null dagPath (the
    # dag-executor has nothing to run). The headless supervisor implements DAG
    # mode only — do NOT hard-halt. Park for an operator gate (Phase 2 should
    # already have fail-closed before reaching here; this is the defensive
    # backstop on a now-reachable path). The main loop's rc=2 handler routes
    # this into park_on_decision.
    log "implement phase reached with null dagPath — sequential not supported; parking at gate"
    ck_merge "{\"status\":\"needs-decision\",\"pendingGate\":\"sequential-not-supported\"}" || true
    return 2
  fi
  dag_path=$(resolve_repo_path "$dag_path")

  retry_count=$(ck_get retryCount)
  if [[ -n "$retry_count" && "$retry_count" != "0" ]]; then
    extra+=(--resume)
  fi

  log "implement: ${DAG_EXECUTOR_CMD[*]} ${dag_path} --provider=codex --model=${model} ${extra[*]:-} > ${logfile}"

  # Caller wraps this call in `set +e ... set -e`. Do NOT re-enable set -e here:
  # if we did, `return $rc` with non-zero rc would trigger the abort path before
  # the main loop ran exit-code routing.
  # bash 3.2 (macOS default) errors on "${empty_array[@]}" under set -u; guard
  # with the parameter-expansion idiom.
  local rc=0
  "${DAG_EXECUTOR_CMD[@]}" "$dag_path" --provider=codex --model="$model" ${extra[@]+"${extra[@]}"} >"$logfile" 2>&1 || rc=$?

  # Run-total cost: the `Total` table row from dagCostSummary (logger.ts:120)
  # — note: capital-T `Total`, NOT a `COST`-labeled line.
  if [[ -f "$logfile" ]]; then
    local cost_line
    # Anchor on a line whose first non-space token is the literal `Total` (the
    # dagCostSummary run-total row) so an agent log line merely containing the
    # substring "Total" can't win the tail -1. ANSI codes precede the text in
    # the bold table row, so strip them first.
    cost_line=$(sed 's/\x1b\[[0-9;]*m//g' "$logfile" | grep -E '^[[:space:]]*Total[[:space:]]' | tail -1 || true)
    if [[ -n "$cost_line" ]]; then
      log "implement run-total: ${cost_line}"
    fi
  fi

  return $rc
}

run_codex_phase() {
  # Non-implement phases run as fresh `codex exec` sessions. Codex's process
  # exit code only describes the agent session; infer the auto-step's logical
  # result from the checkpoint it atomically updates.
  local model="$1"
  local reasoning="$2"
  local logfile="$3"
  local phase_before status_after phase_after prompt model_args=() reasoning_args=()
  phase_before=$(ck_get phase)
  prompt="\$loom:auto-step --resume-run ${CKPT}. Use dag-checkpoint from PATH. Restrict filesystem discovery to ${REPO_ROOT} and ${ARTIFACTS_ROOT}; never scan the home directory or macOS protected folders."
  if [[ -n "$model" && "$model" != "account-default" && "$model" != "default" && "$model" != "codex" ]]; then
    model_args+=(--model "$model")
  fi
  if [[ -n "$reasoning" ]]; then
    reasoning_args+=(-c "model_reasoning_effort=\"${reasoning}\"")
  fi
  log "codex phase: ${CODEX_BIN} exec '${prompt}' ${model_args[*]:-} reasoning=${reasoning} ${CODEX_PERM_FLAGS} > ${logfile}"
  # Same set -e discipline as run_implement_phase — caller handles wrapping.
  local rc=0
  # shellcheck disable=SC2086
  $CODEX_BIN exec "$prompt" --cd "$REPO_ROOT" ${model_args[@]+"${model_args[@]}"} ${reasoning_args[@]+"${reasoning_args[@]}"} $CODEX_PERM_FLAGS >"$logfile" 2>&1 || rc=$?
  status_after=$(ck_get status)
  phase_after=$(ck_get phase)
  case "$status_after" in
    error) return 1 ;;
    needs-decision) return 2 ;;
    done|aborted) return 0 ;;
  esac
  if [[ "$phase_after" != "$phase_before" ]]; then return 0; fi
  if (( rc != 0 )); then
    log "codex phase process exited rc=${rc} without a checkpoint outcome"
    return 1
  fi
  log "codex phase returned without advancing checkpoint phase=${phase_before} status=${status_after:-<none>}"
  return 1
}

# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

start_ts=$(date +%s)
no_progress_streak=0

log "start ckpt=${CKPT} max_iter=${MAX_ITER} max_wallclock=${MAX_WALLCLOCK_SEC}s"

for (( iter=1; iter<=MAX_ITER; iter++ )); do
  now=$(date +%s)
  if (( now - start_ts >= MAX_WALLCLOCK_SEC )); then
    handoff_and_exit "max wall-clock ${MAX_WALLCLOCK_SEC}s exceeded"
  fi

  status=$(ck_get status)
  phase=$(ck_get phase)
  log "iter=${iter} phase=${phase:-<none>} status=${status:-<none>}"

  case "$status" in
    done|aborted)
      log "terminal status=${status}; exit"
      exit 0
      ;;
    needs-decision)
      park_on_decision
      continue
      ;;
    error)
      handoff_and_exit "checkpoint status=error at iteration start"
      ;;
    running|"")
      : # proceed
      ;;
    *)
      handoff_and_exit "unknown status: ${status}"
      ;;
  esac

  if [[ -z "$phase" ]]; then
    handoff_and_exit "phase missing in checkpoint"
  fi

  fp_before=$(ckpt_fingerprint)
  # Guarded: model_for_phase throws on a corrupt/truncated checkpoint, and an
  # unguarded plain assignment would errexit the whole supervisor with no
  # structured halt (rather than leaving stale status:running).
  model=$(model_for_phase "$phase") || handoff_and_exit "checkpoint unreadable resolving models[${phase}]"
  reasoning=$(reasoning_for_phase "$phase") || handoff_and_exit "checkpoint unreadable resolving reasoning[${phase}]"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  safe_phase=$(printf '%s' "$phase" | tr -c 'A-Za-z0-9._-' '_')
  logfile="${LOG_DIR}/auto-run-${ts}-iter${iter}-${safe_phase}.log"

  rc=0
  if [[ "$phase" == "mode-selected" ]]; then
    set +e; run_implement_phase "$model" "$logfile"; rc=$?; set -e
  else
    set +e; run_codex_phase "$model" "$reasoning" "$logfile"; rc=$?; set -e
  fi
  log "phase ${phase} exited rc=${rc} log=${logfile}"

  case "$rc" in
    0)
      # Codex phase bodies write their own next phase. The implement phase
      # runs the dag-executor CLI, which does NOT touch the checkpoint — so the
      # supervisor owns the implement-phase advance here (mode-selected ->
      # reviewing, retryCount reset).
      if [[ "$phase" == "mode-selected" ]]; then
        ck_merge "{\"phase\":\"reviewing\",\"status\":\"running\",\"retryCount\":0}" || true
      fi
      # Otherwise: phase already wrote next phase/status; loop continues.
      ;;
    1)
      ck_merge "{\"status\":\"error\",\"pendingGate\":\"phase-error-${phase}\"}" || true
      handoff_and_exit "phase ${phase} exit=1; see ${logfile}"
      ;;
    2)
      # park-or-resume — phase signaled pause. Phase SHOULD have written
      # needs-decision itself; if not, normalize so chat sees a consistent
      # state to act on.
      cur_status=$(ck_get status)
      if [[ "$cur_status" != "needs-decision" ]]; then
        ck_merge "{\"status\":\"needs-decision\",\"pendingGate\":\"phase-pause-${phase}\"}" || true
      fi
      cur_gate=$(ck_get pendingGate)
      # For implement: bump retryCount so the next iteration adds --resume.
      # Skip for the sequential-not-supported gate — that is a fail-closed park
      # (no dag run to resume), not a retryable dag-executor pause.
      if [[ "$phase" == "mode-selected" && "$cur_gate" != "sequential-not-supported" ]]; then
        cur_rc=$(ck_get retryCount)
        next_rc=$(( ${cur_rc:-0} + 1 ))
        ck_merge "{\"retryCount\":${next_rc}}" || true
      fi
      park_on_decision
      continue
      ;;
    *)
      ck_merge "{\"status\":\"error\"}" || true
      handoff_and_exit "phase ${phase} unexpected rc=${rc}; see ${logfile}"
      ;;
  esac

  # No-progress guard: phase exited 0 but neither the phase nor the
  # checkpoint content (modulo lastUpdated) changed. Two consecutive such
  # iterations means we are spinning — halt and hand off rather than burn budget.
  fp_after=$(ckpt_fingerprint)
  new_phase=$(ck_get phase)
  if [[ "$new_phase" == "$phase" && "$fp_after" == "$fp_before" ]]; then
    no_progress_streak=$(( no_progress_streak + 1 ))
    log "no-progress: phase=${phase} checkpoint content unchanged (streak=${no_progress_streak}/${NO_PROGRESS_LIMIT})"
    if (( no_progress_streak >= NO_PROGRESS_LIMIT )); then
      handoff_and_exit "no-progress: phase=${phase} unchanged for ${no_progress_streak} iterations"
    fi
  else
    no_progress_streak=0
  fi
done

handoff_and_exit "max iterations ${MAX_ITER} exceeded"
