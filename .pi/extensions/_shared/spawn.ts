/**
 * Spawn routine for firstmate-lite dispatch (ARCHITECTURE §5, §8, §19).
 *
 * ship:  worktree create (own workspace) → write brief → agent start pi → prompt.
 * scout: tab create (sibling tab, no git) → write brief → agent start pi → prompt.
 *
 * A stable --session-id (fm-<project>-<id>) is passed so a finished crewmate can
 * later be resumed with its full context. The crewmate preamble is injected via
 * --append-system-prompt; the per-task brief is delivered by pointing the
 * crewmate at its path. The TaskRecord is written durably before the prompt so a
 * crash mid-spawn still leaves a reconstructable record.
 */

import * as fs from "node:fs";

import { buildBrief } from "./brief.ts";
import {
	agentPrompt,
	agentStart,
	tabCreate,
	worktreeCreate,
	workspaceClose,
	type HerdrRunner,
} from "./herdr.ts";
import type { ModelLike } from "./models.ts";
import {
	briefPath as briefPathFor,
	crewmatePreamblePath,
	reportPath as reportPathFor,
	statusPath as statusPathFor,
} from "./paths.ts";
import {
	appendBrief,
	appendStatus,
	ensureReportsDir,
	readPreferences,
	writeBrief,
	writeTaskRecord,
} from "./store.ts";
import type { TaskRecord, TaskShape } from "./types.ts";

export interface SpawnRequest {
	project: string;
	projectPath: string; // the registered repo/dir (crewmate cwd base for ship)
	id: string;
	shape: TaskShape;
	request: string; // user's task text
	model: ModelLike;
	thinkingLevel?: string;
	pr?: boolean;
	base?: string; // ship: base ref (default HEAD)
	focus?: boolean; // whether to focus the new tab (default false)
}

export interface SpawnResult {
	record: TaskRecord;
}

/** Session id derived from the task handle (stable → resumable). */
export function sessionIdFor(project: string, id: string): string {
	return `fm-${project}-${id}`.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Herdr agent name: must start with a lowercase letter and contain only
 * lowercase letters, digits, '-' or '_', 1-32 chars (verified constraint).
 * The tab LABEL can be richer (contains ':' and '/'); the agent NAME cannot.
 */
export function agentNameFor(project: string, id: string): string {
	const raw = `fm-${project}-${id}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[^a-z]+/, ""); // must start with a lowercase letter
	const name = (raw.length > 0 ? raw : `fm-${id}`).slice(0, 32).replace(/-+$/, "");
	return name.length > 0 ? name : "fm-crew";
}

/** Build the pi launch args passed after `--` to `herdr agent start`. */
function buildPiArgs(sessionId: string, preamblePath: string | undefined, model: ModelLike, thinking?: string): string[] {
	const modelRef = `${model.provider}/${model.id}`;
	const args = ["--session-id", sessionId, "--model", modelRef];
	if (preamblePath) args.push("--append-system-prompt", preamblePath);
	if (thinking && thinking !== "off") args.push("--thinking", thinking);
	return args;
}

/**
 * Perform the full spawn. Writes the record + initial status, returns the record.
 * Throws if the Herdr backend operations fail (dispatch surfaces that to the user).
 */
export async function spawnCrewmate(run: HerdrRunner, req: SpawnRequest): Promise<SpawnResult> {
	const prefs = readPreferences();
	const createdAt = new Date().toISOString();
	const sessionId = sessionIdFor(req.project, req.id);
	const statusPath = statusPathFor(req.project, req.id);
	const bPath = briefPathFor(req.project, req.id);
	const label = `fm:${req.project}/${req.id}`;

	const preamble = crewmatePreamblePath();
	// Preamble must exist; if missing, proceed without it rather than fail.
	const preambleArg = fs.existsSync(preamble) ? preamble : undefined;

	let herdr: TaskRecord["herdr"] = {};
	let worktree: string | undefined;
	let branch: string | undefined;
	let repoRoot: string | undefined;
	let reportPath: string | undefined;
	let paneId: string;

	if (req.shape === "ship") {
		branch = `${prefs.branchPrefix}/${req.project}/${req.id}`;
		worktree = `${req.projectPath}/.worktrees/${req.id}`;
		const wt = await worktreeCreate(run, {
			cwd: req.projectPath,
			branch,
			base: req.base ?? "HEAD",
			path: worktree,
			label,
			focus: req.focus ?? false,
			trustRepository: true,
		});
		herdr = { workspaceId: wt.workspaceId, tabId: wt.tabId, paneId: wt.paneId };
		worktree = wt.path;
		repoRoot = wt.repoRoot;
		paneId = wt.paneId;
	} else {
		// scout: a sibling tab in the first mate's own workspace, cwd = project path
		const tab = await tabCreate(run, {
			workspace: process.env.HERDR_WORKSPACE_ID,
			cwd: req.projectPath,
			label,
			focus: req.focus ?? false,
		});
		herdr = { workspaceId: tab.workspaceId, tabId: tab.tabId, paneId: tab.paneId };
		paneId = tab.paneId;
		ensureReportsDir(req.project);
		reportPath = reportPathFor(req.project, req.id);
	}

	// Write the brief (durable ground truth) BEFORE launching.
	writeBrief(
		req.project,
		req.id,
		buildBrief({
			id: req.id,
			project: req.project,
			shape: req.shape,
			request: req.request,
			worktree,
			statusPath,
			reportPath,
			pr: req.pr,
		}),
	);

	// Record initial lifecycle status.
	appendStatus(req.project, req.id, `dispatched model=${req.model.provider}/${req.model.id} shape=${req.shape}`);

	const agentName = agentNameFor(req.project, req.id); // strict Herdr agent name
	const started = await agentStart(run, {
		name: agentName,
		paneId,
		kind: "pi",
		timeoutMs: 45000,
		piArgs: buildPiArgs(sessionId, preambleArg, req.model, req.thinkingLevel),
	});
	herdr.agentName = started.name;

	const record: TaskRecord = {
		id: req.id,
		project: req.project,
		shape: req.shape,
		model: `${req.model.provider}/${req.model.id}`,
		thinkingLevel: req.thinkingLevel,
		sessionId,
		briefPath: bPath,
		statusPath,
		worktree,
		branch,
		base: req.shape === "ship" ? (req.base ?? "HEAD") : undefined,
		repoRoot,
		herdr,
		status: "dispatched",
		pr: req.pr,
		createdAt,
	};
	writeTaskRecord(record);

	// Kick off the crewmate: tell it to read its brief and begin.
	await agentPrompt(run, {
		target: started.name,
		text: `Read your brief at ${bPath} and begin the task. Follow the preamble rules, especially writing the done: marker as your final action.`,
	});

	return { record };
}

/** Append an update to a running crewmate's brief and re-ping it (same crewmate). */
export async function appendAndReping(
	run: HerdrRunner,
	opts: { project: string; id: string; agentTarget: string; update: string },
): Promise<void> {
	const bPath = appendBrief(opts.project, opts.id, opts.update);
	appendStatus(opts.project, opts.id, "brief-updated by first mate");
	await agentPrompt(run, {
		target: opts.agentTarget,
		text: `Your brief has been updated at ${bPath}. Re-read the whole brief, then continue.`,
	});
}
