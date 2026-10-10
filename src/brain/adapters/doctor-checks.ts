// `fabrica doctor`'s adapter-side checks (Client ruling 2026-10-10): the
// worker image, and the worker token. Here because only this directory
// may name the adapter (CONTRACT rule 8); doctor prints what these return.
// Nothing here ever returns, prints, or logs a token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runContained } from "../../containment/index.ts";
import { DEFAULT_IMAGE } from "./claude-code.ts";
import { brainEnvPath, credentialEnvFrom } from "./index.ts";

export interface AdapterCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), "docker", "Dockerfile");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STAMP_LABEL = "fabrica.dockerfile-sha256";

/** The hash the image is stamped with at build time (the Dockerfile's
 * `DOCKERFILE_SHA256` build arg, stored as a LABEL). */
export function dockerfileSha256(): string {
  return createHash("sha256").update(readFileSync(DOCKERFILE)).digest("hex");
}

function buildCommand(): string {
  return (
    `cd ${REPO_ROOT} && docker build --build-arg DOCKERFILE_SHA256=${dockerfileSha256()} ` +
    `-t ${DEFAULT_IMAGE} -f ${relative(REPO_ROOT, DOCKERFILE)} .`
  );
}

/** The image's stamp: null when the image is absent, "" when it carries
 * none. */
function readStamp(): string | null {
  try {
    const out = execFileSync("docker", ["image", "inspect", DEFAULT_IMAGE, "--format", `{{index .Config.Labels "${STAMP_LABEL}"}}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "<no value>" ? "" : out;
  } catch {
    return null;
  }
}

export function workerImageStatus(stamp: () => string | null = readStamp): AdapterCheck {
  const label = "worker image";
  const found = stamp();
  if (found === null) return { ok: false, label, detail: `${DEFAULT_IMAGE} is not built`, fix: buildCommand() };
  if (found === "") {
    return { ok: false, label, detail: `${DEFAULT_IMAGE} carries no Dockerfile stamp, so whether it is current is unknown`, fix: buildCommand() };
  }
  if (found !== dockerfileSha256()) {
    return { ok: false, label, detail: `${DEFAULT_IMAGE} is out of date - the Dockerfile changed since it was built`, fix: buildCommand() };
  }
  return { ok: true, label, detail: `${DEFAULT_IMAGE} is built and current` };
}

const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

export function workerTokenStatus(env: NodeJS.ProcessEnv, recordHome: string): AdapterCheck {
  const label = "worker token";
  try {
    credentialEnvFrom(env, recordHome);
  } catch (err) {
    return { ok: false, label, detail: "not usable", fix: err instanceof Error ? err.message : String(err) };
  }
  return env[TOKEN_VAR]
    ? { ok: true, label, detail: `found in the environment (${TOKEN_VAR})` }
    : { ok: true, label, detail: `found in ${brainEnvPath(recordHome)} (mode 600)` };
}

type Run = (env: Record<string, string>) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/** One minimal real call, inside the worker's own box, on a budget of a
 * few cents: does the token still authenticate? Spends money, so doctor
 * only runs it with --live. */
const realRun: Run = async (env) => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-doctor-live-"));
  const home = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-doctor-live-home-"));
  try {
    return await runContained("claude", ["-p", "Reply with OK.", "--output-format", "json", "--max-budget-usd", "0.05"], {
      workdir: scratch,
      network: "allowed",
      image: DEFAULT_IMAGE,
      env,
      homeDir: home,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};

export async function probeWorkerToken(env: NodeJS.ProcessEnv, recordHome: string, run: Run = realRun): Promise<AdapterCheck> {
  const label = "worker token (live)";
  let credential: Record<string, string>;
  try {
    credential = credentialEnvFrom(env, recordHome).env ?? {};
  } catch (err) {
    return { ok: false, label, detail: "dead: no usable token", fix: err instanceof Error ? err.message : String(err) };
  }
  const fix = `run \`claude setup-token\` for a new token, then put it in ${brainEnvPath(recordHome)}`;
  let result: { is_error?: boolean; subtype?: string; result?: string } | undefined;
  let exitCode: number | null = null;
  let stderr = "";
  try {
    const ran = await run(credential);
    exitCode = ran.exitCode;
    stderr = ran.stderr;
    result = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "") as typeof result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, label, detail: `could not make the call: ${reason.split("\n")[0]}`, fix };
  }
  // Running out of the tiny budget still means the call authenticated.
  if (result && (!result.is_error || result.subtype === "error_max_budget_usd")) {
    return { ok: true, label, detail: "alive - the token authenticated a real call" };
  }
  const why = (result?.result ?? stderr ?? `exit ${exitCode}`).split("\n")[0];
  return { ok: false, label, detail: `dead - ${why}`, fix };
}
