// What kind of file a touched path is: documentation, a test, or code.
// One place, because the answer decides what every delivery, status row
// and brief says about the map (`match.ts` is its only caller inside
// this module), and two copies of "is this documentation" would drift
// the same way three copies of the wording would.
//
// Issue #305, in the Client's own words: "files that are documentation
// by extension or location (*.md, notes/**, docs/**, LICENSE,
// .gitignore and the other dotfiles at the root) are never counted as
// unmapped", and "a touched file that is itself a test is mapped to
// itself". Both are reporting only - nothing here changes what makes a
// task green, and the whole suite still runs either way.

/** `<stem>.test.<ext>` or `<stem>.spec.<ext>` - the two spellings of the
 * colocated convention. Both are recognized; a project using only one
 * simply has no matches for the other. Shared with `generate.ts`, which
 * needs the captures to name the source file beside a test. */
export const TEST_FILENAME = /^(.+)\.(?:test|spec)\.([^.]+)$/;

/** Directory names whose contents are documentation wherever they sit -
 * at the root or nested in a subproject (`integrations/live-view/docs/`).
 * The Client's ruling is "notes/ and docs/ at any depth". */
const DOCUMENTATION_DIRECTORIES: readonly string[] = ["notes", "docs"];

/** Root files that are documentation by name rather than by extension.
 * The Client named `LICENSE`; the two alternate spellings of the same
 * file are included because a licence text is documentation under any of
 * them, and reporting one as "a code file with no test" would be noise
 * nobody can act on. Root only - a `LICENSE` fixture nested inside a
 * test's own tree is not this. */
const ROOT_DOCUMENTS = /^licen[sc]e(\.txt)?$/i;

/** A touched file as the map's patterns are written: project-relative,
 * "/"-separated, no leading "./". `git diff --name-only` already gives
 * this shape; the normalization is for a hand-written caller and for
 * Windows-style separators that would otherwise match nothing. */
export function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Whether this path is itself a test file, which the Client ruled
 * covers itself - so a newly added test nobody has mapped yet is never
 * reported as a file with no test. */
export function isTestFile(file: string): boolean {
  return TEST_FILENAME.test(basename(normalizeFile(file)));
}

/**
 * Whether this path is documentation, and therefore needs no test and is
 * never counted as unmapped:
 *
 *   - any `*.md`, at any depth;
 *   - anything under a `notes/` or `docs/` directory, at any depth;
 *   - at the repository root only, every dot-prefixed file (`.gitignore`,
 *     `.npmignore`, `.node-version`) and `LICENSE`.
 *
 * Root-only for the dotfiles because a dotted path deeper in a tree is
 * ordinarily configuration a change can genuinely break (a harness's
 * `skill/<harness>/settings.json` lives beside one), while the root's are
 * the repository's own housekeeping. A dotted *directory* never reaches
 * here at all: `generate.ts` does not walk one, and nothing in a
 * project's suite covers it.
 */
export function isDocumentation(file: string): boolean {
  const path = normalizeFile(file);
  const segments = path.split("/");
  const name = segments[segments.length - 1];

  if (/\.md$/i.test(name)) return true;
  if (segments.slice(0, -1).some((segment) => DOCUMENTATION_DIRECTORIES.includes(segment))) return true;
  if (segments.length > 1) return false;
  return name.startsWith(".") || ROOT_DOCUMENTS.test(name);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
