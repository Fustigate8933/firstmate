/**
 * completion-watch — detect crewmate done/blocked → snapshot → wake queue →
 * deliver (ARCHITECTURE §4, §6, §11, §12, §19).
 *
 * Detection is event-driven and corroborated:
 *   - Primary (event-driven): `herdr agent wait <target> --until done --until
 *     blocked` per in-flight crewmate — no polling.
 *   - Durable corroborator: fs.watch on each status file; the crewmate's `done:`
 *     marker is authoritative and survives a watcher restart (agent wait does not).
 *   - On startup, any task that ALREADY has a done: marker is reconciled
 *     immediately (restart-proof), even though its agent wait never ran.
 *
 * On done: snapshot the outcome into the record (git refs for ship, report path
 * for scout) and enqueue a wake event. On blocked: enqueue a blocked event.
 *
 * Delivery:
 *   - before_agent_start drains the queue on the user's next submit and injects
 *     a summary ("always flush all").
 *   - Under AFK, events are ALSO surfaced proactively (sendMessage triggerTurn)
 *     and fire a native Herdr notification.
 *
 * All session-scoped resources (agent-wait child runs via AbortController, fs
 * watchers) are created in session_start and torn down in session_shutdown.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { agentWait, makeRunner } from "../_shared/herdr.ts";
import { fmNotify } from "../_shared/notify.ts";
import { snapshotOutcome } from "../_shared/outcome.ts";
import { statusPath as statusPathFor } from "../_shared/paths.ts";
import {
	doneSummary,
	drainWake,
	enqueueWake,
	isAfk,
	readAllTasks,
	readTaskRecord,
} from "../_shared/store.ts";
import type { TaskRecord, WakeEvent } from "../_shared/types.ts";

export default function completionWatch(pi: ExtensionAPI) {
	// Session-scoped state (reset in session_start, cleaned in session_shutdown).
	let watchers: fs.FSWatcher[] = [];
	let aborter: AbortController | undefined;
	// Tasks we've already finalized this session, to avoid double-processing.
	const finalized = new Set<string>();

	const key = (project: string, id: string) => `${project}/${id}`;

	const run = makeRunner((command, a, o) => pi.exec(command, a, o));
	const exec = (command: string, a: string[], o?: { timeout?: number }) => pi.exec(command, a, o);

	/** Finalize a done task: snapshot outcome + enqueue wake (once). */
	async function onDone(rec: TaskRecord, ctx?: ExtensionContext): Promise<void> {
		const k = key(rec.project, rec.id);
		if (finalized.has(k)) return;
		finalized.add(k);

		const summary = doneSummary(rec.project, rec.id) ?? "(finished)";
		try {
			await snapshotOutcome(exec, rec.project, rec.id);
		} catch {
			// snapshot failure must not block the wake event
		}
		const ev: WakeEvent = { kind: "done", project: rec.project, id: rec.id, summary, at: new Date().toISOString() };
		enqueueWake(ev);
		await maybeProactive(ev, ctx);
	}

	/** Enqueue a blocked event (not finalized — the task may resume). */
	async function onBlocked(rec: TaskRecord, ctx?: ExtensionContext): Promise<void> {
		const ev: WakeEvent = {
			kind: "blocked",
			project: rec.project,
			id: rec.id,
			summary: "crewmate is blocked and needs input",
			at: new Date().toISOString(),
		};
		enqueueWake(ev);
		await maybeProactive(ev, ctx);
	}

	/** Under AFK, surface proactively + native notification. */
	async function maybeProactive(ev: WakeEvent, _ctx?: ExtensionContext): Promise<void> {
		if (!isAfk()) return;
		const title =
			ev.kind === "done" ? `firstmate: ${ev.project}/${ev.id} done` : `firstmate: ${ev.project}/${ev.id} blocked`;
		await fmNotify(run, { title, body: ev.summary ?? "", sound: "done" });
		// Proactively surface into the chat without waiting for a submit.
		pi.sendMessage(
			{
				customType: "firstmate-wake",
				content: formatWake([ev]),
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	/** Start an event-driven agent-wait watcher for one in-flight task. */
	function startAgentWait(rec: TaskRecord, signal: AbortSignal): void {
		const target = rec.herdr.agentName ?? rec.herdr.tabId;
		if (!target) return;
		// Fire-and-forget loop: wait until done|blocked, finalize, then stop (done)
		// or keep watching (blocked may later resume to working → done).
		void (async () => {
			while (!signal.aborted) {
				let res: { timedOut: boolean };
				try {
					res = await agentWait(run, { target, until: ["done", "blocked"], signal });
				} catch {
					return; // agent gone or backend error; the fs.watch marker still covers done
				}
				if (signal.aborted || res.timedOut) return;
				const fresh = readTaskRecord(rec.project, rec.id);
				if (!fresh) return;
				if (doneSummary(rec.project, rec.id) !== undefined) {
					await onDone(fresh);
					return;
				}
				// Observed a state change that wasn't done → treat as blocked once.
				await onBlocked(fresh);
				// Loop again to catch a later done (e.g. after you unblock it).
			}
		})();
	}

	/** Start an fs.watch on a task's status file (durable done: corroborator). */
	function startStatusWatch(rec: TaskRecord): void {
		const sp = statusPathFor(rec.project, rec.id);
		// Ensure the file exists so fs.watch has something to watch.
		try {
			fs.mkdirSync(path.dirname(sp), { recursive: true });
			if (!fs.existsSync(sp)) fs.writeFileSync(sp, "");
		} catch {
			return;
		}
		try {
			const w = fs.watch(sp, () => {
				if (doneSummary(rec.project, rec.id) !== undefined) {
					const fresh = readTaskRecord(rec.project, rec.id);
					if (fresh) void onDone(fresh);
				}
			});
			watchers.push(w);
		} catch {
			// best-effort
		}
	}

	/** In-flight = dispatched/blocked and not already finalized/cleaned/done. */
	function inFlightTasks(): TaskRecord[] {
		return readAllTasks().filter(
			(r) => (r.status === "dispatched" || r.status === "blocked") && !finalized.has(key(r.project, r.id)),
		);
	}

	pi.on("session_start", async (_event, _ctx) => {
		// Reset session-scoped state.
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
		aborter?.abort();
		aborter = new AbortController();
		finalized.clear();

		const tasks = inFlightTasks();
		for (const rec of tasks) {
			// Restart-proof: a done: marker already present → finalize immediately.
			if (doneSummary(rec.project, rec.id) !== undefined) {
				await onDone(rec);
				continue;
			}
			startStatusWatch(rec);
			startAgentWait(rec, aborter.signal);
		}
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		const events = drainWake();
		if (events.length === 0) return;
		return {
			message: {
				customType: "firstmate-wake",
				content: formatWake(events),
				display: true,
			},
		};
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		for (const w of watchers) {
			try {
				w.close();
			} catch {}
		}
		watchers = [];
		aborter?.abort();
		aborter = undefined;
	});
}

/** Render drained wake events into an injected summary. */
function formatWake(events: WakeEvent[]): string {
	const lines: string[] = [];
	lines.push("# firstmate: crewmate updates");
	for (const ev of events) {
		if (ev.kind === "done") {
			lines.push(`- ✓ ${ev.project}/${ev.id} finished — ${ev.summary ?? ""}`);
		} else if (ev.kind === "blocked") {
			lines.push(`- ⚠ ${ev.project}/${ev.id} is BLOCKED — ${ev.summary ?? "needs your input"}`);
		} else {
			lines.push(`- ✎ ${ev.project}/${ev.id} was edited (${ev.summary ?? ""})`);
		}
	}
	lines.push("");
	lines.push("Report these to the user. For finished tasks, the outcome snapshot is in the task record.");
	return lines.join("\n");
}
