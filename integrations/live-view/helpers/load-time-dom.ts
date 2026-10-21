// A load-time-only DOM for page-scripts.test.ts.
//
// The pages under integrations/live-view/public are plain classic scripts
// with no build step, so the only way to prove two of them can share one
// page is to actually evaluate them the way a browser does - in order,
// into one shared global scope. That needs a `document` for them to load
// against, and this is it.
//
// Deliberately load-time only. What it has to get right is what a page
// does *synchronously* while its scripts are being evaluated - task.js
// wires its filter buttons and its tail toggle right there at the top
// level - because every renderer in these scripts runs behind an
// `await fetch(...)`, which page-scripts.test.ts holds open forever on
// purpose. The node-building and attribute surface is complete enough that
// a page pointed at a real server does render against it (checked by hand
// while fixing the collision this file guards), but that is not a promise
// this file makes: it is not a browser and must not grow into one. jsdom
// is the answer the day a test here needs to assert on rendered output.
//
// One rule, from this project's own "a fake must never drift quietly"
// convention: anything this DOM does not implement FAILS LOUDLY rather
// than answering with a plausible nothing. `querySelectorAll` throws on
// selector syntax it does not support, because an unsupported selector
// silently matching zero elements would read as "the page has no filter
// buttons" - a passing test for the wrong reason.

/** One parsed element. Text is held as a child string, not a node, since
 * nothing at load time walks text nodes. */
interface ElementNode {
  tag: string;
  attrs: Map<string, string>;
  children: (ElementNode | TextNode)[];
  parent: ElementNode | null;
}

interface TextNode {
  text: string;
  parent: ElementNode | null;
}

function isElement(node: ElementNode | TextNode): node is ElementNode {
  return "tag" in node;
}

/** HTML elements that never have a closing tag. The four pages here use
 * meta/link only, but the whole standard list costs nothing and stops a
 * future `<br>` or `<img>` from swallowing the rest of the document. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text, not markup - an inline `<script>`'s
 * body must reach us verbatim, not be parsed as tags. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

const ATTR_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(ATTR_PATTERN)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/**
 * Parse a page's HTML into an element tree.
 *
 * A small hand-rolled tokenizer rather than a dependency: these four files
 * are hand-written, well-formed HTML in this same repository, and the only
 * facts anything here needs out of them are ids, classes, data attributes
 * and the script tags in document order. It handles doctype, comments,
 * void elements, raw-text elements and quoted/unquoted attributes, and it
 * ignores a stray close tag rather than guessing at a repair.
 */
export function parseHtml(html: string): ElementNode {
  const root: ElementNode = { tag: "#document", attrs: new Map(), children: [], parent: null };
  let open: ElementNode = root;
  let i = 0;

  const append = (node: ElementNode | TextNode) => {
    node.parent = open;
    open.children.push(node);
  };

  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next === -1) {
      const text = html.slice(i);
      if (text.trim() !== "") append({ text, parent: null });
      break;
    }
    if (next > i) {
      const text = html.slice(i, next);
      if (text.trim() !== "") append({ text, parent: null });
    }
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const end = html.indexOf(">", next);
    if (end === -1) {
      append({ text: html.slice(next), parent: null });
      break;
    }
    const raw = html.slice(next + 1, end).trim();
    i = end + 1;
    if (raw.startsWith("/")) {
      const tag = raw.slice(1).trim().toLowerCase();
      // Climb to the nearest matching open element. A close tag matching
      // nothing is dropped, which is also what a browser does with one.
      let node: ElementNode | null = open;
      while (node && node.tag !== tag) node = node.parent;
      if (node && node.parent) open = node.parent;
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const inner = selfClosing ? raw.slice(0, -1) : raw;
    const space = inner.search(/\s/);
    const tag = (space === -1 ? inner : inner.slice(0, space)).toLowerCase();
    const attrs = parseAttrs(space === -1 ? "" : inner.slice(space));
    const node: ElementNode = { tag, attrs, children: [], parent: null };
    append(node);
    if (selfClosing || VOID_TAGS.has(tag)) continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      const closeAt = html.toLowerCase().indexOf(`</${tag}`, i);
      const bodyEnd = closeAt === -1 ? html.length : closeAt;
      const text = html.slice(i, bodyEnd);
      if (text !== "") {
        const textNode: TextNode = { text, parent: node };
        node.children.push(textNode);
      }
      i = bodyEnd;
      if (closeAt !== -1) {
        const closeEnd = html.indexOf(">", closeAt);
        i = closeEnd === -1 ? html.length : closeEnd + 1;
      }
      continue;
    }
    open = node;
  }
  return root;
}

