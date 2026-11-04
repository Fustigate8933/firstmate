/**
 * Typed Herdr 0.9.1 command wrappers.
 *
 * Every function maps to a real Herdr subcommand VERIFIED LIVE (see ARCHITECTURE
 * §4b and the probe run). Herdr emits JSON by default (no --json flag), so these
 * parse structured fields rather than terminal text.
 *
 * Verified return shapes (probe, 2026-11-02):
 *   tab create      → result.tab.tab_id, result.root_pane.{pane_id,tab_id,workspace_id}
 *   worktree create → result.workspace.workspace_id, result.root_pane.{pane_id,tab_id},
 *                      result.worktree.{branch,path}
 *                      (NOTE: also auto-opens a second workspace for the parent repo)
 *   agent start     → result.agent.{name,pane_id,tab_id,workspace_id,agent_status}
 *   agent prompt    → ok, OR error.code "agent_prompt_stalled" when the agent
 *                      answered faster than the 5s observation window (submission
 *                      still succeeded — do NOT treat as failure for fast prompts)
 *   agent list/get  → result.agents[] / result.agent with state_change_seq/revision
 *   agent wait      → blocks; resolves when a requested state is observed
 *   notification    → ok
 *
 * The runner is injectable so this module is testable and usable from any context.
 */

import type { HerdrAgent } from "./types.ts";

/** Minimal shape of a command execution result (matches pi.exec()). */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed?: boolean;
}

/** A function that runs `herdr <args...>` and returns the result. */
export type HerdrRunner = (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

/** Build a HerdrRunner from pi.exec. */
export function makeRunner(
	exec: (
		command: string,
		args: string[],
		options?: { signal?: AbortSignal; timeout?: number },
	) => Promise<ExecResult>,
): HerdrRunner {
	return (args, opts) => exec("herdr", args, { signal: opts?.signal, timeout: opts?.timeoutMs });
}

/** A Herdr command error surfaced as structured JSON. */
export class HerdrError extends Error {
	constructor(
		public code: string,
		message: string,
		public raw?: unknown,
	) {
		super(message);
		this.name = "HerdrError";
	}
}

/** Parse Herdr JSON output, throwing a typed HerdrError on {error:{...}}. */
function parse<T = any>(res: ExecResult): T {
	// Herdr prints success JSON to stdout, but error JSON to STDERR (verified).
	const stdout = (res.stdout || "").trim();
	const stderr = (res.stderr || "").trim();
	const text = stdout || stderr;
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		throw new HerdrError(
			"parse_error",
			`herdr did not emit JSON (code=${res.code}): ${text.slice(0, 300)}`,
		);
	}
	if (json && typeof json === "object" && json.error) {
		throw new HerdrError(json.error.code ?? "unknown", json.error.message ?? "herdr error", json);
	}
	return json as T;
}

// ──────────────────────────────────────────────────────────────────────────
// Tabs
// ──────────────────────────────────────────────────────────────────────────

export interface TabCreateResult {
	tabId: string;
	paneId: string;
	workspaceId: string;
}

/** `herdr tab create` — opens a shell pane (NOT a process). Launch pi via agentStart. */
export async function tabCreate(
	run: HerdrRunner,
	opts: { workspace?: string; cwd?: string; label?: string; env?: Record<string, string>; focus?: boolean },
): Promise<TabCreateResult> {
	const args = ["tab", "create"];
	if (opts.workspace) args.push("--workspace", opts.workspace);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.label) args.push("--label", opts.label);
	for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
	args.push(opts.focus ? "--focus" : "--no-focus");
	const r = parse(await run(args));
	return {
		tabId: r.result.tab.tab_id,
		paneId: r.result.root_pane.pane_id,
		workspaceId: r.result.root_pane.workspace_id,
	};
}

/** `herdr tab close <tab_id>`. */
export async function tabClose(run: HerdrRunner, tabId: string): Promise<void> {
	parse(await run(["tab", "close", tabId]));
}

// ──────────────────────────────────────────────────────────────────────────
// Worktrees (opens its own workspace + tab + pane, AND creates the git worktree)
// ──────────────────────────────────────────────────────────────────────────

export interface WorktreeCreateResult {
	workspaceId: string;
	tabId: string;
	paneId: string;
	branch: string;
	path: string;
	repoRoot?: string;
}

/** `herdr worktree create` — git worktree + opens it in a new workspace. */
export async function worktreeCreate(
	run: HerdrRunner,
	opts: {
		cwd: string; // the source repo
		branch: string;
		base?: string;
		path: string; // checkout path for the worktree
		label?: string;
		focus?: boolean;
		trustRepository?: boolean;
	},
): Promise<WorktreeCreateResult> {
	const args = ["worktree", "create", "--cwd", opts.cwd, "--branch", opts.branch, "--path", opts.path];
	if (opts.base) args.push("--base", opts.base);
	if (opts.label) args.push("--label", opts.label);
	args.push(opts.focus ? "--focus" : "--no-focus");
	if (opts.trustRepository) args.push("--trust-repository");
	const r = parse(await run(args));
	return {
		workspaceId: r.result.workspace.workspace_id,
		tabId: r.result.root_pane.tab_id,
		paneId: r.result.root_pane.pane_id,
		branch: r.result.worktree.branch,
		path: r.result.worktree.path,
		repoRoot: r.result.workspace?.worktree?.repo_root,
	};
}

