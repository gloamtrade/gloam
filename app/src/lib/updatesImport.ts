/**
 * Puts the contest entrants' emails on the updates list. Server only.
 *
 * Takes every email from the video contest (lib/contestEntries) and the writing
 * contest (lib/writingEntries), skips any that aren't valid, and adds each one
 * with the source "contest". Someone already on the list keeps their first day,
 * source and unsubscribe link, so running it again only adds new entrants.
 * Every email it adds gets its own unsubscribe link, like everyone else.
 */
import { listContestEntries } from "./contestEntries";
import { normalizeEmail } from "./updatesEmail";
import { subscribeToUpdates } from "./updatesList";
import { listWritingEntries } from "./writingEntries";

export type ContestImport = {
  /** Different valid emails found across both contests. */
  found: number;
  /** Put on the list just now. */
  added: number;
  /** On the list already. */
  already: number;
  /** Entry emails that weren't valid, left out. */
  skipped: number;
};

export async function addContestEmailsToUpdates(now = Date.now()): Promise<ContestImport> {
  const [video, writing] = await Promise.all([listContestEntries(), listWritingEntries()]);
  const emails = new Set<string>();
  let skipped = 0;
  for (const e of [...video, ...writing]) {
    if (!e.email) continue;
    const email = normalizeEmail(e.email);
    if (email) emails.add(email);
    else skipped++;
  }
  let added = 0;
  for (const email of emails) {
    if ((await subscribeToUpdates(email, "contest", now)).added) added++;
  }
  return { found: emails.size, added, already: emails.size - added, skipped };
}
