# THE CONTRACT

These are the rules Fabrica can never break. The words used here are
defined in LANGUAGE.md.

They are not suggestions an AI reads and hopefully follows. Every rule
below is enforced by a small program (a "test") that checks Fabrica
automatically, every time it's built. Break a rule and the tests fail
loudly — the build is rejected. This file is just the human-readable map;
the tests are the speed bumps.

Rules can be added over time. A rule can only be loosened one way: Ari
edits this file himself.

One thing is deliberately NOT in here: how Fabrica chooses to work — try
once, try three ways, which AI brain to use, when to ask first. Those are
tactics (the "playbook"), and tactics are allowed to change, be
configured, and eventually be learned. This file holds only what must
stay true forever.

## The rules

**1. It never touches your stuff.**
All work happens on a throwaway copy of your project — its
ProductionLine (an "isolated worktree"). Your own copy of the project stays untouched, always.
*Checked by:* a test that runs a job, then proves your original folder is
identical afterward, byte for byte.

**2. "Done" means proven.**
Fabrica may only call work done if the project's own checks — its tests,
its quality rules (the "verification gate") — passed on that throwaway
copy. If they didn't pass, you get an honest failure report instead.
There is no third option, and no path around the gate.
*Checked by:* a test that breaks the checks on purpose and proves the
result comes back as a failure report, never as "done."

**3. Three means three.**
When you give a number — attempts, retries, anything — Fabrica does
exactly that number. Counting is done by the Foreman — ordinary code, a
"loop" — never by asking an AI to decide how many.
*Checked by:* a test that asks for N of something using a fake worker and
counts exactly N happening, for several different N.

**4. It never guesses silently.**
Every delivery must tell you four things: how sure it is (a "confidence
level"), what it assumed wherever your instructions were silent
("assumptions"), what it didn't do or found confusing ("gaps"), and the
proof it ran ("evidence"). If any of the four is missing, the delivery is
invalid and the tool refuses to show it to you as done.
*Checked by:* a test that proves an incomplete delivery gets rejected
before you would ever see it.

**5. It writes everything down.**
Every step — task received, question asked, work started, checks run,
delivery made, your ruling given — is added to a permanent, add-only
record (the "log") as it happens. Nothing happens off the books, and old
entries can never be changed or erased through Fabrica.
*Checked by:* a test that runs a full job and finds every step in the
record, in order — plus a test proving the record can't be rewritten.

**6. You get the last word.**
A task is not closed until you've given your ruling (your "verdict"):
accepted, needed fixes, or wrong direction — with an optional note. The
tool may remind you; it may not forget, and it may not close a task
without one. These rulings are the raw material it will later learn from.
*Checked by:* a test proving a delivered task stays open, and keeps
showing up, until a verdict is recorded.

**7. The rules police themselves.**
Every rule above must have its own named test. A final watchdog test (a
"meta-test") fails the entire build if any rule is missing its test, or
if a rule's test has been deleted or hollowed out.
*Checked by:* that watchdog test itself.

**8. No favorite brain.**
Fabrica never depends on which AI brain (a "model," reached through a
coding "agent") is doing the work. Brains plug in through one small
socket (an "adapter"), and any brain can be unplugged and replaced
without changing anything else. Picking a default brain is a setting;
switching brains is a tactic for the playbook — never wiring.
*Checked by:* a test that runs a task end to end with a completely fake
brain plugged into the socket, proving nothing outside the adapter knows
or cares who's thinking — plus a check that no brain-specific code
exists anywhere outside the adapter.

**9. It can't grade its own homework in the dark.**
Sometimes changing the truth IS the task: a feature that changes
behavior must change the ratified tests that encoded the old behavior.
So a worker MAY change ratified tests and check settings — openly.
Every change to the gate must be separately declared in the delivery
(which test, and why the brief requires it), and a gate-changing
delivery never slides through on green alone: it reaches the Client
with those changes front and center, and later automated reviewers get
the same emphasis. What stays forbidden forever is the silent version.
Fabrica made the throwaway copy, so it knows the gate's before-state,
and any undeclared change to it is honestly recorded, no matter how
good the result looks. The work itself is never thrown away — it stays
committed on the branch, visible, and reviewable, exactly like any
other outcome. What actually blocks the merge lives outside Fabrica:
the repository's own CI reads the pull request's diff for a touched
protected path and fails on it — declared or not, since a change to
the thing that decides whether work passes deserves the Client's eyes
either way. Only the Client, as the one person who can tell an honest
declaration mistake from actual cheating, may override that check and
merge it in.
*Checked by:* two tests. A fake worker edits the project's checks
without declaring it — the work lands on the ordinary branch and the
violation is recorded. A fake worker edits them WITH a declaration —
the work is delivered normally, carrying the declaration where the
Client cannot miss it.

**10. It cannot outspend you.**
Money runs metered, so the limits are law: a cap per task and a cap
per day, in dollars, set once in the config. A task that would start
beyond the day's cap is refused — with the numbers shown. A task that
hits its own cap mid-run stops with an honest failure report and its
receipt. Every refusal and every stop lands on the record. Spending is
counted by code; "watch the usage closely" is Fabrica's job, never
the Client's memory.
*Checked by:* a test that sets the daily cap to zero and proves a new
task is refused with the numbers in the message — and a test proving
every receipt carries the money field.