/** `herdr worktree remove --workspace <id> --force`. */
export async function worktreeRemove(
	run: HerdrRunner,
	opts: { workspace: string; force?: boolean; trustRepository?: boolean },
): Promise<void> {
	const args = ["worktree", "remove", "--workspace", opts.workspace];
	if (opts.force) args.push("--force");
	if (opts.trustRepository) args.push("--trust-repository");
	parse(await run(args));
}

/** `herdr workspace close <id>` — used to clean the auto-opened parent-repo workspace. */
export async function workspaceClose(run: HerdrRunner, workspaceId: string): Promise<void> {
	parse(await run(["workspace", "close", workspaceId]));
}

// ──────────────────────────────────────────────────────────────────────────
// Agents
// ──────────────────────────────────────────────────────────────────────────

export interface AgentStartResult {
	name: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	status: HerdrAgent["agent_status"];
}

/**
 * `herdr agent start <name> --kind pi --pane <pane_id> [-- <pi args>]`.
 * Blocks until the agent is interactive-ready; returns the agent object.
 * `piArgs` flow after `--` (e.g. --model, --append-system-prompt, --session-id).
 */
export async function agentStart(
	run: HerdrRunner,
	opts: { name: string; paneId: string; kind?: string; timeoutMs?: number; piArgs?: string[] },
): Promise<AgentStartResult> {
	const args = ["agent", "start", opts.name, "--kind", opts.kind ?? "pi", "--pane", opts.paneId];
	if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
	if (opts.piArgs && opts.piArgs.length > 0) args.push("--", ...opts.piArgs);
	const r = parse(await run(args, { timeoutMs: (opts.timeoutMs ?? 30000) + 5000 }));
	const a = r.result.agent;
	return { name: a.name, paneId: a.pane_id, tabId: a.tab_id, workspaceId: a.workspace_id, status: a.agent_status };
}

/**
 * `herdr agent prompt <target> <text>`.
 * Returns { stalled } — a fast crewmate that answers inside 5s yields
 * `agent_prompt_stalled`, which means the SUBMISSION SUCCEEDED but Herdr did not
 * observe a working/blocked transition in time. We treat it as delivered.
 * A real `agent_blocked` rejection (agent already blocked) is re-thrown.
 */
export async function agentPrompt(
	run: HerdrRunner,
	opts: { target: string; text: string },
): Promise<{ stalled: boolean }> {
	try {
		parse(await run(["agent", "prompt", opts.target, opts.text]));
		return { stalled: false };
	} catch (e) {
		if (e instanceof HerdrError && e.code === "agent_prompt_stalled") return { stalled: true };
		throw e;
	}
}

/** `herdr agent wait <target> --until <state>...` — blocks until a state is observed. */
export async function agentWait(
	run: HerdrRunner,
	opts: { target: string; until?: Array<HerdrAgent["agent_status"]>; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ timedOut: boolean }> {
	const args = ["agent", "wait", opts.target];
	for (const u of opts.until ?? []) args.push("--until", u);
	if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
	try {
		parse(await run(args, { timeoutMs: opts.timeoutMs ? opts.timeoutMs + 5000 : undefined, signal: opts.signal }));
		return { timedOut: false };
	} catch (e) {
		if (e instanceof HerdrError && /timeout/i.test(e.code)) return { timedOut: true };
		throw e;
	}
}

/** `herdr agent list` — every agent with state_change_seq/revision. */
export async function agentList(run: HerdrRunner): Promise<HerdrAgent[]> {
	const r = parse(await run(["agent", "list"]));
	return r.result.agents as HerdrAgent[];
}

/** `herdr agent get <target>`. Returns undefined if the agent no longer exists. */
export async function agentGet(run: HerdrRunner, target: string): Promise<HerdrAgent | undefined> {
	try {
		const r = parse(await run(["agent", "get", target]));
		return r.result.agent as HerdrAgent;
	} catch (e) {
		if (e instanceof HerdrError) return undefined;
		throw e;
	}
}

/**
 * `herdr pane read <pane_id>` — bounded terminal read (fallback outcome capture).
 * VERIFIED: pane read emits RAW TERMINAL TEXT, not JSON (unlike every other
 * command here), so we return stdout directly and never JSON-parse it.
 */
export async function paneRead(
	run: HerdrRunner,
	opts: { paneId: string; lines?: number; source?: "visible" | "recent" | "recent-unwrapped" | "detection" },
): Promise<string> {
	const args = ["pane", "read", opts.paneId, "--format", "text"];
	if (opts.lines) args.push("--lines", String(opts.lines));
	if (opts.source) args.push("--source", opts.source);
	const res = await run(args);
	return res.stdout;
}

// ──────────────────────────────────────────────────────────────────────────
// Notifications (AFK)
// ──────────────────────────────────────────────────────────────────────────

/** `herdr notification show <title> --body <text> --sound {none,done,request}`. */
export async function notificationShow(
	run: HerdrRunner,
	opts: { title: string; body?: string; sound?: "none" | "done" | "request"; position?: string },
): Promise<void> {
	const args = ["notification", "show", opts.title];
	if (opts.body) args.push("--body", opts.body);
	if (opts.sound) args.push("--sound", opts.sound);
	if (opts.position) args.push("--position", opts.position);
	parse(await run(args));
}
