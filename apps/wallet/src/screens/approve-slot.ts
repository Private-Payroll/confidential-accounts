/*
 * The asks that pay from one of the person's accounts, and whether the wallet on screen is one that carries no warning for the page asking.
 */
import type { Profile } from 'midnight-identity/profile/model';
import type { Ask } from 'midnight-identity/profile/request';
import { ACT_INTENTS } from 'midnight-identity/profile/act-intents';
import type { IntentShape } from 'midnight-identity/profile/act-intents';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { alsoUsedBy, chooseSlot } from '../accounts/slot-choice.js';

/**
 * The actions that send nothing to the chain at all: no route of theirs carries a transaction, no relay, and no call
 * of their own from the person's wallet. Every other action can send, and a call it sends may have its network fee
 * paid from one of the person's accounts, so it pays from the account picked in the window before the passkey. An
 * action is held to that pick unless it is named here, so one added later is held to it until it is shown to send
 * nothing. An action named here is given no way to the person's own wallet or coins, which a test checks over what
 * each action is given.
 */
export const SENDS_NOTHING: ReadonlySet<string> = new Set([
  'claim-by-address',
  'join-by-code',
  'reader-keys',
  'drop-role-change'
]);

/**
 * The actions whose payment is coins from the person's own account, not only a call's network fee. A test refuses an
 * action given the doors that move coins that is not named here.
 */
export const PAYS_COINS: ReadonlySet<string> = new Set(['private-deposit']);

/** Whether an action's route list can carry a transaction to the chain: a route that sends, or a relay. */
const routesCanSend = (shape: IntentShape | undefined): boolean =>
  shape !== undefined && ((shape.relays?.length ?? 0) > 0 || (shape.calls ?? []).some((route) => route.sends === true));

/** True for an action that pays from the account picked before the passkey: any action but one that sends nothing. */
export const actionPaysFromThePick = (name: string): boolean =>
  !SENDS_NOTHING.has(name) || routesCanSend((ACT_INTENTS as Readonly<Record<string, IntentShape>>)[name]);

/**
 * True for an ask that pays from one of the person's accounts: an action that can send, or a payment the page asks to
 * be balanced. The account it pays from is the one picked in the window before the passkey and never the one open last.
 */
export const isPayingAsk = (ask: Ask): boolean =>
  ask.kind === 'balance' || (ask.kind === 'act' && actionPaysFromThePick(ask.intent.name));

/** True for an ask that pays coins from the account picked; any other ask that pays pays only a call's network fee from it. */
export const paysCoins = (ask: Ask): boolean =>
  ask.kind === 'balance' || (ask.kind === 'act' && PAYS_COINS.has(ask.intent.name));

/**
 * True when the wallet offered for `origin` is the one on screen and nothing about it warns: it has not been given to
 * another site, and not every wallet here has been.
 */
export const slotIsQuiet = (profile: Profile, origin: string, subwallet: number): boolean => {
  const offered = chooseSlot(profile, origin);
  return (
    offered.account === subwallet &&
    offered.because !== 'every-slot-used' &&
    alsoUsedBy(profile, subwallet, origin).length === 0
  );
};
