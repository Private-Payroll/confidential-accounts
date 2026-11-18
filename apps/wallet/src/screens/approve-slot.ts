/*
 * The actions that pay from one of the person's wallets, and whether the wallet on screen is one that carries no warning for the page asking.
 */
import type { Profile } from 'midnight-identity/profile/model';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { alsoUsedBy, chooseSlot } from '../accounts/slot-choice.js';

/** The actions that pay from one of the person's accounts: the window lets them choose which, as a payment's window does. */
export const PAYING_ACTIONS: ReadonlySet<string> = new Set(['private-deposit']);

/**
 * True when the wallet offered for `origin` is the one on screen and nothing about it warns: it has not been given to
 * another site, and not every wallet here has been.
 */
export const slotIsQuiet = (profile: Profile, origin: string, subwallet: number): boolean => {
  const offered = chooseSlot(profile, origin);
  return offered.account === subwallet && offered.because !== 'every-slot-used'
    && alsoUsedBy(profile, subwallet, origin).length === 0;
};
