// Which file a repository declares its own language version in, and the
// build argument that carries it into an image build (issue #355).
//
// The problem this closes: `Dockerfile.inspector` used to name a version
// in its `FROM` line, and the repository declares the same version in a
// file of its own. When the repository moved - gifthealth's `main` went
// from ruby 3.4.8 to 3.4.13 - every task that rebased past it failed at
// `bundle install` ("your Ruby version is 3.4.8, but your Gemfile
// specified 3.4.13") with nothing wrong with the work. One of the two
// declarations has to follow the other, and the repository's own file is
// the one with a claim to being right.
//
// So the Dockerfile names a build argument instead
// (`ARG RUBY_VERSION=3.4.8`, `FROM ruby:${RUBY_VERSION}`), and
// `.inspector.json` says which file supplies it. Inspector reads that
// file at the commit under check; Fabrica reads it out of the build
// context its own machine-image build already copies the manifest and
// the lockfile from (see this module's README).
//
// Nothing here reads a registry, runs docker, or decides anything: it
// answers "what does this repository declare, and does this image
// reference carry a version that declaration could supply". The writers
// (`src/register/`), the reader (`src/projectimage/`), the conversion
// (`convert.ts`) and `fabrica doctor`'s own line all ask the same
// question of the same table, so no two of them can answer it
// differently.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One `buildArgs` entry's value, as `.inspector.json` carries it:
 * either a file on its own, or a file plus the pattern that picks the
 * version out of it. Inspector's own key (task 1 of issue #355's pair);
 * spelled once here and used by the writer and every reader. */
export interface BuildArgSource {
  /** Repository-relative path, e.g. `.ruby-version`, `go.mod`. */
  file: string;
  /**
   * The pattern that picks the value out of that file, matched **one
   * trimmed line at a time**, first match winning, taking the first
   * capture group (or the whole match when the pattern has none).
   *
   * Line at a time, and never a `(?m)` inline flag, on purpose: Fabrica
   * matches these with JavaScript's engine and Inspector with Go's RE2,
   * and `(?m)` is a syntax error in the first. A pattern anchored with
   * `^`/`$` against one trimmed line means the same thing in both.
   *
   * Absent means the whole file: its first non-empty line, trimmed.
   */
  pattern?: string;
}

/** Every `buildArgs` entry a config declares, by argument name. */
export type DeclaredBuildArgs = Record<string, BuildArgSource>;

/** Reads a repository-relative file, or returns null when it is not
 * there. The one seam between this module and where the files actually
 * are - a checkout on disk, or a commit read through git. */
export type ReadRepoFile = (path: string) => string | null;

/** A repository-relative file's contents from a directory on disk, or
 * null when it is not there. */
