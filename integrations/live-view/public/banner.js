// The banner strip, loaded by every page (index.html, history.html,
// task.html, review.html). Two things can make a page here quietly lie,
// and each gets a banner nobody can miss:
//
//   1. The server answering this page is running older code than the
//      checkout on disk - a live view left over from before a merge.
//      /api/version is the commit THIS PROCESS started from, captured
//      once at startup and never re-read; /api/checkout is what is on
//      disk right now. The two disagreeing is the whole signal.
//   2. The record home's projects.toml is there but will not parse, so
//      every cap and every registered project this page shows is
//      actually a default standing in for a number nobody set
//      (/api/config-problem). The task list keeps working - it comes
//      from the record, which needs no config - which is exactly why
//      this has to be said out loud.
//
// Deliberately self-contained: it builds its own DOM, polls its own
// endpoints, and needs no wiring in app.js/task.js/review.js. One script
// loaded by four pages beats three renderers that each have to stay in
// step with this one (and with each other).
//
// /api/version is fetched ONCE: a running process's startup commit
// cannot change while it is answering requests. /api/checkout and
// /api/config-problem are polled on the same 2-second tick the pages
// themselves use, so a banner appears within one poll of the checkout
// moving or the file breaking.
//
// Wrapped in an IIFE so this script declares NOTHING in the global
// scope. Classic scripts on one page share a single global lexical
// environment, so a top-level `const` here and a top-level `const` of
// the same name in app.js/review.js/task.js (all four of these files
// want a `POLL_MS`) is a redeclaration SyntaxError - thrown before a
// single statement of the page's own script runs, leaving the page on
// its placeholder markup with every request answered 200 and nothing
// wrong anywhere a server log could show it. page-scripts.test.ts loads
// every page's scripts into one shared scope the way a browser does, so
// a collision like that fails the suite instead of only the browser.

(() => {
  const POLL_MS = 2000;

  // Mirrors integrations/live-view/display.ts's shortCommit/stalenessNotice
  // and configProblemNotice - duplicated here for the same reason app.js
  // duplicates formatAge: a plain script with no build step can't import
  // the tested .ts copy.
  function shortCommit(sha) {
    return sha.slice(0, 12);
  }

  function stalenessNotice(serverCommit, checkoutCommit) {
    if (typeof serverCommit !== "string" || typeof checkoutCommit !== "string") return null;
    if (serverCommit === checkoutCommit) return null;
    return (
      `This page is served by an older copy of Fabrica: the server is running ${shortCommit(serverCommit)}, ` +
      `the checkout is on ${shortCommit(checkoutCommit)}. Run \`fabrica update\` to restart it.`
    );
  }

  function configProblemNotice(problem) {
    const message = problem && problem.message;
    if (typeof message !== "string" || message.trim().length === 0) return null;
    return `projects.toml could not be read, so caps and projects are unknown: ${message}`;
  }

  // One container, created on first use and kept for the page's life, with
  // one fixed slot per banner kind - so a banner that stays true across
  // polls is never torn down and rebuilt under someone reading it (the same
  // rule app.js's row updates follow).
  const slots = new Map();

  function slot(kind) {
    let node = slots.get(kind);
    if (node) return node;
    let strip = document.getElementById("fabrica-banners");
    if (!strip) {
      strip = document.createElement("div");
      strip.id = "fabrica-banners";
      strip.className = "banners";
      document.body.insertBefore(strip, document.body.firstChild);
    }
    node = document.createElement("div");
    node.className = `banner banner-${kind}`;
    node.setAttribute("role", "alert");
    node.hidden = true;
    strip.appendChild(node);
    slots.set(kind, node);
    return node;
  }

  function setBanner(kind, message) {
    const node = slot(kind);
    const text = message === null ? "" : message;
    if (node.textContent !== text) node.textContent = text;
    const hidden = message === null;
    if (node.hidden !== hidden) node.hidden = hidden;
  }

  async function getJson(path) {
    try {
      const res = await fetch(path);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      // A poll that cannot reach its own server says nothing: the page is
      // already visibly frozen in that case, and a banner about it would
      // only add noise.
      return null;
    }
  }

  // Read once, up front. A null here (an installed copy with no recorded
  // commit, a git lookup that failed, a request that never landed) leaves
  // the staleness comparison unmakeable, and stalenessNotice says nothing
  // rather than guessing.
  let serverCommit = null;

  async function readServerCommit() {
    const body = await getJson("/api/version");
    serverCommit = body && typeof body.commit === "string" ? body.commit : null;
  }

  async function poll() {
    const [checkout, config] = await Promise.all([getJson("/api/checkout"), getJson("/api/config-problem")]);
    const checkoutCommit = checkout && typeof checkout.commit === "string" ? checkout.commit : null;
    setBanner("stale", stalenessNotice(serverCommit, checkoutCommit));
    setBanner("config", configProblemNotice(config && config.problem));
  }

  readServerCommit().then(poll);
  setInterval(poll, POLL_MS);
})();
