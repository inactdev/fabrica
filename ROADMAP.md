# ROADMAP — from the first commit to Amy

Fair catch: this didn't exist until now. Here's the whole path in one
place, in plain language.

There are no dates on purpose. Your own rule drives the pace: build the
smallest useful version, live with it, let it prove itself, then let it
carry the next thing. Each phase has a plain "done when," and a phase
doesn't start until the one before it is genuinely done. The middle
phases (3, 4, 5) may swap order depending on what daily use teaches us —
everything in this file except the rules (CONTRACT.md) is allowed to
change.

## Phase 0 — The rules, as code

The first thing committed to the repository is the contract test suite:
the small programs that enforce every rule in CONTRACT.md. They all fail
("red") at first — of course they do, the tool doesn't exist yet. That's
the point: from the very first commit, "correct" is defined by running
code, not by anyone's interpretation of a document.

**Done when:** you've read and approved the contract; the tests exist,
run, and are all red; you've skimmed them and believe they check what the
contract says.

## Phase 1 — The workhorse, version one

The tool itself: Fabrica. One task at a time: you hand it a
written task; it asks first when the task is unclear; it works on a
throwaway copy of the project; it proves the work with the project's own
checks; it delivers honestly — how sure it is, what it assumed, what's
missing, and the proof; it writes every step down; and it won't close the
task until you give your ruling. No tactics yet — one honest attempt per
task, nothing fancy. It ships with an operator's skill — an agent-facing
manual — so from the first day you can simply talk: tell the AI you
already use what you want, and it forms the exact Fabrica command for
you. The commands are the machine's language, never your homework.

**Done when:** every contract test is green, and you have run one real
task of your own through it end to end, ruling included.

## Phase 2 — Live with it

Use it on real work, every day, alongside whatever you use today. Keep
giving rulings. Let the written record pile up — that pile is the future
training material. Keep a running list of rough edges.

**Done when:** it's your default for most day-to-day tasks and the old
setup is the exception, not the rule.

## Phase 3 — The playbook (how hard to try)

The tool gains moves it can use per task: several attempts with a
comparison at the end, cheaper AI brains (models) for easy things and
stronger ones for hard things, retry rules, when to ask versus proceed —
all inside a spending limit you set once. Brains come from your
subscriptions first: the flat-rate pipes you already pay for, through
their officially approved harnesses. Per-token API pipes stay closed
unless you deliberately open one, behind a cap that can be zero. The
specific moves named here are examples, not promises; the point is that
tactics become options the tool holds, and it picks sensibly.

**Done when:** you genuinely stop thinking about model choice or effort
level on a per-task basis.

## Phase 4 — Awareness

Ask "how's that thing going?" about anything and get a real answer,
instantly. It speaks up on its own when something finishes, gets stuck,
or needs you.

Adopted shape (Aug 2026, from SSSF's trace design): the permanent record
stays plain files; a disposable database mirror (SQLite) of it feeds a
read-only live view in the browser — every run as a timeline, click any
lane for the fine grain (brief, model, transcript, receipts, cost), one
simple poll query — plus heartbeat events so a silent worker shows up
as "quiet too long" instead of as ambiguity. Requirement (Aug 2026):
reachable from anywhere the Client has an internet connection — phone
included — over a private path (his own devices, not the public web),
with spend-at-a-glance front and center.

**Done when:** nothing about work-in-flight depends on your memory.

## Phase 5 — The gym (it improves itself)

Overnight, on copies of past work only — never on live work — it
re-attempts tasks it did poorly, tries different moves, grades itself
using the project checks plus your recorded rulings as the answer key,
and updates its own playbook. Every playbook change is written down for
you to review, and a nightly allowance caps what it can spend.

Worth noticing: it has been taking notes since Phase 1. The gym is just
the day it starts training on them.

**Done when:** the playbook is getting measurably better without you
tuning it by hand.

## Phase 6 — Amy

The voice. You talk; she clarifies, pushes back, ideates, remembers you,
reports in, and hands every piece of building work to the tool below
her — she never writes code herself. Amy isn't a new machine; she's a
natural-conversation face on everything phases 0 through 5 already made
true.

**Done when:** "Hey Amy, build me this app" works end to end, and your
job is decisions and rulings.

## Parking lot — outside tech to check out when its phase arrives

Suggestions get logged here instead of decided early. When the named
phase begins, each candidate gets judged by the same two laws as
everything else: we must understand what we depend on, and the
load-bearing rules stay in our code, never in a framework's.

- **LangGraph** (a library for long-running AI agents that can pause,
  wait for a person, survive restarts, and pick up where they left
  off) — candidate for Phase 6, Amy's conversational runtime, and
  possibly Phase 4's awareness plumbing. Logged Aug 2026.

- **no-mistakes** (the shipping gate already trusted today — the
  program that reviews, tests, and lints a branch before it's allowed
  to become a pull request) — kept, not rebuilt, for now: pinned to an
  exact version and wrapped behind our own adapter so nothing else in
  the tool ever talks to it directly. Candidate to replace with our own
  gate in a later phase, only if living with it says so. Logged Aug
  2026.

- **Grok Build** (xAI's official terminal coding agent, launched May
  2026 — sign in with a SuperGrok or X Premium+ subscription; has a
  headless mode with JSON output) — the fourth flat-rate tank:
  candidate adapter for Phase 3's brain pool, to be verified against
  the real binary when its adapter gets written. Logged Aug 2026.
