import type { Opened } from 'midnight-identity/profile/seal';

/**
 * **WHAT TO TELL A PERSON WHOSE WALLET CANNOT OPEN ITS OWN SAVED DETAILS.**
 *
 * Each wallet in a browser keeps its own record, so another wallet's details
 * are never this wallet's state and never stop it answering. What reaches this
 * is a record that is provably this wallet's - under its own name, or at the
 * name every wallet once shared and authenticated by its key - and will not
 * read. There is no innocent explanation left for that here, so it keeps its
 * warning and the store's own sentence.
 */
export interface UnopenableSaying {
  readonly title: string;
  readonly sentence: string;
  readonly tone: 'danger';
}

export function sayingForUnopenable(
  opened: Extract<Opened, { of: 'unopenable' }>,
): UnopenableSaying {
  return {
    title: 'There are details here that this account cannot open',
    sentence: opened.why,
    tone: 'danger',
  };
}

/**
 * **THE RECORD A BROWSER KEPT BEFORE EACH WALLET HAD ITS OWN, WHEN IT IS NOT THIS WALLET'S.**
 *
 * It will not open with this wallet's key. Another wallet used here may have
 * saved it, or it may be this wallet's own and changed since - the two fail the
 * same way - so both are said, and nothing about it is acted on.
 */
export const OTHER_DETAILS_HERE = 'This browser also keeps saved details that this wallet cannot '
  + 'open: another wallet used here saved them, or they were changed after they were saved. They '
  + 'are left exactly as they are, and they do not stop this wallet saving its own.';
