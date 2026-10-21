# A refused round after a real delivery is fixable now, not a dead end

## The plan, written before anything changed, and the alternatives rejected

A fix round that ends in an Inspector refusal left the task able to move
only by `wrong` (close it) or `accept` (rule on the stale earlier
delivery): `fix` threw `ForemanError("inspection-refused")` telling the
Client to "resolve the refusal, then hand the branch to Inspector again"
by hand - i.e. to leave the loop Fabrica exists to run. Seen three times
in real use (inspector `20261017-do-inspector-issue-44-…-51`, fabrica
`20261018-…-186-…-l7` and `20261020-…-142-…-vl`).

Safest-first, the options were:

1. **Let `fix` through on the existing fix path, and carry the refusal's
   own report into the brief as framing** - chosen. It reuses every part
   of the machinery that was already proven (reopen the line, resume the
   session, count the round, hand off to Inspector again at the end) and
   adds no new state: the refusal is read back off the record's own
   `inspection-finished` event, exactly the way the note, project and
   base commit already are.
2. **A separate "retry the handoff" command** (`fabrica reinspect <id>`)
   that re-runs Inspector on the existing commit with no worker at all.
   Rejected: it is a second, parallel way to resume a task, with its own
   caps/meters/record story to get right, and it cannot answer the
   refusals that *are* about the tree (a config blob that drifted from
   the base commit, an uncommitted stray, a missing token the worker can
   report on). The Client's one verb for "go again" is `fix`; adding a
   second one splits the loop.
3. **Classifying the refusal first and only re-entering for the
   classes that look recoverable.** Rejected: Inspector exposes no
   machine-readable difference between its two exit-2 causes (see
   below), so the classification would have to pattern-match its prose -
   the kind of guess that silently stops working when the other side
   rewords a message, and worse than handing the worker the report
   verbatim and letting it read.

## What Inspector does and does not tell us (read from its own README)

`inspector` exits `2` for *either* of two causes, and its own docs say
both are "no verdict" and neither is red:

- **refused** - it stopped before attempting any remote publication.
- **incomplete green publication** - the local check passed and
  publication had already begun (staging push, commit status, branch
  update, then optionally the pull request).

There is **no distinct exit code, no stable printed marker line, and no
documented report field** separating the two. The report JSON under
`.inspector/runs/` records "the command that ran, its exit code (or the
signal that killed it), and its full output"; no field names are
published. So Fabrica cannot classify a refusal today without guessing
at another project's output format.

What this task does instead: the refusal's own report goes into the
worker's brief verbatim, framed with instructions that cover *both*
shapes, keyed on what that report says - fix it if the cause is in this
tree; if it says the check passed and the branch was not published, the
work is fine, publishing is the host's job after this round, so change
nothing and only confirm the tree is as intended. The worker reads
Inspector's words; Fabrica does not pretend to have parsed them.

If the two causes ever need to be told apart in code, the mechanism this
project already has for pinning a cross-repository fact is
`src/inspector/consumer-contract.json` (Fabrica is the source; the sync
workflow opens the matching pull request on Inspector) - not a regex
over Inspector's prose.

## Sharp edges found while doing it

- **A fix round's `priorReceipts` must come from `receiptsOf`, not from
  the last `"delivered"` event.** A refused round delivers nothing, so
  its attempts exist on the record only as their own
  `"receipt-recorded"` events. Reading the stale delivery's list made
  `startAttempt` restart *on a number the task had already used* - and
  `receiptsOf` de-duplicates by `attempt`, so the new attempt's receipt
  would have been dropped from the next delivery's cumulative list
  entirely. `receiptsOf` returns the same set as before for an ordinary
  fix after a delivery (every receipt is on both the `"delivered"` event
  and its own `"receipt-recorded"` one), so this is a fix for the
  refusal path and a no-op everywhere else.
- **`skipIfUnchanged` must not wrap a round that is answering a
  refusal.** Its whole premise is that re-handing an already-*reviewed*
  commit to Inspector can only draw a refusal - but a refusal means
  Inspector reached no verdict, so that commit was never reviewed, and
  re-handing it is exactly the retry that can succeed (and the only way
  an unpublished green branch ever gets published). Left wrapped, a
  worker that correctly changed nothing would deliver
  `"nothing-changed"` without Inspector ever being called again - the
  same dead end one step further along.
- A refused round's *declared gate changes* (rule 9's `gateChanges`) are
  genuinely not on the record anywhere: `runAttempts` returns them and
  only `delivery.ts` stores them, so a refused round's declaration is
  lost and the next round's delivery cannot carry it forward. Not fixed
  here (rule 9 enforcement is CI-side and keys on the pull request's own
  file list, not on this field), but worth knowing before trusting
  `delivery.gateChanges` as a complete history.
- The phone review page (`integrations/live-view/record-view.ts`'s
  `getReviewRows`) still shows **no row at all** for a task whose latest
  inspection is a refusal that came after a real delivery: its state is
  not `"delivered"`, and `earlyStopKindOf` deliberately answers null
  because there *is* a delivery. `deliveryOf` also returns null for that
  task by design (a newer refusal supersedes the earlier delivery), so
  giving it a full card means deciding what the card shows first. The
  CLI (`fabrica status`/`watch`/`verdict`) is the whole surface for this
  state today.
