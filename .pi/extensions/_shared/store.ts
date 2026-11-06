/**
 * Durable disk store for firstmate-lite — the ground truth (ARCHITECTURE.md §10).
 *
 * All task records, status events, the wake queue, the registry, preferences,
 * and the AFK flag live here as files. Nothing in this module touches Herdr or
 * Pi; it is pure disk I/O so it is unit-testable in isolation.
 *
 * Status files are APPEND-ONLY (status events + the crewmate's `done:` marker).
 * The wake queue is APPEND-ONLY with line-delimited JSON, and drained atomically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml, stringifyToml } from "./toml.ts";

import {
	afkPath,
	branchPrefixPath,
	briefPath,
	dataDir,
	preferencesPath,
	projectStateDir,
	recordPath,
	registryPath,
	reportsDir,
	shipFallbackDirPath,
	statusPath,
	taskDir,
	wakeQueuePath,
} from "./paths.ts";
import type { ProjectEntry, Registry, TaskRecord, WakeEvent } from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────
// Low-level helpers
// ──────────────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: write to a temp file, then rename over the target. */
function writeAtomic(file: string, data: string): void {
	ensureDir(path.dirname(file));
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Registry (data/projects.toml)
// ──────────────────────────────────────────────────────────────────────────

export function readRegistry(): Registry {
	const raw = readIfExists(registryPath());
	if (!raw) return { projects: {} };
	let parsed: any;
	try {
		parsed = parseToml(raw);
	} catch (e) {
		throw new Error(`projects.toml is not valid TOML: ${(e as Error).message}`);
	}
	const projects: Record<string, ProjectEntry> = {};
	for (const [name, v] of Object.entries(parsed.projects ?? {})) {
		const entry = v as any;
		if (typeof entry?.path === "string") {
			projects[name] = {
				name,
				kind: entry.kind === "secondmate" ? "secondmate" : "local-project",
				path: entry.path,
			};
		}
	}
	return { active: typeof parsed.active === "string" ? parsed.active : undefined, projects };
}

export function writeRegistry(reg: Registry): void {
	const doc: any = {};
	if (reg.active) doc.active = reg.active;
	doc.projects = {};
	for (const [name, e] of Object.entries(reg.projects)) {
		doc.projects[name] = { kind: e.kind, path: e.path };
	}
	writeAtomic(registryPath(), stringifyToml(doc) + "\n");
}

/** Register (or update) a project, then persist. Returns the updated registry. */
export function registerProject(name: string, path: string, kind: ProjectEntry["kind"] = "local-project"): Registry {
	const reg = readRegistry();
	reg.projects[name] = { name, kind, path };
	if (!reg.active) reg.active = name;
	writeRegistry(reg);
	return reg;
}

export function setActiveProject(name: string): Registry {
	const reg = readRegistry();
	if (!reg.projects[name]) throw new Error(`unknown project: ${name}`);
	reg.active = name;
	writeRegistry(reg);
	return reg;
}

// ──────────────────────────────────────────────────────────────────────────
// Preferences (data/preferences.toml) + simple config files
// ──────────────────────────────────────────────────────────────────────────

export interface Preferences {
	branchPrefix: string;
	defaultPr: boolean;
}

export function readPreferences(): Preferences {
	const raw = readIfExists(preferencesPath());
	let parsed: any = {};
	if (raw) {
		try {
			parsed = parseToml(raw);
		} catch {
			parsed = {};
		}
	}
	// config/branch-prefix overrides preferences if present (ARCHITECTURE §14)
	const bpFile = readIfExists(branchPrefixPath())?.trim();
	return {
		branchPrefix: bpFile || (typeof parsed.branch_prefix === "string" ? parsed.branch_prefix : "fm"),
		defaultPr: parsed.default_pr === true,
	};
}

/**
 * The fallback ship directory (config/ship-fallback-dir) — a normal git repo used
 * as the worktree anchor for ship tasks that have no git root of their own (e.g.
 * dotfiles work). Returns undefined if unset. The crewmate works in a worktree
 * here but edits the real target files (absolute paths) in place.
 */
export function readShipFallbackDir(): string | undefined {
	return readIfExists(shipFallbackDirPath())?.trim() || undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Task records (data/projects/<project>/tasks/<id>/record.json)
// ──────────────────────────────────────────────────────────────────────────

export function writeTaskRecord(rec: TaskRecord): void {
	ensureDir(taskDir(rec.project, rec.id));
	writeAtomic(recordPath(rec.project, rec.id), JSON.stringify(rec, null, 2) + "\n");
}

export function readTaskRecord(project: string, id: string): TaskRecord | undefined {
	const raw = readIfExists(recordPath(project, id));
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as TaskRecord;
	} catch {
		return undefined;
	}
}

/** Shallow-merge a patch into a record and persist it. */
export function updateTaskRecord(project: string, id: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
	const cur = readTaskRecord(project, id);
	if (!cur) return undefined;
	const next = { ...cur, ...patch };
	writeTaskRecord(next);
	return next;
}

/** All task records across all projects (for reconcile). */
export function readAllTasks(): TaskRecord[] {
	const out: TaskRecord[] = [];
	const projectsRoot = path.join(dataDir(), "projects");
	let projectNames: string[] = [];
	try {
		projectNames = fs.readdirSync(projectsRoot).filter((n) => !n.startsWith("."));
	} catch {
		return out;
	}
	for (const project of projectNames) {
		const tDir = path.join(projectsRoot, project, "tasks");
		let ids: string[] = [];
		try {
			ids = fs.readdirSync(tDir).filter((n) => !n.startsWith("."));
		} catch {
			continue;
		}
		for (const id of ids) {
			const rec = readTaskRecord(project, id);
			if (rec) out.push(rec);
		}
	}
	return out;
}

/** Next task id for a project: task-1, task-2, … (based on existing dirs). */
export function nextTaskId(project: string): string {
	const tDir = path.join(dataDir(), "projects", project, "tasks");
	let max = 0;
	try {
		for (const n of fs.readdirSync(tDir)) {
			const m = /^task-(\d+)$/.exec(n);
			if (m) max = Math.max(max, Number(m[1]));
		}
	} catch {
		// no tasks dir yet
	}
	return `task-${max + 1}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Brief (data/projects/<project>/tasks/<id>/brief.md)
// ──────────────────────────────────────────────────────────────────────────

export function writeBrief(project: string, id: string, content: string): string {
	ensureDir(taskDir(project, id));
	const p = briefPath(project, id);
	fs.writeFileSync(p, content);
	return p;
}

/** Append a timestamped update section to an existing brief (same-crewmate channel). */
export function appendBrief(project: string, id: string, update: string): string {
	const p = briefPath(project, id);
	const stamp = new Date().toISOString();
	fs.appendFileSync(p, `\n\n## Update (${stamp})\n${update}\n`);
	return p;
}

// ──────────────────────────────────────────────────────────────────────────
// Status files (state/<project>/<id>.status) — APPEND-ONLY
// ──────────────────────────────────────────────────────────────────────────

/** Append a status event line (the first mate records lifecycle; crewmate appends done:). */
export function appendStatus(project: string, id: string, line: string): void {
	ensureDir(projectStateDir(project));
	const stamp = new Date().toISOString();
	fs.appendFileSync(statusPath(project, id), `${stamp} ${line}\n`);
}

/** Read all status lines for a task. */
export function readStatus(project: string, id: string): string[] {
	const raw = readIfExists(statusPath(project, id));
	if (!raw) return [];
	return raw.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * The authoritative completion check (ARCHITECTURE §6): is there a `done:` line?
 * Returns the summary text after `done:` if present, else undefined.
 */
export function doneSummary(project: string, id: string): string | undefined {
	for (const line of readStatus(project, id)) {
		// line form: "<iso> done: <summary>"  OR  crewmate may write "done: <summary>"
		const m = /(?:^|\s)done:\s*(.*)$/.exec(line);
		if (m) return m[1].trim();
	}
	return undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// Wake queue (state/.wake-queue) — APPEND-ONLY line-delimited JSON
// ──────────────────────────────────────────────────────────────────────────

export function enqueueWake(ev: WakeEvent): void {
	ensureDir(path.dirname(wakeQueuePath()));
	fs.appendFileSync(wakeQueuePath(), JSON.stringify(ev) + "\n");
}

/** Read without draining (peek). */
export function peekWake(): WakeEvent[] {
	const raw = readIfExists(wakeQueuePath());
	if (!raw) return [];
	return raw
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => {
			try {
				return JSON.parse(l) as WakeEvent;
			} catch {
				return undefined;
			}
		})
		.filter((e): e is WakeEvent => !!e);
}

/**
 * Stable identity of a wake event: kind + task + observation timestamp. Two calls
 * to enqueueWake for the same transition carry the same `at`, so this dedupes a
 * re-observed event and lets clearWake() remove exactly the reported ones.
 */
function wakeEventId(ev: WakeEvent): string {
	return `${ev.kind}\u0000${ev.project}\u0000${ev.id}\u0000${ev.at}`;
}

/**
 * Idempotent consume-and-clear: remove ONLY the given (already-reported) events
 * from the queue, preserving any other events (including ones appended
 * concurrently). Returns the events that remain queued.
 *
 * This replaces the old eager-truncate drain. The invariant it guarantees: an
 * event is removed from the queue only after it has actually been emitted into a
 * user-facing summary, so a spurious before_agent_start (e.g. a crewmate's own
 * pi session starting, or our own proactive wake self-trigger) cannot silently
 * destroy an unreported event.
 */
export function clearWake(reported: WakeEvent[]): WakeEvent[] {
	if (reported.length === 0) return peekWake();
	const reportedIds = new Set(reported.map(wakeEventId));
	const remaining = peekWake().filter((e) => !reportedIds.has(wakeEventId(e)));
	try {
		writeAtomic(wakeQueuePath(), remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : ""));
	} catch {
		// if the rewrite fails, leave events in place rather than lose them
	}
	return remaining;
}

// ──────────────────────────────────────────────────────────────────────────
// AFK flag (state/.afk)
// ──────────────────────────────────────────────────────────────────────────

export function isAfk(): boolean {
	return (readIfExists(afkPath())?.trim() ?? "off") === "on";
}

export function setAfk(on: boolean): void {
	ensureDir(path.dirname(afkPath()));
	writeAtomic(afkPath(), on ? "on\n" : "off\n");
}

/** Toggle AFK, returning the new state. */
export function toggleAfk(): boolean {
	const next = !isAfk();
	setAfk(next);
	return next;
}

// ──────────────────────────────────────────────────────────────────────────
// Reports (scout)
// ──────────────────────────────────────────────────────────────────────────

export function ensureReportsDir(project: string): string {
	ensureDir(reportsDir(project));
	return reportsDir(project);
}
