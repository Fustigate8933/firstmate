# firstmate-lite

A personal, minimal task coordinator for a single developer, built on the **Pi**
harness and the **Herdr** backend (running in kitty).

You talk to one **first mate** (a Pi session). It dispatches each task to an
ephemeral **crewmate** — another Pi agent in its own Herdr tab and git worktree, on
a model chosen by policy or by your command. Completion is tracked via each
crewmate's `done:` marker (corroborated by Herdr's native agent state), and all
durable state lives on disk so the first mate reconciles from disk rather than from
a lossy context window.

See `ARCHITECTURE.md` for the full design and `AGENTS.md` for the first mate's
behavioral spec.

## Launch

Herdr must be running first; the first mate is a Pi session inside a Herdr tab,
launched from this home directory so Pi auto-loads `AGENTS.md` and
`.pi/extensions/`:

```
cd /mnt/ianch-Secondary/firstmate
herdr                 # terminal backend (inside kitty)
  → in the first tab: pi    # THIS tab becomes the first mate
```

Crewmates are sibling tabs/worktrees the first mate creates on demand.

## Layout

```
AGENTS.md                      first-mate behavioral spec (auto-loaded by Pi)
ARCHITECTURE.md                design reference (ground truth)
.pi/extensions/
  _shared/                     shared lib (no external deps beyond the Pi SDK)
    types.ts  paths.ts  toml.ts  store.ts  herdr.ts
    models.ts brief.ts  spawn.ts summary.ts notify.ts outcome.ts
  reconcile/                   session-start + /reconcile disk reconciliation
  dispatch/                    /gpt /claude /kimi /glm + fm_* tools (dispatch/mgmt)
  completion-watch/            done/blocked detection → snapshot → wake → delivery
  afk/                         /afk away-mode toggle + notifications
config/                        local choices (gitignored)
  backend  branch-prefix  model-policy.toml  crewmate-preamble.md
data/                          durable memory
  projects.toml  preferences.toml
  projects/<project>/tasks/<id>/{brief.md,record.json}
  projects/<project>/reports/<id>.md
state/                         runtime memory (gitignored)
  <project>/<id>.status  .wake-queue  .afk
```

## Commands & tools (what the first mate exposes)

| Trigger | Purpose |
| --- | --- |
| `fm_dispatch` (tool) | Dispatch a crewmate (ship or scout); policy picks the model |
| `/gpt` `/claude` `/kimi` `/glm` `<task>` | Dispatch using the best model in that family |
| `fm_update_task` (tool) | Append to a running crewmate's brief + re-ping it |
| `fm_register_project` / `fm_set_active` / `fm_list_projects` (tools) | Registry |
| `fm_cleanup_task` (tool) | Remove a finished task's worktree/tab (manual) |
| `/reconcile` | Re-read all on-disk state and report status |
| `/afk` | Toggle away mode (proactive notifications) |

## Status

v1. Secondmates and treehouse are explicitly out of scope (the registry is designed
so a `kind: secondmate` target can be added later without redesign).
