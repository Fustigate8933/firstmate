/**
 * Model selection for firstmate-lite (ARCHITECTURE §7, §17).
 *
 * Three levels of control, each overriding the one below:
 *   1. Implicit (bare request): policy picks family + specific model.
 *   2. Family slash command (/gpt, /claude, /kimi, /glm): user picks family;
 *      we pick the best specific model within it for the task.
 *   3. Explicit model id in the request text: overrides everything.
 *
 * Source of truth is Pi's LIVE available-model list (scopedModels when scoped,
 * else modelRegistry.getAvailable()). Nothing is offered that you cannot run.
 * A requested family with no available model is a HARD STOP (no silent fallback).
 *
 * This module is pure logic over a plain list of {id, provider} — it does not
 * import Pi types, so it is unit-testable with fixtures.
 */

import { parseToml } from "./toml.ts";
import { modelPolicyPath } from "./paths.ts";
import * as fs from "node:fs";

/** Minimal model shape we need (matches pi-ai Model: has id + provider). */
export interface ModelLike {
	id: string;
	provider: string;
}

export type Weight = "heavy" | "light" | "medium";

export interface ModelPolicy {
	heavyTriggers: string[];
	lightTriggers: string[];
	families: Record<string, string[]>; // family → substring patterns
	familyPriorityReasoningShip: string[];
	familyPriorityCodegenShip: string[];
}

const DEFAULT_POLICY: ModelPolicy = {
	heavyTriggers: [
		"refactor", "redesign", "rearchitect", "architect", "migrate",
		"debug why", "figure out why", "investigate", "root cause",
		"across files", "multiple files", "design", "optimize",
		"concurrency", "race condition", "security", "algorithm",
		"rewrite", "complex", "end to end",
	],
	lightTriggers: [
		"rename", "typo", "format", "lint", "add a test", "small",
		"tweak", "bump", "comment", "docstring", "rephrase",
		"one-liner", "quick", "trivial",
	],
	families: {
		kiro: ["kiro"],
		gpt: ["gpt", "codex", "openai", "o1", "o3", "o4"],
		claude: ["claude", "anthropic", "sonnet", "opus", "haiku"],
		kimi: ["kimi", "moonshot"],
		glm: ["glm", "zhipu"],
	},
	familyPriorityReasoningShip: ["kiro", "claude", "gpt"],
	familyPriorityCodegenShip: ["kiro", "gpt", "claude"],
};

/** Load the policy from config/model-policy.toml, falling back to defaults. */
export function loadPolicy(): ModelPolicy {
	let raw: string | undefined;
	try {
		raw = fs.readFileSync(modelPolicyPath(), "utf-8");
	} catch {
		return DEFAULT_POLICY;
	}
	let p: any;
	try {
		p = parseToml(raw);
	} catch {
		return DEFAULT_POLICY;
	}
	return {
		heavyTriggers: Array.isArray(p.heavy_triggers) ? p.heavy_triggers : DEFAULT_POLICY.heavyTriggers,
		lightTriggers: Array.isArray(p.light_triggers) ? p.light_triggers : DEFAULT_POLICY.lightTriggers,
		families: p.families && typeof p.families === "object" ? p.families : DEFAULT_POLICY.families,
		familyPriorityReasoningShip: Array.isArray(p.family_priority_reasoning_ship)
			? p.family_priority_reasoning_ship
			: DEFAULT_POLICY.familyPriorityReasoningShip,
		familyPriorityCodegenShip: Array.isArray(p.family_priority_codegen_ship)
			? p.family_priority_codegen_ship
			: DEFAULT_POLICY.familyPriorityCodegenShip,
	};
}

/** Classify a request as heavy/light/medium from its text (§17). */
export function classifyWeight(text: string, policy: ModelPolicy): { weight: Weight; conflict: boolean } {
	const t = text.toLowerCase();
	const heavy = policy.heavyTriggers.some((w) => t.includes(w.toLowerCase()));
	const light = policy.lightTriggers.some((w) => t.includes(w.toLowerCase()));
	if (heavy && light) return { weight: "medium", conflict: true }; // conflicting → ask
	if (heavy) return { weight: "heavy", conflict: false };
	if (light) return { weight: "light", conflict: false };
	return { weight: "medium", conflict: false }; // tie/neither → medium
}

/** Does a model id/provider belong to a family (by substring patterns)? */
export function modelInFamily(model: ModelLike, family: string, policy: ModelPolicy): boolean {
	const patterns = (policy.families[family] ?? []).map((p) => p.toLowerCase());
	if (patterns.length === 0) return false;
	const hay = `${model.provider}/${model.id}`.toLowerCase();
	return patterns.some((p) => hay.includes(p));
}

/** Detect an explicit model id named in the request text (level 3 override). */
export function explicitModelInText(text: string, available: ModelLike[]): ModelLike | undefined {
	const t = text.toLowerCase();
	// A fully-qualified `provider/id` in the text is the most specific signal and
	// must win over a bare-id collision (e.g. "kiro/auto" must not resolve to
	// "openrouter/auto" just because both share the id "auto"). Prefer the longest
	// qualified match first; only then fall back to bare-id matches.
	const qualified = available
		.filter((m) => t.includes(`${m.provider}/${m.id}`.toLowerCase()))
		.sort((a, b) => `${b.provider}/${b.id}`.length - `${a.provider}/${a.id}`.length);
	if (qualified.length > 0) return qualified[0];
	// Fall back to bare-id matches. Prefer the longest id so "gpt-5-codex" beats "gpt-5".
	const matches = available
		.filter((m) => t.includes(m.id.toLowerCase()))
		.sort((a, b) => b.id.length - a.id.length);
	return matches[0];
}

