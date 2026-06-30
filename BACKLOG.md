# Backlog

Loose ideas list. Not a roadmap. No sprints, no dates, no issue tracker.
Items are parked here to be re-judged when the time is right — not scheduled.

---

## Hardening: single nonexistent pathspec aborts the whole scoped `git add` in `autoCommit`

`autoCommit` (`src/executor.ts`) calls `git add` with a list of scoped paths. If any single path in that list does not exist, git aborts the entire add — silently dropping work from the paths that do exist. Consider per-path adds (loop with individual `git add <path>`) or an `--ignore-missing`-style flag, whichever is less surprising at merge time.

---

## Idea: spruce up the Figma-aware agents with the pencil.dev CLI + skill

The decomposer and task prompts carry Figma context (`figmaRef`, `figmaTokens`, `layoutSpec` in the DAG schema; Figma touchpoints in `agents/task-decomposer.md` and the command docs). Evaluate whether the pencil.dev CLI and its skill give spawned sessions a better design-to-code path than the current raw Figma references.

**First step:** prototype on one design-heavy task; compare output fidelity against the current figma-console MCP flow before wiring anything into the decomposer schema.

---

## Idea: ad-hoc diff peeking at in-flight task work

The executor runs autonomously, so code is only seen after it lands on the branch (e.g. in warp.dev's review pane). But the work is inspectable earlier: mid-task changes sit uncommitted in `.worktrees/<taskId>` (`autoCommit` fires only after the session ends), and completed-but-unmerged work sits on `dag/<taskId>` branches. Both are reachable with plain git — `git -C .worktrees/<id> diff` and `git diff <base>...dag/<id>` — just with zero ergonomics.

**Idea:** a `dag-executor --peek [taskId]` snapshot command (sibling of `--slots`): list active tasks from `.state.json`, show per-task diffstat of worktree + branch state, full diff for a named task. `watch`-friendly output gets live monitoring for free; a fancier follow-up could be a watch mode that tails `.events.jsonl` and refreshes on task transitions.

---

## Idea: memory system to make existing agents smarter over time

Spawned task sessions and the decomposer start cold every run — nothing learned from prior DAGs (which conventions held, which task shapes failed, which estimates were off). Explore a persistent memory layer: e.g. feed event-log outcomes (`task.failed` reasons, retry patterns, per-weight duration/cost actuals) back into decomposer context, or a memory directory the spawned sessions read/write.

**Constraint:** must not bloat task prompts — memory has to be summarised/curated, not appended raw. The event logs already hold the raw material; the open question is the curation step.

**Progress 2026-06-30:** first curated-memory slice shipped. `dag-executor` now loads `.dag-executor/memory.md` by default (or `--memory=<path>`, disabled with `--no-memory`), caps it, and injects it into spawned task prompts and trivial batches as a conflict-aware "Curated Project Memory" section. `/decompose` now reads the same file into its context bundle when present. Still open: automatic event-log curation/summarization into that memory file.

---

## Idea: replace the slot semaphore with p-limit / p-queue

`src/semaphore.ts` (228 LOC + 225 test LOC) is a hand-rolled **cross-process, machine-wide** concurrency limiter: N atomic `O_CREAT|O_EXCL` slot files in `~/.dag-executor/slots/` (`MAX_GLOBAL_SLOTS=4`), so multiple `dag-executor` processes in different terminal windows share one budget — the OOM/swap guard (invariant #1). It also reclaims slots from crashed holders via PID liveness (`process.kill(pid, 0)` → ESRCH), parks waiters with markers, and releases crash-safely on `exit` / `SIGINT` / `SIGTERM`. `acquireSlot` is the only entry point (`src/executor.ts:285`); layer fan-out is `Promise.allSettled` with each task blocking on its own `acquireSlot`.

**The catch:** `p-limit` / `p-queue` are **in-process** — a counter + promise queue inside one Node process, blind to slots held by another window's process. A straight swap drops the machine-wide bound (two simultaneous runs → 2×N sessions, exactly the spiral the slot files prevent), plus the stale-PID reclaim and crash-safe release. As a *replacement* it's a regression, not an improvement.

**Where a library could fit:** as a thin in-process layer *on top of* the slot semaphore — e.g. `p-queue` for priority / ordering of the layer fan-out before tasks claim cross-process slots. Marginal: `Promise.allSettled` + per-task `acquireSlot` already does the job, and the slot poll is the real limiter.

**First step:** decide whether there's any actual pain (unbounded in-process pending promises? want priority ordering of fan-out?). If not, close as "rejected — cross-process is the whole point." If yes, scope `p-queue` as a layer above slots, never a replacement for them.

---

## Idea: ready-work scheduling instead of topological layers (borrow from Steve Yegge's `beads`)

The layer loop in `src/executor.ts` groups tasks into topological levels and runs them **layer-by-layer with a barrier**: a layer can't advance until its *slowest* task finishes. That barrier wastes wall-clock whenever durations are uneven — a task in layer N+1 that depends on only one fast task in layer N still waits for slow, unrelated siblings sharing layer N. (Concrete: `A→B→C` chain plus independent slow `D` puts `A,D` in layer 0; `B` sits in layer 1 and waits for `D` even though `B` only needs `A`.)

`beads` (`gastownhall/beads`) models the same DAG but schedules by **ready work**: any task whose blockers are all done is runnable *now*, no layer barrier. `bd ready` is just the `[t for t in tasks if indeg[t]==0 and open]` query; agents poll it, take work, close it, re-poll. The executor equivalent is completion-driven: maintain per-task unmet-dep counts, seed a ready set with the indeg-0 tasks, fill free slots from it, `await` whichever running task finishes *first* (not the whole layer), decrement that task's children, push any that hit zero. ~30 lines replacing the layer loop. Strictly more parallel; win scales with how lumpy task durations are (uniform durations → no difference).

Note: `beads` is itself a DAG and a *tracker*, not an executor — this borrows its scheduling discipline, not its storage (Dolt) or the tool itself. The DAG + executor stay.

**The catch (this is the real work, not the loop):** the layer barrier is load-bearing — base-unchanged check (invariant #3), worktree merge (#2), and next-layer contract verification (`src/contracts.ts`) all fire *at the barrier*, once per layer, as a clean checkpoint. Drop layers and that work goes per-task-completion: merge each worktree as it finishes (more merge events, more `dag.base-moved` windows), verify contracts per-edge ("does the just-done task satisfy what each unblocked child needs?") instead of per-layer, base-check before each individual merge. The trivial-task batching (one session per layer for all trivial tasks) also assumes layers — would need a different batching trigger.

**First step:** prototype the ready-set loop behind a flag (`--schedule=ready` vs the default `layers`) so both coexist; move merge/contract/base-check into a single `onTaskComplete` path and confirm the event sequence + reducer still reconstruct correctly on `--resume`. Measure wall-clock on a deliberately lumpy DAG (one heavy task + a wide layer of light ones) before committing. Pairs naturally with dynamic `discovered-from` task insertion (a separate, bigger change — frozen-DAG + static-contract + Zod-schema assumptions).

---

## Hardening: verification skip-don't-fail misses a missing *underlying* tool

The two-tier verification gates (`src/verify/`) promise "tooling we couldn't run is skipped, never failed" (spec AC). `runOne` (`src/verify/run.ts`) enforces this by mapping `ENOENT`/`EACCES` from the spawn to `skipped` — but the spawn is `cmd.argv[0]`, which for a detected `npm run test` is `npm` (always present). If the *script's* underlying tool is missing (e.g. `"test": "jest"` but jest isn't installed — a partial `node_modules`), `npm` itself exits non-zero with "command not found" on stderr, `err.code` is undefined, and `runOne` classifies it `fail` → permanent `task.verification-failed`. Only the direct-bin tsc path (`argv[0] = node_modules/.bin/tsc`) actually benefits from the ENOENT guard today. The `requiresNodeModules` + `existsSync(node_modules)` check covers the fully deps-less worktree, not a present-but-partial install.

**Why deferred:** a stderr-pattern heuristic ("command not found" / "is not recognized") risks masking a real failure whose own output happens to contain that phrase. The sound fix is a **detect-time binary-presence probe** in `detect.ts` — resolve the script's first real executable and check it exists before marking the command runnable — which is a larger change than the review pass that surfaced this.

**First step:** decide scope — probe the resolved tool at detect time (skip the command if absent), or accept the narrow risk and just document it. Don't ship a stderr heuristic.

---

## Hardening: trivial-batch verification failure is coarse + resume-unaware

When the trivial-batch Tier-1 gate fails (`executeTrivialBatch` in `src/executor.ts`), two rough edges compound:

1. **Fan-out mis-attribution.** One failing check emits `task.verification-failed` for *every* task in the batch with a shared error, and divides `fixUsage` evenly across them (`divideUsage`). A 5-task batch where only task 3 broke lint marks all 5 failed; on `--resume` the whole batch re-runs (re-doing 4 innocent tasks' work) and cost telemetry blames each equally.
2. **Resume runs blind.** Re-running goes through `buildBatchedTrivialPrompt` with the *original* prompt — no `VERIFICATION_FIX_NOTICE`, no failing output, no awareness a human may have hand-fixed main at the pause. The agent re-applies its original edits over the human's fix and can clobber it.

The batch is a single atomic session, so isolating one culprit task isn't free — but the current behavior is the bluntest possible. Worth revisiting batch failure granularity + a resume-aware fix-context path together.

**First step:** on resume of a verify-failed trivial batch, thread the prior `formatFailures` output + the fix notice into the re-run prompt (the event log already holds the failing output). Finer per-task attribution is the harder, separate half.

---

## Idea: a `withDeadline(opts, fn)` wrapper in `policy/deadline.ts`

The create-deadline → pass `deadline.signal` to `runQuery` → `finally { deadline.cleanup() }` dance is now hand-rolled in **three** places in `src/executor.ts`: the per-task path (`executeTaskPasses`), the main trivial batch session, and (newest) the trivial verify-fix `runFix`. `policy/deadline.ts` owns `createTaskDeadline` (start + idempotent `cleanup`) but stops short of a `withDeadline({ deadlineMs, enabled, externalSignal }, signal => fn(signal))` helper that absorbs the `try/finally`. The three sites already diverge slightly (one passes `deadline.signal` unconditionally, the others spread `...(deadline.signal && { signal })`) — no compiler pressure keeps them consistent, and the timer-clear (a leaked `setTimeout` otherwise) is easy to forget when adding a fourth gated session.

**First step:** add `withDeadline` to `policy/deadline.ts`, migrate the three call sites, confirm the deadline-vs-SIGINT abort distinction (`wasDeadlineAbort`) still works through the wrapper.

---

## Idea: consolidate `TaskUsage` arithmetic into one module

`TaskUsage` field-wise arithmetic is spread across four sites that each independently list the field roster: `sumUsage` (`src/verify/fix-loop.ts`, all 8 fields), `divideUsage` (`src/executor.ts`, all 8), `aggregateModelUsage` (`src/claude-cli.ts`, the 4 token fields only), and `ZERO_USAGE` (`src/consts.ts`). Adding a 9th telemetry field means editing four scattered spots with no compiler link between them; miss one and that field silently stays `0` in summed/divided usage — wrong cost attribution with no test or type error to flag it. (Minor sibling: `runLayerTier2`'s `formatFailures(...).slice(0, 2000)` re-truncates output that `run.ts`'s `tail()` already capped at `OUTPUT_CAP = 4000` — two unrelated magic numbers on the same text.)

**First step:** a small `src/usage.ts` exporting `zeroUsage` / `addUsage` / `divideUsage` over one field list; route the four sites through it so adding a field is a one-line change.

---

## Hardening: `buildTaskPrompt` hardcodes one consumer repo's conventions

`src/prompt.ts` bakes app-specific context into every task prompt: `Read .claude/references/design-system-tokens.md`, cross-reference `src/configs/theme/colors.ts` for `g`-prefixed theme tokens, check `src/components/common/` for shared components, and concrete Figma MCP tool names (`mcp__figma-console__*`, `mcp__figma-desktop__get_design_context`). On any other target repo these instructions are noise at best, misleading at worst (the agent may hunt for paths that don't exist). The CLI is supposed to be repo-generic — the DAG schema already carries per-task context (`context.conventions`, `relatedPatterns`, `figmaRef`); repo-level conventions belong there or in a config, not in the prompt builder.

**First step:** inventory the hardcoded strings in `buildPhaseZero` / `buildTaskPrompt`, then decide the carrier — a `meta.projectContext` block in the DAG schema (decomposer fills it from the target repo) vs. a `--project-context <file>` CLI flag. Either way the prompt builder goes generic; the vmm-specific lines move to where vmm's decomposition is produced.

---

## Idea: within-phase fan-out to cut pipeline wall-clock (dynamic workflows)

The orchestration pipeline has two layers; only one is a candidate, and not the obvious one.

**Not the CLI executor.** The layer loop (`src/executor.ts`) is already parallel — layer fan-out via `Promise.allSettled`, bounded by the cross-process slot semaphore (`src/semaphore.ts`), with worktree-per-task isolation, the event log, and `--resume` all load-bearing. Replacing it with an in-session dynamic-workflow orchestrator drops exactly those guarantees (machine-wide bound, crash-safe resume, git isolation) — same regression the p-limit entry warns about. Leave it.

**Not the cross-phase supervisor sequence** either (`decompose → plan → review-plan → implement-dag → finalize`). These are genuine data dependencies: can't review a plan before it exists, can't fix before the review. No cross-phase parallelism to harvest.

**The real opportunity is *within* a phase**, where one agent currently chews independent sub-units serially:

- **Code review (strongest).** `code-reviewer` is a single agent covering five dimensions (security, quality, correctness, test integrity, conventions) sequentially in one context. Fanning the find stage out per-dimension (then an adversarial-verify pass per finding) cuts wall-clock and *raises* quality — skeptic verification kills plausible-but-wrong findings. Applies to both standalone `/code-review` and the finalize-chain review step.
- **Triage.** `review-triager` judges each CRITICAL/WARNING finding via fresh-context verification, one after another — a per-finding parallel fan-out by construction.
- **Plan review / decompose self-critique.** Smaller wins: fan plan-review out by dimension; run the decompose critique as a judge panel.

**The catch — integration path, not the fan-out itself.** The Workflow tool is an in-session Claude Code primitive; the supervisor runs each phase as a headless `claude -p` invocation, where Workflow's availability/permission is unverified (same class of headless-`-p` gap as the permission-flag and hook issues already hit). The likelier mechanism is each *skill/agent* fanning out internally via parallel `Agent` calls — no Workflow tool dependency, works the same inline and headless. Decide the mechanism before scoping work.

**First step:** prototype the review fan-out only — split `code-reviewer`'s five dimensions into parallel finders + a per-finding verify pass, behind the existing `/code-review` skill, driven by parallel `Agent` calls (not the Workflow tool). Measure wall-clock and finding quality against the current single-agent review on one real diff. If it wins, port the same shape to triage; defer plan/decompose. Confirm it still works when invoked headless via `claude -p` (the supervisor's actual call path) before wiring into the finalize chain.

---

## Idea: PR-splitting advice from DAG topology (keep merges human-readable)

Motivated by auditing a consumer repo's (vmm) recent merge history: the fattest PRs that *should* have been split fell into two shapes, and **both are already encoded in the DAG** the decomposer emits:

- **Layered data→hook→UI chain** — one PR bundled new query endpoints + a hook + the screens consuming it. Clean split = one PR per layer, each builds green alone. This is exactly a dependency *chain* in the DAG (`A→B→C`).
- **Independent subtrees** — one PR bundled N unrelated tools/modules. Clean split = one PR per subtree. This is exactly a *disconnected component* of the dependency graph.
- **Test ballast inflates apparent size** — the worst offenders were 65–93 files but ~70% of added lines were `.test`/`.snap`/`mockData`. Any size metric must discount tests (they ship with their feature), or it flags cohesive work as bloated.

So the seams a human reviewer wants are the seams `executionLayers` + the dependency edges (`agents/task-decomposer.md`) already expose. The orchestrator currently throws that structure away at merge time: every `dag/<taskId>` branch (`src/worktree.ts`) merges back to the single base branch, and PR creation is downstream/human (warp.dev review pane; the lone `gh`-ish touchpoint is `skills/auto-implement/SKILL.md`'s "PR created" handoff line — no actual `gh pr create` anywhere in `src/`). One DAG run → one undifferentiated PR, no matter how cleanly the DAG decomposed.

**The idea (advisory first, automation maybe-never).** A post-run step that reads the final DAG + event log and prints a recommended PR grouping: connected components → independent PRs; each dependency chain → a stacked-PR sequence (or a "review these commits in this order" note); per-PR diffstat with tests discounted so the size signal is honest. Guidance for the human who opens the PRs, not a new merge mode.

**The catch — autonomy vs. readability is a real tension, not a detail.** The executor's whole value is *autonomous* merge-to-base; splitting into PRs defers merge to human review. That's the *point* when the goal is human-readable PRs — but it cuts directly against the unattended `/auto-run` supervisor flow, so this is opt-in, not default. Beyond that: emitting real PRs needs `gh` + push + auth (new surface the CLI deliberately lacks); stacked PRs carry base-branch ordering complexity (PR B's base is PR A's branch, and GitHub's stacked-PR ergonomics are poor); and the layer barrier already does base-unchanged + contract checks per-layer, which a per-PR-group merge would have to respect. Decompose-time grouping (decomposer annotates a `prGroup` on each task) vs. post-run inference (derive groups from topology alone) is also an open call — the latter needs no schema change.

**First step:** advisory-only, no `gh`. Add `dag-executor --pr-plan` (sibling of `--peek`/`--slots`) that reads the completed DAG, computes connected components + chains, and prints a grouped, test-discounted diffstat with a suggested PR breakdown and ordering. Pure read over existing state — zero merge-path risk. Judge whether the suggested seams actually match what a human would want on 2–3 real finished DAGs before considering any decomposer-schema `prGroup` field or real PR emission. Pairs with the ready-work scheduling entry (both reason over the same component/chain structure of the graph).

---

## Closed

- **Idea: descriptive auto-commit messages instead of `dag-executor: <task.id>`** — done 2026-06-12. Approach 1 (deterministic, no model call) shipped: new `src/executor/commit-message.ts` exports `buildTaskCommitMessage(task)` (name → subject capped at 72 chars, description → body, `task-id: <id>` trailer) and `buildBatchCommitMessage(tasks, {verifyFix})` (summary subject + one bulleted `- <name> (<id>)` line per task). Wired into all three `autoCommit` sites (`task-passes.ts`, `trivial-batch.ts` ×2); the opaque `dag-executor: <id>` / `trivial batch [<ids>]` subjects are gone. 8 colocated tests; suite 187 green. Deferred (per the entry): the diff-summarizer (approach 2) and any decomposer-schema `commitType` — revisit only if `name`/`description` quality proves insufficient on real runs.
- **Refactor: dedup trivial-batch vs worktree task-settlement handling in `executor.ts`** — done 2026-06-10. Success side shipped earlier as `emitTaskCompleted` (`src/events/emit.ts`); the remaining failure/no-op gate sequence is now `settleNoOpGate` (`src/executor.ts`): `verifyOutputsCommitted` → on failure `writeNoOpDebugArtifact` + `noOpFileOutputError` + `task.failed` emit + log, returning `errMsg` so each caller keeps its own retry semantics (in-batch retry-once vs `decide()` policy loop). Path differences (cwd, usage attribution) became parameters. Event-log sequence verified identical by inspection (failure/success branches mutually exclusive, no interleaved emits); smoke harness stubs the executor binary so it can't pin these events — full suite (179) green.
- **Event-sourcing → single atomic checkpoint (Approach B)** — re-judged 2026-06-05, rejected. B is the cleaner design (atomic checkpoint kills the torn-line failure mode, retry streaks become plain counters, `.state.json` is already what humans read), but the current system works, is the most-tested code in the repo (~1,400 reducer/policy test lines), and has no active pain. Rewrite yield is aesthetics + minor ops wins; loses attempt-level history. Don't reopen without concrete operational pain from the event log.
- **Repo extraction** — done 2026-06. This repo is the extraction (seeded from vmm `VMM-7218-explore-orchestration-systems`); plugin + npm-link distribution replaced colocation.
- **Drop the Agent SDK — run tasks via `claude -p`** — done 2026-06-08. `runQuery` (`src/executor.ts`) now spawns `claude -p --output-format stream-json --verbose` via `streamClaudeCli` (`src/claude-cli.ts`); `@anthropic-ai/claude-agent-sdk` removed from `package.json`. The CLI result event carries SDK-identical telemetry (`modelUsage` camelCase, `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms`); the feared stream-json parsing cost was small (the binary is the same runtime the SDK wrapped). Real work was process management (prompt via stdin, NDJSON buffering, process-group kill on deadline, stderr→error for retry parity). Runaway guard reworked: new `WEIGHT_BUDGET_USD` → `--max-budget-usd` (hard; CLI has no documented `--max-turns`, passed best-effort). Spec/plan: `.claude/ai/spec-2026-06-08-drop-agent-sdk-claude-cli.md` / `plan-2026-06-08-drop-agent-sdk-claude-cli.md`.
- **Supervised `/auto-run` hardening** — all five findings from dogfooding the export-scope run are resolved. #1 headless permission flag + #5 bg-launch shipped in `ea41949`. #2 (`/decompose --plan` now upserts `decomposition_path` into plan frontmatter), #3 (new `dag-executor --decomposition-stats` derives `task_count`/`max_width`/`has_heavy` from the validated DAG; the three mode-selection consumers shell out to it instead of model-reading), and #4 (fail-closed self-host staleness guard + `--allow-stale-self-host`) landed 2026-06-08. Spec/plan: `.claude/ai/spec-2026-06-08-auto-run-mode-selection-hardening.md`.
- **Move lint/test to Claude Code hooks** — re-judged 2026-06-09, reframed and superseded by spec. Premise was stale (assumed the now-dropped Agent SDK; tasks run via `claude -p` with `--setting-sources user,project,local`, so a target repo's own hooks already fire). Conclusion: an orchestrator that owns the spawn loop has a stronger lever than a hook — verification belongs *in the executor loop*, not in injected Stop/PostToolUse hooks (which are also unverified in headless `-p`, anthropics/claude-code#40506). Replaced by two-tier pre-merge verification gates (Tier 1 per-task + bounded fix re-invoke; Tier 2 per-layer post-merge pause; detect-not-yarn): `.claude/ai/spec-2026-06-09-pre-merge-verification-gates.md`. Hook path stays deferred — honor target-repo hooks for free; a future PostToolUse per-edit linter sits behind a #40506 spike.
