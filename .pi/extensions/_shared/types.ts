/**
 * Shared types for firstmate-lite.
 *
 * These describe the durable on-disk shapes (task records, wake events) and the
 * parsed Herdr command results. Disk is ground truth (ARCHITECTURE.md §10), so
 * these types are the contract the four extensions read/write against.
 */

/** Task shape — ship writes code in a worktree; scout investigates and reports. */
export type TaskShape = "ship" | "scout";

/** Lifecycle status of a task, mirrored on disk in the record. */
export type TaskStatus =
	| "dispatched" // crewmate launched, working
	| "blocked" // crewmate reported blocked (needs input)
	| "done" // crewmate wrote done: marker
	| "failed" // spawn or run failed
	| "cleaned"; // worktree/tab removed on your word

/** Herdr handle for a crewmate — the ids needed for later agent/tab/workspace ops. */
export interface HerdrHandle {
	workspaceId?: string; // e.g. "wN" (worktree create opens its own workspace)
	tabId?: string; // e.g. "wN:t1"
	paneId?: string; // e.g. "wN:p1"
	agentName?: string; // the name passed to `agent start`, used as a target
}

/** Snapshot of a finished crewmate's outcome, derived from status file + git. */
export interface TaskOutcome {
	summary: string; // crewmate's final one-line summary (from done: marker)
	branch?: string; // ship: the worktree branch
	commits?: string[]; // ship: `git log <base>..HEAD` oneline
	filesChanged?: string[]; // ship: `git diff --name-only <base>..HEAD`
	report?: string; // scout: absolute path to the report file
	capturedFrom: string; // provenance, e.g. "done-marker+git"
	capturedAt: string; // ISO timestamp
}

/** Durable per-task record: data/projects/<project>/tasks/<id>/record.json */
export interface TaskRecord {
	id: string; // task id, unique within its project (e.g. "task-3")
	project: string; // registered project name (owner)
	shape: TaskShape;
	model: string; // resolved "provider/id" the crewmate runs
	thinkingLevel?: string; // optional pinned thinking level
	sessionId: string; // stable pi --session-id for resume (§ decision 4)
	briefPath: string; // absolute path to brief.md
	statusPath: string; // absolute path to state/<project>/<id>.status
	worktree?: string; // ship: absolute worktree checkout path
	branch?: string; // ship: branch name
	base?: string; // ship: base ref the worktree was cut from
	repoRoot?: string; // ship: the target project's repo root
	herdr: HerdrHandle;
	status: TaskStatus;
	pr?: boolean; // whether PR output was requested
	createdAt: string; // ISO
	finishedAt?: string; // ISO (set on done/failed)
	outcome?: TaskOutcome; // set when done: fires (the snapshot)
}

/** A durable wake-queue event (state/.wake-queue, one JSON object per line). */
export interface WakeEvent {
	kind: "done" | "blocked" | "edited"; // completion, needs-input, or you-edited-it
	project: string;
	id: string; // task id
	summary?: string; // short text pulled from the status marker if present
	at: string; // ISO timestamp the event was observed
}

/** Registry entry — a target the first mate can route tasks to (ARCHITECTURE.md §9). */
export interface ProjectEntry {
	name: string;
	kind: "local-project" | "secondmate"; // v1 only uses local-project
	path: string; // absolute path to the existing repo/dir
}

/** Parsed projects.toml. */
export interface Registry {
	active?: string; // currently active project name
	projects: Record<string, ProjectEntry>;
}

/** Native Herdr agent object (subset we read from `agent list` / `agent get`). */
export interface HerdrAgent {
	agent: string; // harness kind, e.g. "pi"
	agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
	cwd: string;
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	name?: string;
	terminal_title?: string;
	terminal_title_stripped?: string;
	revision: number;
	state_change_seq: number;
}
