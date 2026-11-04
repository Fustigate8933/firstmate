/**
 * afk — away-mode toggle (ARCHITECTURE §12, §19).
 *
 * `/afk` flips the persisted flag at state/.afk, which the reconcile hook re-reads
 * on every session start. The flag changes how completion-watch delivers events:
 *
 *   OFF (default): pure turn-boundary delivery — events wait in the wake queue
 *                  until the user submits their next message.
 *   ON:            completion-watch surfaces events proactively (without waiting
 *                  for a submit) and fires a native Herdr notification.
 *
 * This extension owns only the toggle + a confirmation ping. completion-watch
 * reads isAfk() and uses the shared fmNotify() for the actual proactive alerts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeRunner } from "../_shared/herdr.ts";
import { fmNotify } from "../_shared/notify.ts";
import { isAfk, setAfk, toggleAfk } from "../_shared/store.ts";

export default function afk(pi: ExtensionAPI) {
	pi.registerCommand("afk", {
		description: "Toggle away mode on/off (proactive notifications when crewmates finish)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			// Allow explicit /afk on | off, else toggle.
			let next: boolean;
			if (arg === "on") next = true;
			else if (arg === "off") next = false;
			else next = !isAfk();

			// Persist (toggleAfk flips; for explicit on/off set directly).
			if (arg === "on" || arg === "off") {
				setAfk(next);
			} else {
				next = toggleAfk();
			}

			if (ctx.hasUI) {
				ctx.ui.setStatus("firstmate-afk", next ? "AFK: ON" : "AFK: off");
				ctx.ui.notify(
					next
						? "Away mode ON — crewmate completions will notify you proactively."
						: "Away mode off — completions surface on your next message.",
					"info",
				);
			}

			// When turning ON, fire a confirmation notification so you know alerts
			// actually reach you before you walk away.
			if (next) {
				const run = makeRunner((command, a, o) => pi.exec(command, a, o));
				await fmNotify(run, {
					title: "firstmate: away mode ON",
					body: "You will be notified when crewmates finish or get blocked.",
					sound: "done",
				});
			}
		},
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off"].filter((o) => o.startsWith(prefix.toLowerCase()));
			return opts.length > 0 ? opts.map((o) => ({ value: o, label: o })) : null;
		},
	});
}
