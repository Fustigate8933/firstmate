/**
 * Path helpers for firstmate-lite.
 *
 * FM_HOME is fixed (ARCHITECTURE.md §2). All durable state lives under it in the
 * per-project tree the user approved:
 *
 *   data/projects.toml
 *   data/preferences.toml
 *   data/projects/<project>/tasks/<id>/{brief.md,record.json}
 *   data/projects/<project>/reports/<id>.md
 *   state/<project>/<id>.status
 *   state/.wake-queue          (global — single delivery stream)
 *   state/.afk                 (global — single toggle)
 *   config/{backend,model-policy.toml,branch-prefix,crewmate-preamble.md}
 *
 * All paths returned are ABSOLUTE, because crewmates run in their worktree cwd
 * yet must write their status marker back into FM_HOME (user decision).
 */

import * as path from "node:path";

/** The fixed operational home. Overridable via FM_HOME for tests. */
export const FM_HOME = process.env.FM_HOME ?? "/mnt/ianch-Secondary/firstmate";

export const dataDir = (): string => path.join(FM_HOME, "data");
export const stateDir = (): string => path.join(FM_HOME, "state");
export const configDir = (): string => path.join(FM_HOME, "config");

export const registryPath = (): string => path.join(dataDir(), "projects.toml");
export const preferencesPath = (): string => path.join(dataDir(), "preferences.toml");

export const projectDir = (project: string): string => path.join(dataDir(), "projects", project);
export const tasksDir = (project: string): string => path.join(projectDir(project), "tasks");
export const taskDir = (project: string, id: string): string => path.join(tasksDir(project), id);
export const briefPath = (project: string, id: string): string => path.join(taskDir(project, id), "brief.md");
export const recordPath = (project: string, id: string): string => path.join(taskDir(project, id), "record.json");

export const reportsDir = (project: string): string => path.join(projectDir(project), "reports");
export const reportPath = (project: string, id: string): string => path.join(reportsDir(project), `${id}.md`);

export const projectStateDir = (project: string): string => path.join(stateDir(), project);
export const statusPath = (project: string, id: string): string => path.join(projectStateDir(project), `${id}.status`);

export const wakeQueuePath = (): string => path.join(stateDir(), ".wake-queue");
export const afkPath = (): string => path.join(stateDir(), ".afk");

export const backendPath = (): string => path.join(configDir(), "backend");
export const modelPolicyPath = (): string => path.join(configDir(), "model-policy.toml");
export const branchPrefixPath = (): string => path.join(configDir(), "branch-prefix");
export const crewmatePreamblePath = (): string => path.join(configDir(), "crewmate-preamble.md");
export const shipFallbackDirPath = (): string => path.join(configDir(), "ship-fallback-dir");