function descendants(node: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (parent: ElementNode) => {
    for (const child of parent.children) {
      if (!isElement(child)) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export interface ScriptTag {
  /** The `src` attribute verbatim, or null for an inline script. */
  src: string | null;
  /** An inline script's source text, or null for one with a `src`. */
  inline: string | null;
}

/** Every `<script>` the document references, in document order - exactly
 * the order a browser evaluates them in for plain (non-module, non-async,
 * non-defer) script tags. A `type` other than a classic script's is
 * reported too rather than skipped, so the caller decides, not this. */
export function scriptTags(document: ElementNode): ScriptTag[] {
  return descendants(document)
    .filter((node) => node.tag === "script")
    .map((node) => {
      const src = node.attrs.get("src") ?? null;
      const text = node.children.filter((child): child is TextNode => !isElement(child));
      return { src, inline: src === null ? text.map((child) => child.text).join("") : null };
    });
}

// --- the DOM surface the scripts actually touch -----------------------

const SIMPLE_SELECTOR = /^(?:[a-zA-Z][-a-zA-Z0-9]*|\.[-_a-zA-Z0-9]+|#[-_a-zA-Z0-9]+|\[[-_a-zA-Z0-9]+(?:=(?:"[^"]*"|'[^']*'))?\])+$/;
const SELECTOR_PART = /[a-zA-Z][-a-zA-Z0-9]*|\.[-_a-zA-Z0-9]+|#[-_a-zA-Z0-9]+|\[[-_a-zA-Z0-9]+(?:=(?:"[^"]*"|'[^']*'))?\]/g;

function classesOf(element: FakeElement): Set<string> {
  return new Set(
    (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((name) => name !== "")
  );
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  for (const part of compound.match(SELECTOR_PART) ?? []) {
    if (part.startsWith(".")) {
      if (!classesOf(element).has(part.slice(1))) return false;
    } else if (part.startsWith("#")) {
      if (element.getAttribute("id") !== part.slice(1)) return false;
    } else if (part.startsWith("[")) {
      const body = part.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq === -1) {
        if (element.getAttribute(body) === null) return false;
      } else {
        const name = body.slice(0, eq);
        const want = body.slice(eq + 1).replace(/^["']|["']$/g, "");
        if (element.getAttribute(name) !== want) return false;
      }
    } else if (element.tagName.toLowerCase() !== part.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/** A single element. Only the members a page touches while its scripts are
 * being evaluated are real; an unimplemented member is simply absent, so
 * reaching for one is a loud TypeError rather than a silent undefined. */
export class FakeElement {
  readonly tagName: string;
  readonly childNodes: (FakeElement | FakeText)[] = [];
  parentNode: FakeElement | null = null;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  /** Every `scrollIntoView` call, in order - a page's load-time scroll is
   * observable rather than a no-op, in case a test wants to assert on it. */
  readonly scrollCalls: unknown[] = [];
  private readonly attrs = new Map<string, string>();

  constructor(
    tagName: string,
    private readonly owner: FakeDocument
  ) {
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.childNodes[0] ?? null;
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get hidden(): boolean {
    return this.getAttribute("hidden") !== null;
  }

  set hidden(value: boolean) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  get textContent(): string {
    return this.childNodes
      .map((node) => (node instanceof FakeElement ? node.textContent : node.data))
      .join("");
  }

  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== "") this.appendChild(this.owner.createTextNode(value));
  }

  get dataset(): Record<string, string | undefined> {
    const data: Record<string, string> = {};
    for (const [name, value] of this.attrs) {
      if (!name.startsWith("data-")) continue;
      data[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return data;
  }

  get classList() {
    const write = (names: Set<string>) => this.setAttribute("class", [...names].join(" "));
    return {
      add: (name: string) => write(classesOf(this).add(name)),
      remove: (name: string) => {
        const names = classesOf(this);
        names.delete(name);
        write(names);
      },
      contains: (name: string) => classesOf(this).has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !classesOf(this).has(name) : force;
        const names = classesOf(this);
        if (on) names.add(name);
        else names.delete(name);
        write(names);
        return on;
      },
    };
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const key = name.toLowerCase();
    this.attrs.set(key, String(value));
    if (key === "id") this.owner.index(this);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    if (child instanceof FakeElement) this.owner.indexTree(child);
    return child;
  }

  insertBefore<T extends FakeElement | FakeText>(child: T, before: FakeElement | FakeText | null): T {
    if (before === null) return this.appendChild(child);
    this.removeChild(child);
    const at = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(at === -1 ? this.childNodes.length : at, 0, child);
    if (child instanceof FakeElement) this.owner.indexTree(child);
    return child;
  }

  replaceChildren(...children: (FakeElement | FakeText)[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const child of children) this.appendChild(child);
  }

  removeChild(child: FakeElement | FakeText): void {
    const at = this.childNodes.indexOf(child);
    if (at === -1) return;
    this.childNodes.splice(at, 1);
    child.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(handler);
    else this.listeners.set(type, [handler]);
  }

  scrollIntoView(options?: unknown): void {
    this.scrollCalls.push(options ?? null);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.owner.search(this, selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}

  get textContent(): string {
    return this.data;
  }
}

export class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  readonly head: FakeElement;
  private readonly byId = new Map<string, FakeElement>();

  constructor(html: string) {
    const parsed = parseHtml(html);
    this.documentElement = this.build(find(parsed, "html") ?? parsed);
    this.head = this.documentElement.querySelector("head") ?? new FakeElement("head", this);
    this.body = this.documentElement.querySelector("body") ?? new FakeElement("body", this);
  }

  private build(node: ReturnType<typeof parseHtml>): FakeElement {
    const element = new FakeElement(node.tag === "#document" ? "html" : node.tag, this);
    for (const [name, value] of node.attrs) element.setAttribute(name, value);
    for (const child of node.children) {
      if (isElement(child)) element.appendChild(this.build(child));
      else element.appendChild(new FakeText(child.text));
    }
    return element;
  }

  index(element: FakeElement): void {
    if (element.id !== "") this.byId.set(element.id, element);
  }

  indexTree(element: FakeElement): void {
    this.index(element);
    for (const child of element.children) this.indexTree(child);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    const found = this.byId.get(id);
    // A node removed from the tree must stop answering, the same way a
    // real getElementById only ever sees what is still in the document.
    if (!found) return null;
    let node: FakeElement | null = found;
    while (node) {
      if (node === this.documentElement) return found;
      node = node.parentNode;
    }
    this.byId.delete(id);
    return null;
  }

  getElementsByClassName(name: string): FakeElement[] {
    return this.search(this.documentElement, `.${name}`);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.search(this.documentElement, selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * Descendant-combinator selectors only: a sequence of compound
   * selectors built from tag names, `.class`, `#id` and `[attr]` /
   * `[attr="value"]`, separated by whitespace.
   *
   * Anything else THROWS. That is the point: this is a fake, and a fake
   * that answers an unsupported selector with an empty list turns a real
   * gap into a quietly passing test.
   */
  search(root: FakeElement, selector: string): FakeElement[] {
    const compounds = selector.trim().split(/\s+/);
    for (const compound of compounds) {
      if (!SIMPLE_SELECTOR.test(compound)) {
        throw new Error(
          `load-time-dom: querySelectorAll does not implement the selector ${JSON.stringify(selector)} ` +
            `(the unsupported part is ${JSON.stringify(compound)}). Extend helpers/load-time-dom.ts ` +
            `rather than working around it - a fake that answers "nothing matched" here would hide a real gap.`
        );
      }
    }
    let scope: FakeElement[] = [root];
    for (const compound of compounds) {
      const next: FakeElement[] = [];
      for (const element of scope) {
        for (const candidate of allDescendants(element)) {
          if (matchesCompound(candidate, compound) && !next.includes(candidate)) next.push(candidate);
        }
      }
      scope = next;
    }
    return scope;
  }
}

function allDescendants(element: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of element.children) {
    out.push(child);
    out.push(...allDescendants(child));
  }
  return out;
}

function find(node: ReturnType<typeof parseHtml>, tag: string): ReturnType<typeof parseHtml> | null {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (child.tag === tag) return child;
    const nested = find(child, tag);
    if (nested) return nested;
  }
  return null;
}
