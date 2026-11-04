/**
 * dispatch — the core: family commands, model selection, and the spawn routine
 * (ARCHITECTURE §5, §7, §8, §15, §19).
 *
 * The first mate drives dispatch through tools + slash commands:
 *   - /gpt /claude /kimi /glm <task>  → family-scoped dispatch (level 2).
 *   - fm_dispatch tool                → bare/implicit or explicit-model dispatch
 *                                        (levels 1 & 3), callable by the LLM.
 *   - fm_update_task tool             → append to a running crewmate's brief and
 *                                        re-ping the SAME crewmate.
 *   - fm_register_project / fm_set_active / fm_list_projects → registry mgmt.
 *   - fm_cleanup_task                 → remove a finished task's worktree/tab
 *                                        (manual, on the user's word).
 *
 * Model source of truth is the live list (scopedModels when scoped, else
 * modelRegistry.getAvailable()). A requested family with no model → hard stop.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { makeRunner, tabClose, workspaceClose, worktreeRemove } from "../_shared/herdr.ts";
import { loadPolicy, selectModel, type ModelLike, type Shape } from "../_shared/models.ts";
import {
	nextTaskId,
	readRegistry,
	readShipFallbackDir,
	readTaskRecord,
	registerProject,
	setActiveProject,
	updateTaskRecord,
} from "../_shared/store.ts";
import { appendAndReping, spawnCrewmate } from "../_shared/spawn.ts";

/** Pull the live, runnable model list as plain {id, provider}. */
async function liveModels(ctx: ExtensionContext): Promise<ModelLike[]> {
	// Prefer the session-scoped set when configured (same as /scoped-models).
	const scoped = ctx.scopedModels;
	if (scoped && scoped.length > 0) {
		return scoped.map((s) => ({ id: s.model.id, provider: s.model.provider }));
	}
	const avail = await Promise.resolve(ctx.modelRegistry.getAvailable());
	return avail.map((m) => ({ id: m.id, provider: m.provider }));
}

/** Resolve the target project: explicit name, else active. */
function resolveProject(explicit: string | undefined): { name: string; path: string } | { error: string } {
	const reg = readRegistry();
	const names = Object.keys(reg.projects);
	if (names.length === 0) return { error: 'No projects registered. Register one: "register <path> as <name>".' };
	const name = explicit ?? reg.active;
	if (!name) return { error: "No active project set and none named. Set one or name a project inline." };
	const entry = reg.projects[name];
	if (!entry) return { error: `Unknown project "${name}". Known: ${names.join(", ")}.` };
	return { name, path: entry.path };
}

/** Synthetic project bucket for projectless scouts (discovery runs). */
const SCRATCH_PROJECT = "_scratch";

