/**
 * **WHAT MAKES A PAGE'S READ OF A COMPANY STALE FROM OUTSIDE THE SCREEN THAT MADE IT.** The sign-in ending or
 * becoming another person's, and an action in the person's wallet having run on a company, are known where the
 * sign-in and the wallet's actions are kept. Whoever holds something read of a company (a screen holding its view)
 * watches here and lets it go; the code that keeps the sign-in only says what happened.
 */

/** What happened: to one company, or to every company (`company` null); and whether somebody is signed in to read again as. */
export interface ReadsStale {
  readonly company: string | null;
  readonly why: string;
  readonly signedIn: boolean;
}

/** Why a read is stale, as the view that is ended over it says to whoever reads through it afterwards. */
export const STALE = {
  signInEnded: 'the sign-in ended',
  signedIn: 'somebody signed in',
  actedInTheWallet: 'an action in the wallet ran on the company'
} as const;

const watching = new Set<(stale: ReadsStale) => void>();

/** Calls `watch` each time something read of a company is stale; returns the way to stop. */
export const watchReadsStale = (watch: (stale: ReadsStale) => void): (() => void) => {
  watching.add(watch);
  return () => {
    watching.delete(watch);
  };
};

/** Tells every watcher; one that throws stops neither what happened nor the others, and its error is reported. */
export const readsAreStale = (stale: ReadsStale): void => {
  for (const watch of [...watching]) {
    try {
      watch(stale);
    } catch (e) {
      console.error(e);
    }
  }
};
