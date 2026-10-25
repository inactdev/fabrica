// The glob syntax a `tests.map` pattern is written in, implemented here
// rather than taken from a dependency or from Node's own
// `path.matchesGlob`: that function is still flagged experimental, and
// the semantics below are the ones this file documents and the project's
// own `tests.map` relies on - a matcher whose rules can change under a
// Node upgrade would quietly change which tests a brief names.
//
// Three wildcards, and nothing else:
//
//   *   any run of characters within one path segment (never crosses "/")
//   ?   exactly one character within one path segment
//   **  any run of characters, crossing "/" freely
//
// `**/` additionally matches no directory at all, so `**/*.test.ts`
// covers `foo.test.ts` at the root as well as `src/cli/foo.test.ts`.
// Everything else in a pattern is literal, including `.`, so
// `src/foreman/do.ts` means that exact file and not `src/foremanXdo.ts`.
//
// Paths are always project-relative and always use "/" - the one place
// that is enforced is `match.ts`, which normalizes before matching.

const CACHE = new Map<string, RegExp>();

/** Whether `path` (project-relative, "/"-separated) is covered by
 * `pattern`. The whole path must match, not a prefix of it. */
export function matchesGlob(pattern: string, path: string): boolean {
  return globRegExp(pattern).test(path);
}

/** `pattern` as an anchored RegExp. Cached: a round matches every entry
 * against every touched file, so the same handful of patterns are
 * compiled over and over otherwise. */
function globRegExp(pattern: string): RegExp {
  const cached = CACHE.get(pattern);
  if (cached !== undefined) return cached;

  let source = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        if (pattern[at + 2] === "/") {
          // `**/` - any number of directories, including none at all.
          source += "(?:[^/]*/)*";
          at += 2;
        } else {
          source += ".*";
          at += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeLiteral(char);
  }

  const expression = new RegExp(`^${source}$`);
  CACHE.set(pattern, expression);
  return expression;
}

/** One literal character, safe to drop into a RegExp source. */
function escapeLiteral(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
