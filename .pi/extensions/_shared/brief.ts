/**
 * Brief builder for firstmate-lite (ARCHITECTURE §5, §18).
 *
 * The brief is the crewmate's durable ground-truth assignment, written to
 * data/projects/<project>/tasks/<id>/brief.md before launch. The crewmate is
 * pointed at it ("read your brief at <path>"). It carries the ABSOLUTE status
 * path so the crewmate writes its done: marker back into FM_HOME, where the
 * first mate can read it (user decision).
 */

import type { TaskShape } from "./types.ts";

export interface BriefInput {
	id: string;
	project: string;
	shape: TaskShape;
	request: string; // the user's task text
	worktree?: string; // ship: the crewmate's cwd
	statusPath: string; // absolute FM_HOME status path
	reportPath?: string; // scout: where to write the report
	pr?: boolean; // ship: open a PR when done
}

export function buildBrief(input: BriefInput): string {
	const lines: string[] = [];
	lines.push(`# Task ${input.id} — ${input.project} [${input.shape}]`);
	lines.push("");
	lines.push("## Request");
	lines.push(input.request.trim());
	lines.push("");

	if (input.shape === "ship") {
		lines.push("## Shape: ship (write code)");
		lines.push("- You are working inside a git worktree — your current working directory.");
		if (input.worktree) lines.push(`- Worktree: ${input.worktree}`);
		lines.push("- Make focused commits in this worktree's branch.");
		lines.push("- Do exactly what the Request asks — smallest correct change, no scope creep.");
		if (input.pr) {
			lines.push("- When finished, push the branch and open a GitHub PR for the change.");
		} else {
			lines.push("- Leave the worktree for inspection; do NOT open a PR.");
		}
	} else {
		lines.push("## Shape: scout (investigate, no code changes)");
		lines.push("- Investigate and report. Do NOT modify code.");
		if (input.reportPath) {
			lines.push(`- Write your full findings as markdown to: ${input.reportPath}`);
		}
		lines.push("- Be concrete: cite files, functions, and line references where relevant.");
	}

	lines.push("");
	lines.push("## When you are done (MANDATORY, final action)");
	lines.push("After all work is complete, append EXACTLY ONE line to your status file:");
	lines.push("");
	lines.push("```");
	lines.push(`echo "done: <one-line summary>" >> ${input.statusPath}`);
	lines.push("```");
	lines.push("");
	lines.push(`- Status file (absolute): ${input.statusPath}`);
	lines.push("- Write `done:` ONLY after the work is truly finished");
	if (input.shape === "scout") lines.push("  (the report must be fully written FIRST).");
	else lines.push("  (commits made FIRST).");
	lines.push("- The one-line summary after `done:` is what the first mate records and reports.");
	lines.push("");
	lines.push("## If the first mate updates this brief");
	lines.push("The first mate may append an `## Update (...)` section below. If asked to");
	lines.push("re-read your brief, re-read this whole file before continuing.");

	return lines.join("\n") + "\n";
}
