/**
 * reconcile — session-start + on-demand disk reconciliation (ARCHITECTURE §10, §19).
 *
 * Disk is ground truth. After any start/resume/reload/fork, and whenever the user
 * runs /reconcile, the first mate re-reads all on-disk task records + status
 * markers + the registry and reports where every project/task stands — instead of
 * trusting its (possibly compacted) context.
 *
 * Mechanics (grounded in real Pi hooks):
 *  - session_start fires on startup/new/resume/reload/fork → mark a reconcile pending.
 *  - before_agent_start fires at the next turn boundary and CAN INJECT a persistent
 *    message → we inject the reconcile summary there so it lands in the LLM context
 *    alongside the user's first message. (One-shot per session_start.)
 *  - /reconcile command → inject immediately and trigger a turn so the first mate
 *    reports on demand (e.g. after being away).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildReconcileSummary } from "../_shared/summary.ts";

export default function reconcile(pi: ExtensionAPI) {
	// Pending flag so the summary is injected once per session_start, at the
	// next turn boundary (not on every before_agent_start).
	let pendingReconcile = true; // default true: factory may run right at startup

	pi.on("session_start", async (event, ctx) => {
		pendingReconcile = true;
		if (ctx.hasUI) {
			const { totalTasks, activeTasks } = buildReconcileSummary();
			ctx.ui.setStatus(
				"firstmate",
				`reconciled: ${totalTasks} task(s), ${activeTasks} active`,
			);
		}
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!pendingReconcile) return;
		pendingReconcile = false;
		const summary = buildReconcileSummary();
		return {
			message: {
				customType: "firstmate-reconcile",
				content: summary.text,
				display: true,
			},
		};
	});

	pi.registerCommand("reconcile", {
		description: "Re-read all on-disk firstmate state and report current status",
		handler: async (_args, ctx) => {
			const summary = buildReconcileSummary();
			// Clear the pending flag so we don't double-inject on the same turn.
			pendingReconcile = false;
			// Inject as a user-visible message and trigger a turn so the first mate
			// reports it. nextTurn would wait for a submit; we want it now.
			pi.sendMessage(
				{
					customType: "firstmate-reconcile",
					content: summary.text,
					display: true,
				},
				{ triggerTurn: true },
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Reconciled: ${summary.totalTasks} task(s), ${summary.activeTasks} active`,
					"info",
				);
			}
		},
	});
}
