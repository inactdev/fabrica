// Shared text for Inspector's pull request and the delivery commit: the
// Client reads the same "what changed, and why" account in both places,
// built from the one declaration CONTRACT rule 9 already collects
// (a worker's own gateChanges) rather than inventing a second field for
// it. Built before Inspector's own verdict exists - the same call that
// tells Fabrica green or red is the one that would open the pull request
// - so the summary here is deliberately the provisional "done" wording:
// the only outcome this text is ever read under.

export function firstLineTrimmed(text: string): string {
  return text.split("\n")[0].trim();
}

export function deviationsSection(gateChanges: string | undefined): string {
  return `Deviations:\n${gateChanges && gateChanges.trim().length > 0 ? gateChanges : "None."}`;
}

function provisionalSummary(taskText: string): string {
  return `Completed: ${taskText}`;
}

export function buildPrBody(taskText: string, gateChanges: string | undefined): string {
  return `${provisionalSummary(taskText)}\n\n${deviationsSection(gateChanges)}\n`;
}

export function buildCommitMessage(subject: string, gateChanges: string | undefined): string {
  return `${subject}\n\n${deviationsSection(gateChanges)}`;
}
