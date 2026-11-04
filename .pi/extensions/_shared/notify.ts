/**
 * Shared notification helper for firstmate-lite (ARCHITECTURE §11, §12).
 *
 * Primary channel: a native Herdr notification (`herdr notification show ...
 * --sound done`, verified live). Fallback: kitty OSC 99 (the same approach as
 * Pi's notify.ts example) when Herdr is somehow unavailable.
 *
 * Away alerts (AFK ON) use this; the first mate also surfaces the event into the
 * chat via the wake queue. This module only does the OS-level ping.
 */

import { notificationShow } from "./herdr.ts";
import type { HerdrRunner } from "./herdr.ts";

/** Kitty OSC 99 fallback (from Pi's notify.ts example). */
function notifyOSC99(title: string, body: string): void {
	// i=notification id, d=0 means first chunk, p=body for the second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

/**
 * Fire a desktop notification. Prefers Herdr's native notification (with the
 * built-in `done` sound); falls back to kitty OSC 99 if the Herdr call fails.
 */
export async function fmNotify(
	run: HerdrRunner,
	opts: { title: string; body?: string; sound?: "none" | "done" | "request" },
): Promise<void> {
	try {
		await notificationShow(run, { title: opts.title, body: opts.body, sound: opts.sound ?? "done" });
	} catch {
		try {
			notifyOSC99(opts.title, opts.body ?? "");
		} catch {
			// best-effort; never throw from a notification
		}
	}
}
