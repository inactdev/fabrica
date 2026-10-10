// `fabrica doctor`'s Inspector-side checks (Client ruling 2026-10-10): a
// GitHub token Inspector can publish with, and an installed Inspector
// that takes the -branch flag Fabrica calls it with. Never prints a token.

import { spawnSync } from "node:child_process";
import { commandIsInstalled, resolveGithubToken } from "./run.ts";

export interface InspectorCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

export function githubTokenStatus(env: NodeJS.ProcessEnv = process.env): InspectorCheck {
  const label = "GitHub token";
  try {
    const { source } = resolveGithubToken(env);
    return { ok: true, label, detail: source === "GITHUB_TOKEN" ? "GITHUB_TOKEN is set" : "from gh auth token" };
  } catch {
    return {
      ok: false,
      label,
      detail: "GITHUB_TOKEN is not set and `gh auth token` gave nothing",
      fix: "run `gh auth login`",
    };
  }
}

export function inspectorBranchStatus(env: NodeJS.ProcessEnv = process.env, command = "inspector"): InspectorCheck {
  const label = "inspector";
  if (!commandIsInstalled(command, env)) {
    return {
      ok: false,
      label,
      detail: `${command} is not on PATH - tasks on projects with .inspector.json will be self-tested instead`,
      fix: "install Inspector (https://github.com/inactdev/inspector) so `inspector` is on PATH",
    };
  }
  const help = spawnSync(command, ["-h"], { env, encoding: "utf8", timeout: 10_000 });
  if (!`${help.stdout}${help.stderr}`.includes("-branch")) {
    return {
      ok: false,
      label,
      detail: `\`${command} -h\` shows no -branch flag, so every handoff Fabrica makes would be refused`,
      fix: "update Inspector to a version that takes -branch",
    };
  }
  return { ok: true, label, detail: `${command} is on PATH and takes -branch` };
}
