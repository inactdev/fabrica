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
import { HOSTED_BASE_URL, HOSTED_CREDENTIAL_VAR } from "./openai-compatible.ts";
import { chatCompletion } from "./openai-agent/client.mjs";
import type { AgentJob } from "./openai-agent/types.ts";
import { BRAIN_SELECTION_VAR, brainEnvPath, credentialEnvFrom, directBrainSettings, DIRECT_BRAIN_NAME, DIRECT_VARS } from "./index.ts";
import type { DirectBrainSettings } from "./index.ts";

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

/** The build command as a doctor fix line (issue #130): it opens with its
 * own `cd` into the checkout, so it genuinely runs from wherever the
 * Client happens to be - said out loud, so nobody goes looking for the
 * right directory first. The note leads and the command trails, so
 * copying the fix from `cd` to the end of the line still pastes
 * something runnable. */
function buildFix(): string {
  return `run from any folder: ${buildCommand()}`;
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
  if (found === null) return { ok: false, label, detail: `${DEFAULT_IMAGE} is not built`, fix: buildFix() };
  if (found === "") {
    return { ok: false, label, detail: `${DEFAULT_IMAGE} carries no Dockerfile stamp, so whether it is current is unknown`, fix: buildFix() };
  }
  if (found !== dockerfileSha256()) {
    return { ok: false, label, detail: `${DEFAULT_IMAGE} is out of date - the Dockerfile changed since it was built`, fix: buildFix() };
  }
  return { ok: true, label, detail: `${DEFAULT_IMAGE} is built and current` };
}

/** The CLI the worker image installs, and the `RUN` line that pins its
 * version (the Dockerfile's own comment says why it is pinned at all:
 * claude-code.md's behavior notes were verified against one exact
 * version, so a rebuild must not silently install another). */
const CLI_PACKAGE = "@anthropic-ai/claude-code";

/** The version the Dockerfile pins, or null when it pins none (`@latest`,
 * or no version at all) - in which case there is nothing for an
 * installed version to disagree with. */
export function pinnedCliVersion(dockerfile: () => string = () => readFileSync(DOCKERFILE, "utf8")): string | null {
  const pin = new RegExp(`npm install -g ${CLI_PACKAGE.replace("/", "\\/")}@(\\S+)`).exec(dockerfile());
  const version = pin?.[1];
  return version === undefined || version === "latest" ? null : version;
}

function imagePresent(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** What is actually installed inside the worker image, asked of the CLI
 * itself rather than inferred from the build - `claude --version` prints
 * `2.1.222 (Claude Code)` (verified against the real binary), so the
 * leading version is what's read back. `--network none` because a
 * version needs none, and this runs inside a preflight that must not
 * reach anything. Null when the image isn't built (checked first, so
 * `docker run` is never left trying to pull a local-only image) or the
 * CLI can't answer. */
