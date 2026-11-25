// Who typed a verdict or an answer: the Client himself, or the chat
// assistant on his instruction (issue #359).
//
// The assistant is allowed to run `fabrica verdict`/`fabrica answer` now,
// but only after the Client has agreed in his own message in that
// conversation (HANDBOOK.md cases 3 and 5). CONTRACT rule 6 still holds -
// the Client ruled that a verdict he agreed to and the assistant ran is
// his - so the record has to keep saying which of the two it was, or a
// later reader has no way to tell a ruling he typed from one he merely
// approved out loud.
//
// This is attribution, not enforcement. Anything that can run `fabrica
// verdict` can also unset an environment variable, so nothing here is a
// boundary: what makes an assistant-run verdict the Client's is his own
// agreement in the conversation, and this only writes down which hand was
// on the keyboard.

/**
 * The environment sentinel `fabrica up` puts into the harness session it
 * launches, and into nothing else - so every command the assistant spawns
 * from inside that session inherits it, and the Client's own terminal
 * does not. Named once, here, and read nowhere but `ranViaAssistant`
 * below.
 *
 * Deliberately not a harness-specific name, and deliberately not derived
 * from whichever tool's own environment happens to be around: CONTRACT
 * rule 8 ("No favorite brain") keeps every harness name out of `src/`,
 * and a sentinel Fabrica sets itself is the one signal it can reason
 * about without naming anyone.
 */
export const ASSISTANT_SESSION_ENV = "FABRICA_ASSISTANT_SESSION";

/**
 * Whether this invocation should be recorded as run by the assistant.
 *
 * `override` is the explicit flag (`--via-assistant` / `--by-client`),
 * and it wins outright in both directions: a harness session `fabrica up`
 * did not start has no sentinel to detect, and the Client typing in a
 * shell that inherited one must be able to say the ruling is his. Only
 * when no flag was passed does the sentinel decide.
 *
 * Fails closed, on purpose: anything other than the exact string `"1"` -
 * unset, empty, `"0"`, `"false"`, a stray value from some unrelated tool -
 * means the Client's own. An attribution that guesses wrong in that
 * direction writes the assistant's name onto a ruling he typed himself,
 * which is the one error the record must never make.
 */
export function ranViaAssistant(env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  return env[ASSISTANT_SESSION_ENV] === "1";
}

/**
 * The environment to launch a chat harness session in: the caller's own,
 * plus the sentinel above. `fabrica up` is the only caller - this is what
 * makes the auto-detection work at all, and keeping it a function here
 * (rather than an object literal built at the launch site) is what keeps
 * the variable's name in exactly one file.
 */
export function assistantSessionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, [ASSISTANT_SESSION_ENV]: "1" };
}

/** The one line `fabrica log` and the two commands' own output use for a
 * ruling or answer the assistant ran, so the record and the terminal can
 * never word it differently. */
export const VIA_ASSISTANT_NOTE = "run by the assistant on the Client's instruction";
