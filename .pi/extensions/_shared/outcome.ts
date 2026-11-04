/**
 * Outcome snapshot for firstmate-lite (user decision: snapshot on done:).
 *
 * When a crewmate finishes, capture a SMALL, DURABLE summary into
 * record.outcome so nothing important is trapped in the ephemeral tab. The
 * summary text comes from the authoritative done: marker; the ship refs
 * (commits, files) are derived from git in the worktree — NOT from the
 * crewmate's transcript (which we deliberately never store).
 *
 * This keeps each record ~1-3 KB and ground-truth-derived.
 */

import { doneSummary, readTaskRecord, updateTaskRecord } from "./store.ts";
import type { ExecResult } from "./herdr.ts";
import { reportPath } from "./paths.ts";
import type { TaskOutcome, TaskRecord } from "./types.ts";

type Exec = (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;

async function git(exec: Exec, cwd: string, args: string[]): Promise<string> {
	const res = await exec("git", ["-C", cwd, ...args], { timeout: 10000 });
	return (res.stdout || "").trim();
}

/**
 * Build and persist the outcome snapshot for a finished task.
 * Returns the updated record (or undefined if the record is missing).
 */
export async function snapshotOutcome(exec: Exec, project: string, id: string): Promise<TaskRecord | undefined> {
	const rec = readTaskRecord(project, id);
	if (!rec) return undefined;

	const summary = doneSummary(project, id) ?? rec.outcome?.summary ?? "(no summary in done: marker)";
	const capturedAt = new Date().toISOString();

	if (rec.shape === "scout") {
		const outcome: TaskOutcome = {
			summary,
			report: reportPath(project, id),
			capturedFrom: "done-marker+report",
			capturedAt,
		};
		return updateTaskRecord(project, id, { status: "done", finishedAt: capturedAt, outcome });
	}

	// ship: derive commits + changed files from git in the worktree.
	let commits: string[] | undefined;
	let filesChanged: string[] | undefined;
	if (rec.worktree && rec.base) {
		try {
			const log = await git(exec, rec.worktree, ["log", "--oneline", `${rec.base}..HEAD`]);
			commits = log ? log.split("\n").filter(Boolean) : [];
		} catch {
			commits = undefined;
		}
		try {
			const diff = await git(exec, rec.worktree, ["diff", "--name-only", `${rec.base}..HEAD`]);
			filesChanged = diff ? diff.split("\n").filter(Boolean) : [];
		} catch {
			filesChanged = undefined;
		}
	}

	const outcome: TaskOutcome = {
		summary,
		branch: rec.branch,
		commits,
		filesChanged,
		capturedFrom: "done-marker+git",
		capturedAt,
	};
	return updateTaskRecord(project, id, { status: "done", finishedAt: capturedAt, outcome });
}
