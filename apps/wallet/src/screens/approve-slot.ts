/*
 * The actions that pay from one of the person's wallets, and whether the wallet on screen is one that carries no warning for the page asking.
 */
import type { Profile } from 'midnight-identity/profile/model';
import type { Ask } from 'midnight-identity/profile/request';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { alsoUsedBy, chooseSlot } from '../accounts/slot-choice.js';

/** The actions that pay from one of the person's accounts: the window before the passkey lets them pick which, once. */
export const PAYING_ACTIONS: ReadonlySet<string> = new Set(['private-deposit']);

/** True for an ask that pays from one of the person's accounts: an action that pays, or a payment the page asks to be balanced. */
export const isPayingAsk = (ask: Ask): boolean =>
  ask.kind === 'balance' || (ask.kind === 'act' && PAYING_ACTIONS.has(ask.intent.name));

/**
 * True when the wallet offered for `origin` is the one on screen and nothing about it warns: it has not been given to
 * another site, and not every wallet here has been.
 */
export const slotIsQuiet = (profile: Profile, origin: string, subwallet: number): boolean => {
  const offered = chooseSlot(profile, origin);
  return offered.account === subwallet && offered.because !== 'every-slot-used'
    && alsoUsedBy(profile, subwallet, origin).length === 0;
};
