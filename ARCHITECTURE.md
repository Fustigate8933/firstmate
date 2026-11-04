# firstmate-lite — Architecture

A personal, minimal reimagining of [firstmate](https://github.com/kunchenguid/firstmate)
for a single developer working locally across multiple projects, using the **Pi**
harness and the **Herdr** backend (running inside kitty).

This document is the design reference. It contains no code — it defines *what*
the system is and *why*, so implementation can follow it directly.

---

## 1. One-paragraph summary

You talk to a single **first mate** (your primary Pi session). It dispatches each
task to an ephemeral **crewmate** — another Pi agent running in its own **Herdr tab**
inside a clean **git worktree**. The first mate picks the model (by policy, by a
family slash-command, or by an exact model you name), tracks completion via Herdr's
native per-tab agent state, and reports outcomes to you in chat. All durable state
lives on disk under a fixed home, so the first mate reconciles from disk rather than
trusting its context window. Local-only by default (worktrees left for you to
inspect); PR support exists but is opt-in per task. Supervision is deliberately
minimal — no wedge/stuck/forever detection. An optional `/afk` away-mode exists.

---

## 2. Base directory (the home)

```
FM_HOME = /mnt/ianch-Secondary/firstmate
```

This is the fixed operational home. All of the first mate's own files live here.
Your actual project repositories do **not** live here — they stay in their existing
locations on disk and are referenced by the project registry (see §9).

---

## 3. Roles

### First mate (primary Pi session)
- The only agent you talk to.
- Holds a *small* standing context: the project registry + whatever task you're
  currently discussing. It never loads all projects' code at once.
- Responsibilities: intake → model selection → dispatch → track completion →
  report → reconcile from disk → (on your word) clean up.
- Read-only over your projects except the guarded operations it performs itself:
  creating worktrees, spawning crewmates, reading state. **All code changes happen
  inside crewmate worktrees**, never directly by the first mate.

### Crewmate (ephemeral Pi subagent in a Herdr tab)
- One autonomous Pi agent per task, launched with a chosen model.
- Works only inside its assigned worktree.
- Short-lived: spawned for one task; its large context dies with the tab when the
  task finishes. The first mate only receives the short summary.
- Two shapes: **ship** (writes code) or **scout** (investigation → report, no code).

### Secondmate (POSTPONED — not in v1)
- A persistent, fully isolated *second first mate* with its own home, state, and
  crew, optionally on another machine over SSH.
- **Not built in v1.** The registry is designed (§9) so a `kind: secondmate` target
  can be added later without redesign. Real triggers to add it: a project moves to
  another machine, a project needs its own always-on coordinator, or hard isolation
  is required.

**Mental model:** a crewmate is a *worker*; a secondmate is *another first mate that
works for you*.

---

## 4. Backend: Herdr-in-kitty

- Each crewmate = one **Herdr tab**.
- The first mate spawns a tab via Herdr's launch mechanism, passing the crewmate's
  working directory (its worktree) and the Pi launch command with the chosen model.
- **Completion signal (revised — see §4b, §12 and §18):** the **crewmate's own
  `done:` status-file marker is authoritative**. However, Herdr *also* exposes a
  native `agent_status` (`idle|working|blocked|done|unknown`) — verified live — and
  a blocking `herdr agent wait --until done`, so completion detection is
  event-driven, not a poll. The status-file marker and Herdr `agent_status: done`
  corroborate each other.
- **"You edited a crewmate directly" signal:** detected via Herdr's per-agent
  monotonic `state_change_seq` / `revision` counters (verified present in
  `agent list` output) — a `done→working` transition bumps the counter without any
  text parsing.
- **Away notifications:** Herdr has a native `herdr notification show <title>
  --body --sound {none,done,request}` command (verified), so AFK alerting is a
  single call — no `notify-send` and no kitty `OSC 99` needed. (Pi's own kitty
  `OSC 99` path remains available as a fallback.)

---

## 4a. How you launch it

Herdr is the terminal backend that owns tabs; Pi runs *inside* a Herdr tab. The
first mate is a Pi session, so it must itself live in a Herdr tab. Launch order:

```
cd /mnt/ianch-Secondary/firstmate   # be in the home (loads AGENTS.md + .pi/extensions/)
herdr                                # launch Herdr (terminal backend, inside kitty)
  → in the first Herdr tab: pi       # launch Pi here → THIS tab is the first mate
```

- **Tab 0:** the first mate (Pi).
- **Tab 1, 2, 3…:** crewmates (Pi), sibling tabs the first mate creates on demand,
  each running a crewmate Pi in a worktree.

What makes a plain `pi` *become* a first mate is that it is launched **in the home
directory**, so Pi auto-loads:
1. **`AGENTS.md`** — the first-mate behavioral instructions (the "distro").
2. **`.pi/extensions/`** — the session-start reconcile hook + the tooling the first
   mate uses to drive Herdr and read task state.

Herdr must be running first, because the first mate (a Pi process) needs a Herdr tab
to exist in, and needs Herdr present so it can create sibling tabs. The first mate
does **not** start Herdr itself — it only creates new tabs within an already-running
Herdr.

---

## 4b. Verified Herdr interface (Herdr 0.9.1, tested live)

Every backend operation the architecture needs maps to a real Herdr command.
**Verified against Herdr 0.9.1 while running inside a live Herdr session.** All
commands emit **structured JSON by default** (there is no `--json` flag; output is
already JSON), so an extension parses them directly.

### Commands used by firstmate-lite

| Need | Command | Verified facts |
| --- | --- | --- |
| Spawn a crewmate tab | `herdr tab create --cwd <path> --label <text> [--env K=V] [--no-focus]` | Creates a tab; `--cwd` sets the working dir, `--env` injects env vars, `--no-focus` keeps your focus |
| Create a worktree + open it | `herdr worktree create --branch <name> --base <ref> --path <path> --cwd <repo> [--no-focus] [--trust-repository]` | Herdr can create the git worktree **and** open it natively — may remove the need to shell out to `git worktree` |
| Read one crewmate's state | `herdr agent get <target>` | Returns the agent object as JSON |
| List all crewmates | `herdr agent list` | One call returns every agent with: `agent`, `agent_status`, `cwd`, `tab_id`, `pane_id`, `workspace_id`, `terminal_title`, `focused`, `state_change_seq`, `revision` |
| Block until done | `herdr agent wait <target> --until done --timeout <ms>` | Blocking wait on state; `--until` repeatable (`idle`/`working`/`blocked`/`done`/`unknown`); default matches idle\|done\|blocked; no `--timeout` = wait forever |
| Send a prompt to a crewmate | `herdr agent prompt <target> ...` | Submit a prompt to a running agent (used to deliver/append requests) |
| Away notification | `herdr notification show <title> --body <text> --sound {none,done,request} --position <corner>` | Native notification with sound |
| Close a finished tab | `herdr tab close <target>` / `herdr worktree remove ...` | Cleanup (manual, on your word) |

### Native agent state (the completion/blocked signal)

`agent_status` has verified values: **`idle`, `working`, `blocked`, `done`,
`unknown`**. This is richer than assumed:
- **`done`** → crewmate finished (corroborates the `done:` status-file marker).
- **`blocked`** → crewmate is waiting on input (a decision point) — directly usable
  to surface "task-N needs you" without any heuristics.
- **`state_change_seq` / `revision`** → monotonic counters per agent; a bump on a
  tab you touched is the clean "you edited a crewmate" signal.

### Implications for the design (simplifications unlocked)

1. **Completion detection can be event-driven**, not a file-watcher poll: block on
   `herdr agent wait <tab> --until done` (optionally also `blocked`). The
   `done:` status-file marker remains the durable, restart-proof corroborator.
2. **Worktree creation may be fully Herdr-native** (`worktree create`), so plain
   `git worktree` becomes optional rather than required.
3. **Notifications are one Herdr call** with a built-in `done` sound — no kitty
   `OSC 99` or `notify-send` needed for AFK.
4. **Everything is JSON by default**, so the extension never parses terminal text
   for state — it reads structured fields.

### Addressing model

Herdr uses stable composite ids seen in the live output: `workspace_id` (e.g.
`w6`), `tab_id` (e.g. `w6:t1`), `pane_id` (e.g. `w6:p1`). A crewmate's task record
should store its `tab_id` (and/or `pane_id`) as the Herdr handle for later
`agent get` / `agent wait` / `tab close` calls. The ambient session also exposes
`HERDR_TAB_ID`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SOCKET_PATH` as env
vars, so the first mate knows its own identity.

---

## 5. Task lifecycle

```
intake → model selection → worktree create → spawn Herdr tab (crewmate)
  → crewmate works → crewmate writes `done:` marker to state/<id>.status
  → first mate's file watcher detects the marker (Herdr idle corroborates)
  → finish event written to durable wake queue (state/.wake-queue)
  → on your next submit, before_agent_start drains queue → first mate reports all
  → (ship) you inspect worktree → manual cleanup when you say so
  → (scout) report at data/reports/<id>.md → first mate summarizes in chat
```

**Task ID:** short stable id (e.g. `task-<n>` or `fm-<slug>`), used for the worktree
name, task record, Herdr tab title, status file, and report path.

**Crewmate task brief delivery (resolved):** the first mate writes the task brief to
a **file** (`data/tasks/<id>/brief.md`), then launches the crewmate pointed at it
("read your brief at <path>"). The brief is durable ground truth: the crewmate can
re-read it, it survives the crewmate's own compaction, and you can inspect/edit it.
Preferred over inlining the brief into the crewmate's context, which cannot be
cleanly re-read and can be distorted by compaction.

---

## 6. Task shapes (following original firstmate)

| Shape     | Writes code? | Output                         | Default boundary                                  |
| --------- | ------------ | ------------------------------ | ------------------------------------------------- |
| **ship**  | Yes, in worktree | branch + commits in worktree | leave worktree for you to inspect; **no PR** unless you opt in |
| **scout** | No           | `data/reports/<id>.md`         | first mate relays findings in chat                |

The first mate infers ship vs scout from the request (change/fix/add = ship;
investigate/compare/figure-out = scout) and asks if genuinely ambiguous.

**Scout completion semantics (resolved):** the crewmate writes a **final one-line
status marker** (appends `done:` to `state/<id>.status`) as its *last* action, after
the report is fully written. The first mate treats **marker present** as the
completion truth; Herdr-idle is only a secondary corroborating hint. (Matches real
firstmate: append-only status events are authoritative, pane state corroborates.)
This avoids false completion from a half-written report or an idle-but-crashed tab.

---

## 7. Model selection

Three levels of control, each overriding the one below:

1. **Implicit (no slash command):** first mate queries Pi for available models,
   then picks family + specific model via policy.
2. **Family slash command:** `/gpt`, `/claude`, `/kimi`, `/glm`, … — you choose the
   family; the first mate picks the best specific model *within that family* for the
   task.
3. **Explicit in text:** naming an exact model id in the request
   (e.g. "use gpt-5-codex-high") overrides everything.

**Complexity heuristic (within a family, or for policy):**
- Infer heavy vs light from the request text: "refactor across files", "redesign",
  "investigate why" → heavier/reasoning model; "rename", "fix typo", "small edit",
  "add one test" → lighter/faster model.
- **If genuinely unsure → first mate asks you** before spawning.

**Unavailable family → hard stop.** If you invoke `/glm` and no GLM model is
available in Pi, the first mate stops, tells you it's unavailable, and asks you to
pick another family. **No silent fallback.**

**Source of truth:** Pi's own live available-model list (queried via Pi's model
listing). Family filters and policy only ever offer models you actually have access
to. firstmate-lite keeps no model catalog of its own.

**Harness note:** all crewmates are **Pi**. "Different agent types" means *different
models within the same Pi harness*, not different harnesses.

---

## 8. Worktrees

- Plain **`git worktree`** (no treehouse dependency in v1; treehouse is a noted
  future upgrade if worktree management gets heavy).
- One worktree per task, so parallel crewmates on the same repo never collide.
- **Placement (resolved):** created **under each target project's own directory**
  (e.g. `<project>/.worktrees/<id>/` or a sibling dir), not centralized under the
  home. Keeps each project's worktrees local to that project.
- **Branch:** `git worktree add <path> -b <branch-prefix>/<id>` (default prefix e.g.
  `fm/`).
- **Cleanup: manual.** Worktrees persist until you tell the first mate to remove one
  ("done with task-3"), then it runs `git worktree remove`. Low space cost; revisit
  if it grows.

---

## 9. Multi-project registry

The first mate holds a small registry mapping names to **existing** project
directories (your projects stay where they are — they are *not* cloned into the home).

**Format (resolved): TOML**, at `data/projects.toml`.

Conceptual shape:

```
math-course    → kind: local-project   path: ~/courses/math
cs-course      → kind: local-project   path: ~/courses/cs
ml-project     → kind: local-project   path: ~/projects/ml
fullstack-app  → kind: local-project   path: ~/projects/webapp
# future:
# gpu-trainer  → kind: secondmate       host: ssh://box   home: /.../firstmate
```

- The `kind` field is what makes **secondmates a clean future drop-in**:
  `local-project` now; `secondmate` later, same routing layer.
- **Registration:** explicit ("register ~/courses/math as `math-course`") is the
  primary path. Optional auto-discovery under a configured root is a possible later
  convenience.
- **Targeting a request to a project:** **active-project + explicit override** — you
  set a current/active project that stays until changed; override by naming another
  project inline ("in ml-project, fix the gradient bug").

**Why one first mate over many projects does NOT overload it:** the first mate only
holds the *registry* (a few lines) plus the current task. Each project's heavy
context lives inside the ephemeral crewmate working it and evaporates when that tab
closes. The coordinator's memory cost is roughly constant regardless of project
count.

---

## 10. Memory & reconciliation (disk is ground truth)

### The principle
An LLM agent only knows what's in its **context window**. Long, busy sessions fill
that window, forcing **auto-compaction** (Pi's default), which *summarizes and
discards* older history. Compaction is a lossy safety net and a real **hallucination
source** — after it, the agent may reason from a subtly-wrong recap.

firstmate-lite fights this three ways:
1. **Externalize to disk** — all task state, registry, reports, and the wake queue
   live in files. These are *ground truth*, re-read rather than remembered.
2. **Context isolation** — heavy per-project work is pushed into ephemeral crewmates
   whose context dies with them; the coordinator's window stays small and rarely
   needs compaction at all.
3. **Reconcile, don't trust memory** — after any restart or compaction, the first
   mate re-reads disk before acting.

### Reconcile step (confirmed feature)
- **Automatic on session start:** the first mate reads all on-disk task records
  (`data/tasks/`) and runtime state (`state/`) and reports a reliable "here's where
  every project/task stands" summary — without trusting its (possibly compacted)
  memory.
- **Manual command** (e.g. `/reconcile`): trigger the same re-read on demand, e.g.
  after being away.

### Pi-specific memory features worth adopting later (optional)
- **Cheaper supervision branch** — run supervision/reconcile logic on a cheaper Pi
  model so it doesn't burden main's context (firstmate's
  `config/supervision-branch-model`).
- **Repeated-read containment** — optional guard that halts the agent if it reads the
  same thing 3× in 15 min (loop/waste guard). Off by default.

---

## 11. Notifications & reporting

**Primary channel — into the chat session (not OS popups):**
- A crewmate-finished (or decision-needed) event is written to a **durable wake
  queue** on disk (`state/.wake-queue`) the moment it happens.
- It is **delivered at a turn boundary**: when *you submit your next message*, Pi's
  **`before_agent_start`** hook drains the queue and **injects a message** (the doc
  confirms this hook can inject a persistent message), so the first mate sees all
  pending completions alongside your new message.
- The first mate **always flushes all pending completions on every turn**, so nothing
  piles up unreported.

**Key guarantees:**
- Your in-progress typing is **never overwritten** — events wait in the queue, they
  do not touch your input line.
- Nothing is lost — the queue is durable across long composes and restarts.
- You never have to "ask" the first mate for news; submitting anything surfaces it.

**Away notifications:** Pi fires a **kitty-native desktop notification** (`OSC 99`)
itself — see §4 and §12. No `notify-send` layer. Herdr's own notifications remain an
additional channel.

---

## 12. AFK / away mode (optional toggle)

- `/afk` toggles away mode on/off. State persists in `state/.afk` and is re-read by
  the reconcile hook on every session start.
- **OFF (default):** pure turn-boundary delivery — nothing surfaces until you submit.
- **ON:** the completion-watch logic surfaces events *proactively* (without waiting
  for your submit) and fires a **native Herdr notification** (`herdr notification
  show <title> --body --sound done`, verified) rather than only a terminal popup.
  When you return, the first mate has the updated progress recorded on disk and
  reconciles you to a reliable starting point.
- This is the one piece of supervision machinery kept, and it is cleanly opt-in.

---

## 13. Project modes (simplified)

- **Default: `local-only`** — crewmate commits in its worktree branch; worktree left
  for your inspection; no PR.
- **Opt-in PR** (per task: "…and open a PR") — crewmate pushes the branch and opens a
  GitHub PR instead of / alongside leaving the worktree. Built but off by default.

---

## 14. On-disk layout (the home)

```
/mnt/ianch-Secondary/firstmate/        # FM_HOME
  data/                                # durable memory (re-read on reconcile)
    projects.<ext>                     # project registry: name → path (+ kind)
    tasks/<id>.json                    # durable task record: shape, model,
                                       #   target project, worktree path, branch,
                                       #   Herdr tab id, status, outcome
    reports/<id>.md                    # scout reports
    preferences                        # your defaults (model policy, active project)
  state/                               # runtime memory
    <id>.status                        # append-only status events per task
                                       #   (crewmate's `done:` marker lives here)
    .wake-queue                        # durable finished / decision events
    .afk                               # away-mode toggle state
  config/                              # local choices (gitignored)
    backend                            # = herdr
    model-policy                       # heavy/light + family rules
    branch-prefix                      # default worktree branch prefix (e.g. fm/)
  worktrees/<id>/                      # git worktrees (if centralized here)
  ARCHITECTURE.md                      # this document
```

Your actual repos (math-course, ml-project, …) live in their own existing
directories and are referenced by `data/projects.<ext>` — not copied here.

---

## 15. Slash commands (user-facing)

| Command            | Purpose                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `/gpt <task>`      | Dispatch crewmate using best GPT-family model for the task        |
| `/claude <task>`   | Same, Claude family                                               |
| `/kimi <task>`     | Same, Kimi family                                                 |
| `/glm <task>`      | Same, GLM family                                                 |
| (bare request)     | Default-model policy picks family + model                         |
| (explicit in text) | Overrides family/policy with the exact model named                |
| `/afk`             | Toggle away mode on/off                                            |
| `/reconcile`       | Re-read all on-disk state and report current status of everything |

(Ship vs scout is inferred from the request, not a separate command — matching
original firstmate's intake style. More family commands can be added as you gain
access to more model families.)

---

## 16. What we deliberately dropped from firstmate

- **Secondmates / SSH remote homes** (postponed; registry designed for drop-in)
- The full **wedge-escalation ladder** and all stale/stuck/forever detection
- **Multi-backend** support (tmux/zellij/orca/etc.) — Herdr only
- **Relay** (X/Discord), voice relay, usage warner
- **Forge variety** (Gerrit/GitLab/Forgejo) — GitHub-only PR, and even that opt-in
- Complex wake-queue + reconciliation engine — replaced by simple on-disk task
  records + Herdr `agent wait` event-driven completion + a `done:` marker for
  durability + a lightweight reconcile step
- **Treehouse** — plain `git worktree` for now

---

## 17. Model policy (default — tweak later)

These are the rules the first mate follows when *it* picks the model: the implicit
(no-slash) case, and which specific model to use inside a chosen family. Defaults
drafted below; adjust any time.

### Heavy vs light classification (from request text)

The first mate matches your request against these word/phrase lists to choose a
heavier reasoning model vs a lighter/faster one.

**Heavy triggers** (→ reasoning/stronger model):
`refactor`, `redesign`, `rearchitect`, `architect`, `migrate`, `debug why`,
`figure out why`, `investigate`, `root cause`, `across files`, `multiple files`,
`design`, `optimize`, `concurrency`, `race condition`, `security`, `algorithm`,
`rewrite`, `complex`, `end to end`.

**Light triggers** (→ faster/cheaper model):
`rename`, `typo`, `format`, `lint`, `add a test`, `small`, `tweak`, `bump`,
`comment`, `docstring`, `rephrase`, `one-liner`, `quick`, `trivial`.

**Tie / neither matches:** default to the *medium* option in the chosen family.
**Genuinely ambiguous or conflicting signals:** the first mate asks you before
spawning.

### Family priority order (bare request, no slash command)

When you specify nothing, the first mate prefers families in this order, filtered to
what Pi actually exposes:

1. **Reasoning-heavy ship tasks:** Claude family (deep reasoning) → then GPT/Codex.
2. **Code-generation-heavy ship tasks:** GPT/Codex family → then Claude.
3. **Scout / investigation tasks:** a cheaper/faster model (whichever family offers
   the best cheap reasoning model available).
4. **Fallback:** the strongest generally-available model if the above can't be
   resolved.

### Within-family specific-model choice

After family + heavy/light are decided, pick the specific model:
- **Heavy** → the family's top reasoning model available to you.
- **Light** → the family's fast/cheap model available to you.
- **Medium/tie** → the family's balanced mid model.

All choices are filtered against Pi's live available-model list; nothing is offered
that you can't actually run. A requested family with no available model is a **hard
stop** (see §7).

---

## 18. Resolved implementation decisions

1. **Crewmate brief delivery** — **file**, written to `data/tasks/<id>/brief.md`,
   crewmate launched pointed at it. (§5)
2. **Scout completion** — **final `done:` marker line** in `state/<id>.status` is
   authoritative; Herdr-idle corroborates. (§6)
3. **Worktree placement** — **under each project's own directory**. (§8)
4. **Registry format** — **TOML** at `data/projects.toml`. (§9)
5. **Model policy** — defaults drafted in §17 above.
6. **Session-start hook** — **Pi extension** (`.pi/extensions/*.ts`) with a
   `session_start` hook that auto-runs reconcile on every start/resume/reload/fork;
   `/reconcile` remains as the manual backup. Chosen over a shell wrapper (misses
   plain `pi` starts and in-session resumes) and manual-only (easy to forget).
7. **Launch model** — **Herdr first, then Pi inside a Herdr tab** from the home
   directory. (§4a)
8. **Herdr interface** — **verified live against Herdr 0.9.1** (§4b): `tab create`,
   `worktree create`, `agent list/get/wait/prompt`, `notification show`,
   `tab close` all exist and emit JSON by default; `agent_status` =
   `idle|working|blocked|done|unknown`. Completion detection is event-driven via
   `agent wait --until done`.

---

## 19. Pi extension mechanics (grounded in Pi's extension API)

The first mate's behavior is delivered by TypeScript extensions in
`.pi/extensions/` (auto-loaded after the home project is trusted). All of the
following maps onto **documented Pi hooks** — nothing here needs mechanics Pi
doesn't have. An extension exports a default function receiving a `pi` API object
and uses: `pi.on(event, handler)`, `pi.registerCommand(name, {...})`,
`pi.registerTool({...})`, and `ctx.ui.*` for interaction. TS loads directly via
jiti (no build step).

### The four extensions

**(1) reconcile** — session-start + disk ground truth
- Hook: `pi.on("session_start", …)` (fires on `startup`, `new`, `resume`,
  `reload`, `fork`) — our auto-reconcile trigger.
- Reads `data/tasks/*`, `state/*`, `data/projects.toml`; injects a reconciliation
  summary via `before_agent_start` (which can inject a persistent message).
- Registers `/reconcile` (`pi.registerCommand`) for the same read-and-report on
  demand.

**(2) dispatch** — family commands + the spawn routine
- Registers family commands: `pi.registerCommand("gpt"/"claude"/"kimi"/"glm", …)`.
  Each handler:
  1. Reads the live, credential-resolved model list via `ctx.modelRegistry` /
     `ctx.scopedModels` (so only runnable models are offered).
  2. Filters to the family; **hard-stops via `ctx.ui.notify` if none available**.
  3. Applies the heavy/light heuristic (§17) to pick the specific model.
  4. Spawns the crewmate.
- Spawn routine: create git worktree → write `data/tasks/<id>/brief.md` → issue a
  Herdr command to open a new tab running `pi` in the worktree, told to read the
  brief. (Pi's `subagent/` example confirms the "extension launches a separate `pi`
  with a delegated prompt/model" pattern; we direct it into a Herdr tab for
  visibility.)

**(3) completion-watch** — Herdr `agent wait` + marker → wake queue → delivery
- Preferred (verified): **event-driven** — block on `herdr agent wait <tab_id>
  --until done --until blocked` per dispatched crewmate (started in `session_start`,
  cleaned up in `session_shutdown`). No polling.
- The crewmate's `done:` marker in `state/<id>.status` remains the durable,
  restart-proof corroborator (survives a watcher restart; `agent wait` does not).
- On completion/blocked: append to `state/.wake-queue`.
- Delivery: `before_agent_start` drains the queue on your next submit and injects
  the summary (always flush all). When `/afk` is ON, surface proactively and fire a
  Herdr notification.
- The `done→working` "you edited a crewmate" case uses Herdr's per-agent
  `state_change_seq`/`revision` counters (verified present in `agent list`).

**(4) afk** — away toggle + native Herdr notification
- Registers `/afk` (`pi.registerCommand`) that flips `state/.afk`.
- Away alerts via `herdr notification show … --sound done` (verified); Pi's kitty
  `OSC 99` path (`notify.ts`) remains an available fallback.

### Hook → responsibility map

| Extension | Key Pi hooks / APIs | Responsibility |
| --- | --- | --- |
| **reconcile** | `session_start`, `registerCommand("reconcile")`, `before_agent_start` (inject) | Re-read disk ground truth; report state on start + on demand |
| **dispatch** | `registerCommand("gpt"/"claude"/…)`, `ctx.modelRegistry`/`ctx.scopedModels`, worktree + Herdr spawn | Family commands, model policy, hard-stop, create worktree + Herdr tab + crewmate |
| **completion-watch** | `herdr agent wait` (event-driven), `before_agent_start` (drain + inject), `session_shutdown` (cleanup) | Detect `done`/`blocked` → wake queue → deliver on submit (or proactively under AFK); `done:` marker is the durable corroborator |
| **afk** | `registerCommand("afk")`, `herdr notification show` | Toggle away mode; proactive surfacing + native Herdr notification |

### Why the wake queue fits Pi exactly
- Events written to `state/.wake-queue` on disk (durable).
- Delivery on submit = `before_agent_start` drains + injects → "flush everything on
  every turn."
- AFK proactive delivery = the file watcher surfaces without waiting for input and
  fires the kitty notification.

---

*Status: design reference, no implementation yet. Secondmates and treehouse are
explicitly future work. Base home fixed at `/mnt/ianch-Secondary/firstmate`.*