/** Is a path a usable git work tree with at least one commit (needed for ship)? */
async function isUsableGitRepo(pi: ExtensionAPI, dir: string): Promise<boolean> {
	try {
		const inside = await pi.exec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
		if ((inside.stdout || "").trim() !== "true") return false;
		// ship needs a base ref (HEAD) — require at least one commit.
		const head = await pi.exec("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 5000 });
		return (head.code ?? 1) === 0 && (head.stdout || "").trim().length > 0;
	} catch {
		return false;
	}
}

/** Shared dispatch body used by both the tool and the family commands. */
async function doDispatch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { request: string; shape: Shape; family?: string; project?: string; pr?: boolean; base?: string; cwd?: string },
): Promise<string> {
	// Resolve where this task runs.
	//  - scout can run WITHOUT a project: it only investigates. If no project is
	//    registered/named, a scout runs in an ad-hoc cwd (the given cwd, else the
	//    user's home) under a synthetic _scratch bucket (the discovery case).
	//  - ship needs a usable git work tree. If the resolved project path is NOT a
	//    usable git repo (e.g. dotfiles whose home is a bare repo Herdr can't
	//    worktree), fall back to the configured ship-fallback-dir (misc). The
	//    crewmate works in a worktree there and edits the real target files in place.
	let projectName: string;
	let projectPath: string;
	let fallbackNote: string | undefined;

	const resolved = resolveProject(opts.project);
	if ("error" in resolved) {
		if (opts.shape === "scout") {
			projectName = SCRATCH_PROJECT;
			projectPath = opts.cwd ?? process.env.HOME ?? "/";
		} else {
			// ship with no project → use the fallback dir if configured.
			const fb = readShipFallbackDir();
			if (!fb) {
				return `Dispatch aborted: ${resolved.error} (ship needs a git repo, and no ship-fallback-dir is configured).`;
			}
			projectName = "misc";
			projectPath = fb;
			fallbackNote = `no git root for this task — using fallback repo ${fb}; edit the real target files by absolute path`;
		}
	} else {
		projectName = resolved.name;
		projectPath = opts.cwd ?? resolved.path;
	}

	// For ship, verify the chosen path is a usable git repo; if not, fall back.
	if (opts.shape === "ship" && !(await isUsableGitRepo(pi, projectPath))) {
		const fb = readShipFallbackDir();
		if (fb && (await isUsableGitRepo(pi, fb))) {
			fallbackNote = `"${projectPath}" is not a usable git work tree — using fallback repo ${fb}; edit the real target files by absolute path`;
			projectName = "misc";
			projectPath = fb;
		} else {
			return `Dispatch aborted: "${projectPath}" is not a usable git work tree and no usable ship-fallback-dir is configured.`;
		}
	}

	const available = await liveModels(ctx);
	const policy = loadPolicy();
	const sel = selectModel({ text: opts.request, available, policy, family: opts.family, shape: opts.shape });

	if (sel.kind === "hardstop") return `Dispatch stopped: ${sel.reason}`;
	if (sel.kind === "ask") return `Need a decision before dispatching: ${sel.reason}`;

	const id = nextTaskId(projectName);
	const run = makeRunner((command, a, o) => pi.exec(command, a, o));

	// If falling back, prepend the note to the request so the crewmate knows the
	// worktree is only an anchor and the real files live elsewhere (absolute paths).
	const request = fallbackNote ? `[NOTE: ${fallbackNote}]\n\n${opts.request}` : opts.request;

	try {
		const { record } = await spawnCrewmate(run, {
			project: projectName,
			projectPath,
			id,
			shape: opts.shape,
			request,
			model: sel.model,
			pr: opts.pr,
			base: opts.base,
		});
		return [
			`Dispatched ${projectName}/${id} [${opts.shape}]`,
			projectName === SCRATCH_PROJECT ? `  (projectless discovery scout, cwd: ${projectPath})` : undefined,
			fallbackNote ? `  (fallback: ${fallbackNote})` : undefined,
			`  model: ${record.model} (${sel.reason})`,
			record.branch ? `  branch: ${record.branch}` : undefined,
			record.worktree ? `  worktree: ${record.worktree}` : undefined,
			`  herdr tab: ${record.herdr.tabId}`,
			`  brief: ${record.briefPath}`,
			opts.shape === "scout" ? `  report will be at: data/projects/${projectName}/reports/${id}.md` : undefined,
			`The crewmate is working. You'll be notified when it writes its done: marker.`,
		]
			.filter(Boolean)
			.join("\n");
	} catch (e) {
		return `Dispatch failed for ${projectName}/${id}: ${(e as Error).message}`;
	}
}