export function readFileIn(dir: string): ReadRepoFile {
  return (path: string) => {
    try {
      return readFileSync(join(dir, path), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * One language family: the images whose tag is that language's own
 * version, the build argument the `FROM` line carries, and the files the
 * repository may declare the version in - **in order**, primary first
 * (Client's clarification: `.ruby-version`, `.node-version`,
 * `.python-version` and `go.mod`'s `go` line first, with `.nvmrc` and
 * `.tool-versions` as fallbacks when the primary is absent). Package
 * manager versions (`BUNDLED WITH`, `packageManager`) are deliberately
 * out of scope for now, by the same clarification.
 */
export interface VersionFamily {
  /** What the notes and messages call it. */
  label: string;
  /** The build argument's name. */
  arg: string;
  /**
   * Image repositories whose tag is this language's version. Matched on
   * the whole repository name, so `ruby` and `cimg/ruby` are two
   * entries rather than a suffix match - `my-own/notruby` must not
   * match, and `ruby/bundler` must not either.
   */
  images: readonly string[];
  /** Where the repository may declare it, primary first. */
  files: readonly BuildArgSource[];
}

/** `.tool-versions` is asdf/mise's, one `<plugin> <version>` line per
 * tool - so every family reads the same file with its own plugin name. */
const TOOL_VERSIONS = ".tool-versions";

/** A version as these files spell one: starts with a digit, no
 * whitespace. Deliberately not `\d+\.\d+\.\d+` - `3.4` is a real pin a
 * real tag exists for, and judging which pins are precise enough is not
 * this module's business. */
const VERSION = "([0-9][^\\s]*)";

export const VERSION_FAMILIES: readonly VersionFamily[] = [
  {
    label: "ruby",
    arg: "RUBY_VERSION",
    images: ["ruby", "cimg/ruby"],
    files: [
      // rbenv writes a bare `3.4.13`; some tools write `ruby-3.4.13`.
      // Both are the same declaration, and only the version is a tag.
      { file: ".ruby-version", pattern: `^(?:ruby-)?${VERSION}$` },
      { file: TOOL_VERSIONS, pattern: `^ruby[ \\t]+${VERSION}` },
    ],
  },
  {
    label: "node",
    arg: "NODE_VERSION",
    images: ["node", "cimg/node"],
    files: [
      { file: ".node-version", pattern: `^v?${VERSION}$` },
      // `.nvmrc` holds a version, or an alias (`lts/*`, `node`). An
      // alias matches nothing here, which is the right answer: it names
      // no tag, so there is nothing to pass to a build.
      { file: ".nvmrc", pattern: `^v?${VERSION}$` },
      // asdf's plugin for node is spelled `nodejs`; mise accepts both.
      { file: TOOL_VERSIONS, pattern: `^node(?:js)?[ \\t]+v?${VERSION}` },
    ],
  },
  {
    label: "python",
    arg: "PYTHON_VERSION",
    images: ["python", "cimg/python"],
    files: [
      // pyenv also writes `pypy3.10-7.3.15` and `system` here. Neither
      // starts with a digit, so neither is read as a version.
      { file: ".python-version", pattern: `^${VERSION}$` },
      { file: TOOL_VERSIONS, pattern: `^python[ \\t]+${VERSION}` },
    ],
  },
  {
    label: "go",
    arg: "GO_VERSION",
    images: ["golang", "cimg/go"],
    files: [
      // go.mod's own `go` line - the version the module is written for,
      // which is what the toolchain in the image has to satisfy.
      { file: "go.mod", pattern: `^go[ \\t]+${VERSION}` },
      { file: TOOL_VERSIONS, pattern: `^golang[ \\t]+${VERSION}` },
    ],
  },
];

/** The family one build argument name belongs to, or null for a name
 * nothing here knows - a `buildArgs` entry the Client wrote himself. */
export function familyOfArg(arg: string): VersionFamily | null {
  return VERSION_FAMILIES.find((family) => family.arg === arg) ?? null;
}

/**
 * An image reference split into the three parts a build argument
 * replaces the middle of: `ruby:3.4.8-slim` is `ruby`, `3.4.8`,
 * `-slim`.
 *
 * Null for anything whose version is not in the tag at all, and those
 * are the references that must never be rewritten: a digest pin
 * (`ruby@sha256:...`, where the tag says nothing and the digest says
 * everything), a moving tag (`ruby:latest`, `ruby:slim`), a reference
 * with no tag, and one already carrying a variable.
 */
export function splitImageVersion(ref: string): { image: string; version: string; suffix: string } | null {
  const trimmed = ref.trim();
  if (trimmed.includes("$") || trimmed.includes("@")) return null;
  // A registry host may carry a port (`host:5000/ruby:3.4.8`), so the
  // tag is after the LAST colon, and only when that colon is after the
  // last slash.
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1 || colon < trimmed.lastIndexOf("/")) return null;
  const image = trimmed.slice(0, colon);
  const tag = trimmed.slice(colon + 1);
  const version = /^([0-9][0-9.]*[0-9]|[0-9])(-[A-Za-z0-9._-]+)?$/.exec(tag);
  if (version === null) return null;
  return { image, version: version[1], suffix: version[2] ?? "" };
}

/** The family an image reference belongs to, or null when its
 * repository is not one whose tag is a language version. */
export function familyOfImage(image: string): VersionFamily | null {
  const name = image.trim().toLowerCase();
  return VERSION_FAMILIES.find((family) => family.images.includes(name)) ?? null;
}

/** What one `buildArgs` source says, read out of a repository. */
export interface DeclaredVersion extends BuildArgSource {
  value: string;
}

/**
 * The version this repository declares for a family, from the first of
 * that family's files that both exists and names one - or null when it
 * declares none anywhere.
 *
 * "First that names one", not "first that exists": a `.nvmrc` holding
 * `lts/*` exists and declares no version, and falling through to
 * `.tool-versions` is strictly better than reporting nothing. The
 * primary-first order is the Client's own.
 */
export function declaredVersionFor(family: VersionFamily, read: ReadRepoFile): DeclaredVersion | null {
  for (const source of family.files) {
    const text = read(source.file);
    if (text === null) continue;
    const value = valueFromText(text, source.pattern);
    if (value === null) continue;
    return { ...source, value };
  }
  return null;
}

/**
 * One `buildArgs` source's value in a file's text: the first capture
 * group of the first trimmed line the pattern matches (the whole match
 * when the pattern has no group), or the first non-empty trimmed line
 * when there is no pattern at all.
 *
 * Null for a file that names nothing - empty, or no line matching.
 * A pattern that will not compile is also null rather than a thrown
 * error: a `buildArgs` entry is a thing the Client can hand-edit, and a
 * build is not the place to find out.
 */
export function valueFromText(text: string, pattern?: string): string | null {
  const lines = text.split("\n").map((line) => line.trim());
  if (pattern === undefined) {
    return lines.find((line) => line.length > 0) ?? null;
  }
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern);
  } catch {
    return null;
  }
  for (const line of lines) {
    if (line.length === 0) continue;
    const match = regexp.exec(line);
    if (match === null) continue;
    const value = match[1] ?? match[0];
    if (value.length > 0) return value;
  }
  return null;
}

/** How long a value may be, and what it may hold. It ends up in a
 * Docker tag and in a `docker build` argv, so a value that is not one is
 * refused by name rather than passed and hoped for. */
const VALUE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_MAX_LENGTH = 128;

/** Whether a resolved value is one that may be passed to a build at
 * all. */
export function usableValue(value: string): boolean {
  return value.length <= VALUE_MAX_LENGTH && VALUE_SHAPE.test(value);
}

/** Why a value was refused, for a message that has to say. */
export function unusableValueReason(value: string): string {
  if (value.length > VALUE_MAX_LENGTH) return `it is ${value.length} characters long, over the ${VALUE_MAX_LENGTH} allowed`;
  return `"${value}" is not a Docker tag (letters, digits, and . _ - only, starting with a letter or digit)`;
}

/** The whole question `fabrica register` and the conversion both ask of
 * one `FROM` reference: is this a version a file in the repository
 * declares, and if so, under which argument, from which file? */
export interface VersionArgFor {
  family: VersionFamily;
  /** The `FROM` reference as it stands, split up. */
  image: { image: string; version: string; suffix: string };
  /** What the repository declares, and where. */
  declared: DeclaredVersion;
}

/**
 * The build argument an image reference should carry, or null when it
 * should carry none - its repository is not one whose tag is a language
 * version, its tag holds no version to replace, or this repository
 * declares no version for that language anywhere.
 *
 * Deliberately **not** conditional on the two versions agreeing. The
 * case the issue is about is exactly the one where they disagree
 * (`FROM ruby:3.4.8` against a `.ruby-version` that now says 3.4.13),
 * and the whole point is that the file wins.
 */
export function versionArgFor(ref: string, read: ReadRepoFile): VersionArgFor | null {
  const image = splitImageVersion(ref);
  if (image === null) return null;
  const family = familyOfImage(image.image);
  if (family === null) return null;
  const declared = declaredVersionFor(family, read);
  if (declared === null || !usableValue(declared.value)) return null;
  return { family, image, declared };
}

/** The `.inspector.json` entry a `VersionArgFor` means - the half that
 * travels to Inspector. */
export function buildArgEntry(found: VersionArgFor): DeclaredBuildArgs {
  const { pattern, file } = found.declared;
  return { [found.family.arg]: pattern === undefined ? { file } : { file, pattern } };
}

/** The `FROM` reference in its argument form: `ruby:${RUBY_VERSION}`,
 * keeping whatever the tag carried after the version (`-slim`). */
export function argFormRef(found: VersionArgFor): string {
  return `${found.image.image}:\${${found.family.arg}}${found.image.suffix}`;
}