/** Strength heuristics used to pick within a family (no external catalog). */
const HEAVY_HINTS = ["opus", "o1", "o3", "gpt-5", "reasoning", "max", "pro", "sonnet-5", "sonnet-4-6", "k3"];
const LIGHT_HINTS = ["haiku", "mini", "nano", "flash", "fast", "small", "lite", "terra", "sol"];

/** Score a model for a weight class; higher = better fit. */
function scoreForWeight(model: ModelLike, weight: Weight): number {
	const id = model.id.toLowerCase();
	const heavyHit = HEAVY_HINTS.some((h) => id.includes(h));
	const lightHit = LIGHT_HINTS.some((h) => id.includes(h));
	if (weight === "heavy") return (heavyHit ? 2 : 0) - (lightHit ? 1 : 0);
	if (weight === "light") return (lightHit ? 2 : 0) - (heavyHit ? 1 : 0);
	// medium: prefer neither-extreme, then mild heavy
	if (!heavyHit && !lightHit) return 2;
	return heavyHit ? 1 : 0;
}

/** Pick the best specific model within a family for a weight. undefined if none. */
export function pickWithinFamily(
	available: ModelLike[],
	family: string,
	weight: Weight,
	policy: ModelPolicy,
): ModelLike | undefined {
	const inFamily = available.filter((m) => modelInFamily(m, family, policy));
	if (inFamily.length === 0) return undefined;
	// sort by weight score, then by id desc (newer/higher ids tend to sort later)
	inFamily.sort((a, b) => {
		const d = scoreForWeight(b, weight) - scoreForWeight(a, weight);
		if (d !== 0) return d;
		return b.id.localeCompare(a.id);
	});
	return inFamily[0];
}

export type Shape = "ship" | "scout";

export interface SelectionRequest {
	text: string;
	available: ModelLike[];
	policy: ModelPolicy;
	family?: string; // set by a /family slash command (level 2)
	shape: Shape;
}

export type SelectionResult =
	| { kind: "ok"; model: ModelLike; weight: Weight; reason: string }
	| { kind: "ask"; reason: string } // ambiguous → first mate should ask
	| { kind: "hardstop"; reason: string }; // requested family unavailable

/**
 * Resolve the model for a dispatch (the full §7/§17 decision tree).
 */
export function selectModel(req: SelectionRequest): SelectionResult {
	const { text, available, policy, family, shape } = req;

	if (available.length === 0) {
		return { kind: "hardstop", reason: "No models available in this Pi session." };
	}

	// Level 3: explicit model id in text overrides everything.
	const explicit = explicitModelInText(text, available);
	if (explicit) {
		return {
			kind: "ok",
			model: explicit,
			weight: "medium",
			reason: `explicit model named in request: ${explicit.provider}/${explicit.id}`,
		};
	}

	const { weight, conflict } = classifyWeight(text, policy);

	// Level 2: a family was chosen via slash command.
	if (family) {
		const inFamily = available.filter((m) => modelInFamily(m, family, policy));
		if (inFamily.length === 0) {
			return {
				kind: "hardstop",
				reason: `family "${family}" has no available model in this Pi session. Pick another family.`,
			};
		}
		if (conflict) {
			return { kind: "ask", reason: `request has conflicting heavy+light signals; confirm weight for /${family}.` };
		}
		const model = pickWithinFamily(available, family, weight, policy)!;
		return { kind: "ok", model, weight, reason: `/${family} + ${weight} heuristic` };
	}

	// Level 1: implicit policy. Conflict → ask.
	if (conflict) {
		return { kind: "ask", reason: "request has conflicting heavy+light signals; confirm the intended scope." };
	}

	// Family priority depends on shape + weight.
	// Scout → prefer a lighter/faster model regardless of family priority list.
	// Ship → reasoning-heavy uses reasoning priority; else codegen priority.
	const priority =
		shape === "scout"
			? [...policy.familyPriorityCodegenShip, ...policy.familyPriorityReasoningShip]
			: weight === "heavy"
				? policy.familyPriorityReasoningShip
				: policy.familyPriorityCodegenShip;

	const effectiveWeight: Weight = shape === "scout" ? "light" : weight;

	for (const fam of priority) {
		const model = pickWithinFamily(available, fam, effectiveWeight, policy);
		if (model) {
			return {
				kind: "ok",
				model,
				weight: effectiveWeight,
				reason: `policy: shape=${shape}, weight=${effectiveWeight}, family=${fam}`,
			};
		}
	}

	// Fallback: strongest-ish available model overall for the weight.
	const all = [...available].sort((a, b) => scoreForWeight(b, effectiveWeight) - scoreForWeight(a, effectiveWeight));
	return {
		kind: "ok",
		model: all[0],
		weight: effectiveWeight,
		reason: `fallback: no preferred family available, strongest ${effectiveWeight} model`,
	};
}