function installedCliVersion(): string | null {
  if (!imagePresent(DEFAULT_IMAGE)) return null;
  try {
    const out = execFileSync("docker", ["run", "--rm", "--network", "none", DEFAULT_IMAGE, "claude", "--version"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /\d+\.\d+\.\d+[^\s]*/.exec(out.trim())?.[0] ?? null;
  } catch {
    return null;
  }
}

/** `fabrica doctor`'s "worker CLI" line (issue #186, second half):
 * which version of the worker's own CLI is installed in the image,
 * against the version the Dockerfile pins. Fails only when a pin exists
 * and the two differ (Client ruling) - an image that can't be asked is
 * reported honestly but never fails here, because the "worker image"
 * line above it already owns that failure and would say the same thing
 * twice. */
export function workerCliVersionStatus(
  installed: () => string | null = installedCliVersion,
  pinned: () => string | null = () => pinnedCliVersion()
): AdapterCheck {
  const label = "worker CLI";
  const have = installed();
  const want = pinned();
  const pin = want === null ? "the Dockerfile pins no version" : `the Dockerfile pins ${want}`;

  if (have === null) return { ok: true, label, detail: `could not be read from ${DEFAULT_IMAGE} - ${pin}` };
  if (want === null) return { ok: true, label, detail: `${have} installed in ${DEFAULT_IMAGE} - ${pin}` };
  return have === want
    ? { ok: true, label, detail: `${have} installed in ${DEFAULT_IMAGE}, the version the Dockerfile pins` }
    : {
        ok: false,
        label,
        detail: `${DEFAULT_IMAGE} has ${have} installed, but ${pin}`,
        // The same command, printed in the same run of doctor, with the
        // same "where do I run this" question - so it says the same
        // thing (issue #130 names the worker-image line; this is the one
        // other place that prints this command).
        fix: buildFix(),
      };
}

const TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

/** The direct-API worker's own version of the check below (issue #200):
 * a different worker needs a different credential, and a Client who
 * switched brains must not be told the brain they are not using is
 * misconfigured. A credential is genuinely optional here - a local
 * server needs none - so what this really checks is that the pipe is
 * fully named: which model, at which endpoint. */
function directWorkerCheck(settings: DirectBrainSettings, recordHome: string): AdapterCheck {
  const label = "worker model";
  const baseUrl = settings.baseUrl ?? HOSTED_BASE_URL;
  if (settings.model === undefined) {
    return {
      ok: false,
      label,
      detail: `${BRAIN_SELECTION_VAR}=${DIRECT_BRAIN_NAME} is set, but no model is`,
      fix: `set ${DIRECT_VARS.model} in the environment, or add a line ${DIRECT_VARS.model}=<model> to ${brainEnvPath(recordHome)}`,
    };
  }
  const credential =
    settings.apiKey === undefined
      ? `no credential configured (a local server needs none; a hosted one needs ${HOSTED_CREDENTIAL_VAR})`
      : `a credential is configured (${HOSTED_CREDENTIAL_VAR})`;
  return { ok: true, label, detail: `${settings.model} at ${baseUrl} - ${credential}` };
}

export function workerTokenStatus(env: NodeJS.ProcessEnv, recordHome: string): AdapterCheck {
  const label = "worker token";
  let direct: DirectBrainSettings | undefined;
  try {
    direct = directBrainSettings(env, recordHome);
  } catch (err) {
    return { ok: false, label, detail: "not usable", fix: err instanceof Error ? err.message : String(err) };
  }
  if (direct !== undefined) return directWorkerCheck(direct, recordHome);

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

/** One real call to the configured API - the direct-API worker's own
 * version of the live probe below (issue #200). It is made from the host,
 * not from a box: the host already holds the credential (it is what
 * hands the relay the real value), and this call does no work and
 * touches no project. It confirms the two things a task depends on and
 * nothing else can tell the Client in advance: that the credential and
 * model are accepted, and that the provider really does report the
 * call's cost - without which every receipt from this worker would be
 * unmeasured, and rule 10 would stop all work until each was recorded by
 * hand. */
async function probeDirectWorker(
  settings: DirectBrainSettings,
  recordHome: string,
  call: typeof chatCompletion
): Promise<AdapterCheck> {
  const label = "worker model (live)";
  if (settings.model === undefined) {
    const named = directWorkerCheck(settings, recordHome);
    return { ...named, label, detail: `not checked: ${named.detail}` };
  }
  const target: Pick<AgentJob, "endpoint" | "apiKey" | "model"> = {
    endpoint: settings.baseUrl ?? HOSTED_BASE_URL,
    apiKey: settings.apiKey ?? null,
    model: settings.model,
  };
  const fix =
    `check ${DIRECT_VARS.model} and ${HOSTED_CREDENTIAL_VAR} (in the environment, or in ${brainEnvPath(recordHome)}), ` +
    `and that the model is one ${target.endpoint} actually serves`;

  let response: Record<string, unknown>;
  try {
    response = await call(target, { messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 });
  } catch (err) {
    return { ok: false, label, detail: `dead - ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`, fix };
  }

  const cost = (response.usage as { cost?: unknown } | undefined)?.cost;
  if (settings.cost !== "free" && typeof cost !== "number") {
    return {
      ok: false,
      label,
      detail: "alive, but the provider reported no cost for the call, so every receipt from it would be unmeasured",
      fix: `if ${target.endpoint} genuinely bills nothing, set ${DIRECT_VARS.cost}=free; otherwise use a target that reports its own cost`,
    };
  }
  const spent = typeof cost === "number" ? `, cost $${cost}` : " (this target bills nothing)";
  return { ok: true, label, detail: `alive - ${settings.model} answered a real call${spent}` };
}

export async function probeWorkerToken(
  env: NodeJS.ProcessEnv,
  recordHome: string,
  run: Run = realRun,
  call: typeof chatCompletion = chatCompletion
): Promise<AdapterCheck> {
  const label = "worker token (live)";
  let direct: DirectBrainSettings | undefined;
  try {
    direct = directBrainSettings(env, recordHome);
  } catch (err) {
    return { ok: false, label, detail: "dead: no usable configuration", fix: err instanceof Error ? err.message : String(err) };
  }
  if (direct !== undefined) return probeDirectWorker(direct, recordHome, call);

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
