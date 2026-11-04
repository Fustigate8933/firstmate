/**
 * Reconcile summary builder — the per-project "here's where everything stands"
 * text (ARCHITECTURE.md §10). Pure function over disk state, so both the
 * session_start injection and the /reconcile command produce identical output.
 *
 * Disk is ground truth: this reads records + status markers, never the agent's
 * (possibly compacted) memory.
 */

import { doneSummary, isAfk, readAllTasks, readRegistry } from "./store.ts";
import type { TaskRecord } from "./types.ts";

/** Human label for a task's effective status, preferring the durable done: marker. */
function effectiveStatus(rec: TaskRecord): string {
	// The done: marker is authoritative over the recorded status (§6).
	const done = doneSummary(rec.project, rec.id);
	if (done !== undefined) return "done";
	return rec.status;
}

function statusIcon(status: string): string {
	switch (status) {
		case "done":
			return "✓";
		case "blocked":
			return "⚠";
		case "dispatched":
			return "⏳";
		case "failed":
			return "✗";
		case "cleaned":
			return "·";
		default:
			return "?";
	}
}

/** One line per task under its project. */
function taskLine(rec: TaskRecord): string {
	const status = effectiveStatus(rec);
	const marker = doneSummary(rec.project, rec.id);
	const summary = marker ?? rec.outcome?.summary ?? "";
	const bits = [`${statusIcon(status)} ${rec.id}`, `[${rec.shape}]`, status];
	if (rec.model) bits.push(`model=${rec.model}`);
	if (rec.branch) bits.push(`branch=${rec.branch}`);
	if (summary) bits.push(`— ${summary}`);
	return "    " + bits.join(" ");
}

export interface ReconcileSummary {
	text: string;
	activeTasks: number; // dispatched or blocked (not done/failed/cleaned)
	totalTasks: number;
}

/** Build the full reconcile summary from disk. */
export function buildReconcileSummary(): ReconcileSummary {
	const reg = readRegistry();
	const tasks = readAllTasks();
	const afk = isAfk();

	const lines: string[] = [];
	lines.push("# firstmate reconcile (from disk — ground truth)");
	const projectNames = Object.keys(reg.projects);
	lines.push(
		`Registry: ${projectNames.length} project(s)${reg.active ? `, active=${reg.active}` : ", no active project set"}. ` +
			`AFK: ${afk ? "ON" : "off"}.`,
	);

	let activeTasks = 0;

	if (projectNames.length === 0) {
		lines.push("");
		lines.push("No projects registered yet. Register one with:");
		lines.push('  "register <path> as <name>"');
	}

	// Group tasks by project; include registered projects even with no tasks.
	const byProject = new Map<string, TaskRecord[]>();
	for (const name of projectNames) byProject.set(name, []);
	for (const t of tasks) {
		if (!byProject.has(t.project)) byProject.set(t.project, []); // task for an unregistered/removed project
		byProject.get(t.project)!.push(t);
	}

	for (const [project, recs] of byProject) {
		const entry = reg.projects[project];
		const pathNote = entry ? entry.path : "(not in registry)";
		lines.push("");
		lines.push(`## ${project} ${project === reg.active ? "(active)" : ""} — ${pathNote}`);
		if (recs.length === 0) {
			lines.push("    (no tasks)");
			continue;
		}
		// sort by numeric task id
		recs.sort((a, b) => {
			const na = Number(/\d+/.exec(a.id)?.[0] ?? 0);
			const nb = Number(/\d+/.exec(b.id)?.[0] ?? 0);
			return na - nb;
		});
		for (const rec of recs) {
			const status = effectiveStatus(rec);
			if (status === "dispatched" || status === "blocked") activeTasks++;
			lines.push(taskLine(rec));
		}
	}

	lines.push("");
	lines.push(
		`Summary: ${tasks.length} task(s) total, ${activeTasks} still active (⏳/⚠). ` +
			`Report this state to the user concisely; do not re-derive it from memory.`,
	);

	return { text: lines.join("\n"), activeTasks, totalTasks: tasks.length };
}