export default function dispatch(pi: ExtensionAPI) {
	// ── Family slash commands (level 2) ────────────────────────────────────
	const families = ["gpt", "claude", "kimi", "glm"] as const;
	for (const family of families) {
		pi.registerCommand(family, {
			description: `Dispatch a crewmate using the best ${family.toUpperCase()} model for the task`,
			handler: async (args, ctx) => {
				const request = args.trim();
				if (!request) {
					ctx.ui.notify(`Usage: /${family} <task description>`, "info");
					return;
				}
				// Infer shape from the request text (ship vs scout).
				const shape = inferShape(request);
				const result = await doDispatch(pi, ctx, { request, shape, family });
				// Surface the dispatch outcome into the conversation.
				pi.sendMessage({ customType: "firstmate-dispatch", content: result, display: true }, { triggerTurn: true });
			},
		});
	}

	// ── fm_dispatch tool (levels 1 & 3) ────────────────────────────────────
	pi.registerTool({
		name: "fm_dispatch",
		label: "Dispatch crewmate",
		description:
			"Dispatch a crewmate (another Pi agent in a Herdr tab/worktree) to work on a task. " +
			"Use for bare requests (policy picks the model) or when the user named an exact model in the text. " +
			"Set shape='ship' for code changes, 'scout' for investigation-only. " +
			"ship needs a registered project (it makes a git worktree there). " +
			"scout does NOT need a registered project — to DISCOVER where the user's files live, dispatch a " +
			"projectless scout with a cwd (e.g. the user's home or ~/.config) and have it report the layout, " +
			"whether it's a git repo, and the repo root to ship into. Never ask the user for a path you can scout for. " +
			"Name the project only to override the active one.",
		promptGuidelines: [
			"Use fm_dispatch to hand a task to a crewmate instead of doing project code changes yourself.",
			"Use fm_dispatch shape='ship' for change/fix/add requests; shape='scout' for investigate/compare/figure-out.",
			"When you don't know where the user's files live, use fm_dispatch shape='scout' with a cwd to discover them — do not ask the user for the path.",
		],
		parameters: Type.Object({
			request: Type.String({ description: "The full task description for the crewmate." }),
			shape: StringEnum(["ship", "scout"] as const),
			project: Type.Optional(Type.String({ description: "Project name to target; omit to use the active project." })),
			cwd: Type.Optional(
				Type.String({
					description:
						"scout only: directory to investigate when no project applies (e.g. the user's home or ~/.config). " +
						"Enables a projectless discovery scout. Defaults to the user's home if omitted.",
				}),
			),
			pr: Type.Optional(Type.Boolean({ description: "ship only: push branch and open a PR when done." })),
			base: Type.Optional(Type.String({ description: "ship only: base git ref for the worktree (default HEAD)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await doDispatch(pi, ctx as ExtensionContext, {
				request: params.request,
				shape: params.shape as Shape,
				project: params.project,
				cwd: params.cwd,
				pr: params.pr,
				base: params.base,
			});
			return { content: [{ type: "text", text: result }], details: {} };
		},
	});

	// ── fm_update_task tool (append-to-brief + re-ping same crewmate) ──────
	pi.registerTool({
		name: "fm_update_task",
		label: "Update task brief",
		description:
			"Append an instruction to a RUNNING crewmate's brief and re-ping the same crewmate to re-read it. " +
			"Use this to add durable instructions to an in-flight task (not a quick ephemeral nudge).",
		promptGuidelines: [
			"Use fm_update_task to add durable instructions to a running crewmate; it keeps the same crewmate and worktree.",
		],
		parameters: Type.Object({
			project: Type.String({ description: "Project name of the task." }),
			id: Type.String({ description: "Task id, e.g. task-3." }),
			update: Type.String({ description: "The instruction to append to the brief." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rec = readTaskRecord(params.project, params.id);
			if (!rec) return { content: [{ type: "text", text: `No task record for ${params.project}/${params.id}.` }], details: {} };
			const target = rec.herdr.agentName ?? rec.herdr.tabId;
			if (!target)
				return {
					content: [{ type: "text", text: `Task ${params.project}/${params.id} has no Herdr handle to re-ping.` }],
					details: {},
				};
			const run = makeRunner((command, a, o) => pi.exec(command, a, o));
			try {
				await appendAndReping(run, { project: params.project, id: params.id, agentTarget: target, update: params.update });
				return {
					content: [{ type: "text", text: `Appended to ${params.project}/${params.id} brief and re-pinged the crewmate.` }],
					details: {},
				};
			} catch (e) {
				return { content: [{ type: "text", text: `Update failed: ${(e as Error).message}` }], details: {} };
			}
		},
	});

	// ── Registry management tools ────────────────────────────────────────────
	pi.registerTool({
		name: "fm_register_project",
		label: "Register project",
		description:
			"Register an EXISTING project directory in the firstmate registry so tasks can be routed to it. " +
			"The directory stays where it is (never copied). The first registered project becomes active.",
		promptGuidelines: [
			'Use fm_register_project when the user says "register <path> as <name>" or asks to add a project.',
		],
		parameters: Type.Object({
			name: Type.String({ description: "Short name for the project, e.g. cs240." }),
			path: Type.String({ description: "Absolute path to the existing project directory." }),
		}),
		async execute(_toolCallId, params) {
			if (!fs.existsSync(params.path)) {
				return { content: [{ type: "text", text: `Path does not exist: ${params.path}` }], details: {} };
			}
			const reg = registerProject(params.name, params.path);
			return {
				content: [
					{
						type: "text",
						text: `Registered "${params.name}" → ${params.path}. Active project: ${reg.active}.`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "fm_set_active",
		label: "Set active project",
		description: "Set the current active project. Tasks without an inline project target go here.",
		promptGuidelines: ["Use fm_set_active when the user switches which project is current."],
		parameters: Type.Object({ name: Type.String({ description: "Project name to make active." }) }),
		async execute(_toolCallId, params) {
			try {
				const reg = setActiveProject(params.name);
				return { content: [{ type: "text", text: `Active project is now ${reg.active}.` }], details: {} };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], details: {} };
			}
		},
	});

	pi.registerTool({
		name: "fm_list_projects",
		label: "List projects",
		description: "List registered projects and which one is active.",
		promptGuidelines: ["Use fm_list_projects to see registered projects and the active one."],
		parameters: Type.Object({}),
		async execute() {
			const reg = readRegistry();
			const names = Object.keys(reg.projects);
			if (names.length === 0) {
				return { content: [{ type: "text", text: "No projects registered." }], details: {} };
			}
			const lines = names.map(
				(n) => `${n === reg.active ? "* " : "  "}${n} → ${reg.projects[n].path} [${reg.projects[n].kind}]`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	// ── Cleanup (manual, on the user's word) ─────────────────────────────────
	pi.registerTool({
		name: "fm_cleanup_task",
		label: "Clean up task",
		description:
			"Remove a FINISHED task's Herdr worktree/tab. Only do this when the user explicitly says they are " +
			"done with the task. The durable outcome snapshot in the record is preserved.",
		promptGuidelines: [
			'Use fm_cleanup_task only when the user explicitly says they are done with a task (e.g. "clean up task-3").',
		],
		parameters: Type.Object({
			project: Type.String({ description: "Project name of the task." }),
			id: Type.String({ description: "Task id to clean up, e.g. task-3." }),
		}),
		async execute(_toolCallId, params) {
			const rec = readTaskRecord(params.project, params.id);
			if (!rec) return { content: [{ type: "text", text: `No task record for ${params.project}/${params.id}.` }], details: {} };
			const run = makeRunner((command, a, o) => pi.exec(command, a, o));
			const notes: string[] = [];
			try {
				if (rec.shape === "ship" && rec.herdr.workspaceId) {
					await worktreeRemove(run, { workspace: rec.herdr.workspaceId, force: true, trustRepository: true });
					notes.push(`removed worktree workspace ${rec.herdr.workspaceId}`);
				} else if (rec.herdr.tabId) {
					await tabClose(run, rec.herdr.tabId);
					notes.push(`closed tab ${rec.herdr.tabId}`);
				}
			} catch (e) {
				notes.push(`cleanup warning: ${(e as Error).message}`);
			}
			updateTaskRecord(params.project, params.id, { status: "cleaned" });
			return {
				content: [{ type: "text", text: `Cleaned ${params.project}/${params.id}. ${notes.join("; ")}. Outcome snapshot preserved in the record.` }],
				details: {},
			};
		},
	});
}

/** Infer ship vs scout from the request text (ARCHITECTURE §6). */
function inferShape(request: string): Shape {
	const t = request.toLowerCase();
	const scoutSignals = ["investigate", "compare", "figure out", "why ", "analyze", "research", "look into", "find out", "explain"];
	const shipSignals = ["add ", "fix", "change", "implement", "refactor", "rename", "update", "create", "write", "build", "remove", "delete"];
	const scout = scoutSignals.some((s) => t.includes(s));
	const ship = shipSignals.some((s) => t.includes(s));
	if (scout && !ship) return "scout";
	return "ship"; // default to ship when ambiguous or ship-signalled
}
