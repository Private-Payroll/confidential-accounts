/**
 * A company being brought into being on this device: the person's press founds it in their wallet, this page sends the
 * service what it was founded with, and what is kept of a creation that has not finished stays offered here until it is
 * finished, started again or dropped. Every key stays in the wallet. The saved keys this tab shows, and the changes it
 * has asked for and not yet seen made (`tidyOwed`), are kept in `keyring.ts`; this file works out from them which
 * creations are shown, keeps which ones this tab saw finished, took up again or sent, and holds the refusals for a
 * creation that somebody else started.
 */
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { readAccountAddress } from 'midnight-identity/profile/company-label';
import type { StepAt } from 'midnight-identity/profile/channel';
import type { KeyringHandedIn, KeysRead, SealedKeyring } from 'midnight-identity/profile/unlock';
import type { Sealed } from '../../../src/core/crypto.js';
import { COMPANY_CREATION_STATES, type CompanyCreationState } from '../../../src/core/company-founding.js';
import type { SignerRole } from '../../../src/core/types.js';
import { creationOnPage, walletCallsOnPage } from './asks-on-page.js';
import { accountReadByTheWallet, walletShowsPayKeyCommitted } from './chain-before-a-view.js';
import { readsAreStale, STALE } from './company-reads-stale.js';
import { type SavedCreation } from './keyring-blob.js';
import {
  canOpenCompanies,
  companyNamedFor,
  currentUser,
  firstKeysMaySaveFromHere,
  keepWhatTheWalletSealed,
  keptKeyring,
  openKeysOnceOpen,
  savedKeysForTheWallet,
  schnorrKeyOf,
  servedForTheAction,
  takeTheRead,
  takeWhatTheActionLeft,
  tidyOwed
} from './keyring.js';
import { NotOnTheService, sessionIsLive } from './service-transport.js';
import type { AccountPresenceOnTheWire } from './vault-worker-client.js';
import { actInTheWallet, type ActOutcome } from './wallet-act.js';
import { doneWaiting, openTheWallet, putAway, walletsIndexerNamed } from './wallet-asks.js';
import { WalletClosed, US_TO_A_WALLET, type Openable } from './wallet-sign-in.js';
import { walletInThisPage } from './wallet-frame.js';

/** Whether `person` is the one signed in here now, read afresh each time because a sign-in can change under a step. */
const signedInAs = (person: string): boolean => {
  const me = currentUser();
  return me !== null && me.id === person;
};

/**
 * **A PERSON'S FIRST KEYS ARE SAVED ONLY FROM A TAB THAT CAN TELL WHICH WALLET
 * SIGNED IN** (`firstKeysMaySaveFromHere` says why). This is the refusal when
 * this tab did not sign them in: its own class so a screen can tell it apart
 * and say it in its own words; its message is `FIRST_KEYS_NEED_THE_SIGN_IN`.
 */
export class FirstKeysNeedTheSignIn extends Error {}

const FIRST_KEYS_NEED_THE_SIGN_IN =
  'nothing is saved for you here yet, and this tab did not sign you ' +
  'in, so it cannot make sure that the wallet answering is the one you signed in with before your ' +
  'first keys are saved under its key. Nothing has been created or saved. Sign in again in this tab, ' +
  'with the same wallet address, and try again.';

/**
 * The company this tab is waiting to finish was started by somebody other than
 * the person signed in here now. Its own class so a screen can tell it apart
 * and say it in its own words; nothing is saved and the company stays waiting
 * for the person who started it.
 */
export class CompanyStartedBySomebodyElse extends Error {}

const STARTED_BY_SOMEBODY_ELSE =
  'the company waiting to be finished in this tab was started by ' +
  'somebody else, who is not the person signed in here now. Its keys are never saved into yours. ' +
  'Nothing has been saved; the person who started it can sign in again in this tab to finish it.';

/** Starting a creation again was asked for a company this browser keeps no creation for. */
export class NoCreationKeptHere extends Error {}
/* ---------------- bringing a company into being ---------------- */

/** What a company is made from: its name, who signs for it, and how many signatures it needs. */
export interface CompanyToFound {
  name: string;
  signers: Array<{ name: string; role: SignerRole }>;
  threshold: number;
}

/** A company as its founding signer's press made it: the label their wallet drew, and what its account is deployed from. */
interface Founded {
  readonly accountId: string;
  readonly label: CompanyLabel;
  /** The key the founding signer sits on the company's committee with, which alone holds the account from its first transaction. */
  readonly foundingKey: { tag: 'schnorr'; value: string };
  /** The founding signer's seat in the account, as this device made it. */
  readonly foundingLeaf: string;
}

/**
 * **THE COMPANY IS FOUNDED IN THE WALLET**, in the one window the press opens:
 * the wallet draws the label, makes the founding seat from its words, signs the
 * founding roster and state with it and writes the seat into the person's saved
 * keys, sealed again (`apps/wallet/src/keyring/found-company.ts`). This page
 * hands the wallet the saved keys as the service holds them and the company's
 * name and founding signer, keeps the saved keys the wallet sealed over the
 * version it named, and only then sends the service what the company was
 * founded with. The founding seat's keys never reach this page.
 */
async function foundCompany(
  spec: CompanyToFound,
  walletOrigin: string,
  view: Openable,
  atOrigin: string
): Promise<Founded> {
  const me = currentUser();
  if (!sessionIsLive() || me === null) throw new Error('not signed in');
  /*
   * **THE WINDOW OPENS IN THE PRESS, EVERY TIME.** The new company's label is
   * the wallet's to draw, so a tab the wallet already read for asks it too - and
   * its answer must come from the same wallet (`openKeysOnceOpen`).
   */
  const startedBy = me.id;
  const dialog = openTheWallet(view, walletOrigin);
  try {
    const handedIn = await savedKeysForTheWallet();
    const signer = spec.signers[0]!;
    const {
      drawn,
      committeeKey,
      founding,
      read: foundedRead
    } = await openKeysOnceOpen(walletOrigin, view, atOrigin, dialog, 'new', {
      asked: { name: spec.name, signer: { name: signer.name, role: signer.role } },
      keyring: handedIn
    });
    if (drawn === null)
      throw new Error(
        "Your wallet did not make up a label for the new company, so nothing was created. Close the wallet's window, reload this page and start the company again."
      );
    const foundingKey = schnorrKeyOf(committeeKey);
    if (foundingKey === null) {
      throw new Error(
        'Your wallet drew a label for the new company but gave no key to hold it with, so nothing was created. ' +
          "Close the wallet's window, reload this page and start the company again."
      );
    }
    if (founding === null) {
      throw new Error(
        'Your wallet drew a label for the new company but did not hand back what it founded it with, so nothing ' +
          "was created. Close the wallet's window, reload this page and start the company again."
      );
    }
    /* Asked before anything is kept, so a refusal costs nothing. */
    if (!firstKeysMaySaveFromHere()) throw new FirstKeysNeedTheSignIn(FIRST_KEYS_NEED_THE_SIGN_IN);
    return await keepWhatTheWalletFounded(drawn, foundingKey, founding, startedBy, foundedRead!);
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
  }
}

/**
 * The saved keys the wallet sealed with the new seat in them, kept over the
 * version it named; then the creation they keep, read back and checked against
 * the label and key the wallet gave, sent to the service.
 */
async function keepWhatTheWalletFounded(
  label: CompanyLabel,
  foundingKey: { tag: 'schnorr'; value: string },
  founding: { founded: Readonly<Record<string, unknown>>; sealed: SealedKeyring; ifVersion: number },
  person: string,
  foundedRead: KeysRead
): Promise<Founded> {
  const account = founding.founded['account'] as { id?: unknown } | undefined;
  const accountId = typeof account?.id === 'string' ? account.id : null;
  if (accountId === null) {
    throw new Error(
      'Your wallet founded the company without an id it can be kept under, so nothing was created. ' +
        'Reload this page and start the company again.'
    );
  }
  /* The saved keys the wallet sealed are the starter's: somebody else signed in on this tab since is never written over with them. */
  if (!signedInAs(person)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  const kept = await keepWhatTheWalletSealed(founding.sealed as unknown as Sealed, founding.ifVersion);
  if (kept === null) {
    throw new Error(
      'Your saved keys, with your seat in the new company, were not kept by the service: they changed on another ' +
        'device since this page read them, or the service refused them. Nothing was created. Reload this page, which reads ' +
        'your newest saved keys, and start the company again.'
    );
  }
  /* What the wallet read from the saved keys it sealed, taken in now they are kept: the new seat and its creation. */
  takeTheRead(foundedRead, true, kept);
  const saved = theCreation(accountId);
  if (saved === undefined || saved.label !== label || saved.foundingKey.value !== foundingKey.value) {
    throw new Error(
      'the company was founded but what was kept of it could not be read back as the company your wallet drew, ' +
        'so nothing was sent. Reload this page and start the company again.'
    );
  }
  refuseWhenNotTheStarter(saved);
  await sendTheCompany(saved, 'new');
  /* A sign-in by somebody else while the service was answering: this tab acts for them now, and nothing more is done here. */
  if (!signedInAs(person)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
  return { accountId, label, foundingKey, foundingLeaf: saved.request.founding.seat.leaf };
}
/**
 * This person's company being created, if there is one: as the wallet last read it, with the changes this tab asked
 * for and has not yet seen made (`tidyOwed`), one finished here (`finishedHere`), and one set aside that this tab took
 * up again because its deploy landed (`takenUpHere`; the wallet takes it up itself when it finishes it).
 */
const theCreation = (accountId: string): SavedCreation | undefined => {
  if (tidyOwed.has(accountId) || finishedHere.has(accountId)) return undefined;
  const c = keptKeyring().creations?.[accountId];
  if (c === undefined) return undefined;
  if (c.setAside !== true) return c;
  if (!takenUpHere.has(accountId)) return undefined;
  const { setAside: _taken, ...active } = c;
  return active as SavedCreation;
};

/** Creations this tab saw finished on the chain: no longer offered here; the wallet drops them when it finishes one. */
const finishedHere = new Set<string>();
/** Creations set aside whose deploy this tab saw land: offered to finish again here; the wallet takes them up. */
const takenUpHere = new Set<string>();
/** Creations this tab sent to the service, so a later relay does not send them again. */
const sentHere = new Set<string>();

/**
 * A creation is written only into the saved keys of the person who started it: a step that returns after somebody
 * else was signed in and opened their keys would otherwise leave them holding it, unable to create a company.
 */
function refuseWhenNotTheStarter(c: SavedCreation): void {
  if (c.person !== undefined && !signedInAs(c.person)) throw new CompanyStartedBySomebodyElse(STARTED_BY_SOMEBODY_ELSE);
}

/**
 * Drops what was kept of a creation: one finished is no longer offered here (the wallet drops it from the saved keys
 * when it finishes it); one whose deploy was never built is asked of the wallet in this tab's next ask (`tidyOwed`).
 */
async function forgetCreation(accountId: string): Promise<void> {
  const kept = keptKeyring().creations?.[accountId];
  if (kept !== undefined) refuseWhenNotTheStarter(kept);
  if (kept?.setAside === true) return;
  if (kept !== undefined && kept.signed === null && !kept.recorded) tidyOwed.set(accountId, 'forget');
  else finishedHere.add(accountId);
}

/**
 * Sets one creation aside: asked of the wallet in this tab's next ask (`tidyOwed`), which keeps all of it under its own
 * company id, marked `setAside`, so it is not lost and no other creation is touched. This tab reads it as set aside at once.
 */
async function setCreationAside(accountId: string): Promise<void> {
  const kept = theCreation(accountId);
  if (kept === undefined) return;
  refuseWhenNotTheStarter(kept);
  tidyOwed.set(accountId, 'aside');
}

/**
 * **A CREATION SET ASIDE, TAKEN UP AGAIN** because its account turned up on the chain: this tab offers it to finish
 * again, and the wallet takes its mark off when it finishes it (`apps/wallet/src/actions/finish-company.ts`). Only
 * that creation is touched; any other kept creation stays as it is.
 */
export async function takeUpACreationSetAside(accountId: string): Promise<boolean> {
  const aside = keptKeyring().creations?.[accountId];
  if (aside === undefined) return false;
  if (tidyOwed.get(accountId) === 'aside') {
    /* Set aside here and not yet in the saved keys: the change is no longer asked of the wallet. */
    refuseWhenNotTheStarter(aside);
    tidyOwed.delete(accountId);
    return true;
  }
  if (aside.setAside !== true || takenUpHere.has(accountId)) return false;
  refuseWhenNotTheStarter(aside);
  takenUpHere.add(accountId);
  return true;
}

/**
 * Sends the request that made the company, as it was kept, unless this tab sent it or the service already holds the
 * company. Nothing is written into the saved keys for it: the service's own answer says whether it holds it.
 */
async function sendTheCompany(saved: SavedCreation, known: 'new' | 'ask' = 'ask'): Promise<SavedCreation> {
  if (saved.made || sentHere.has(saved.accountId)) return saved;
  if (known === 'ask') {
    try {
      await creationOnPage.standing(saved.accountId);
      sentHere.add(saved.accountId);
      return saved;
    } catch (e) {
      if (!(e instanceof NotOnTheService)) throw e;
    }
  }
  await creationOnPage.created(saved.request);
  sentHere.add(saved.accountId);
  return saved;
}

/**
 * What reads the chain for a kept creation this page is asked to start again: the vault worker, or anything that
 * answers as it does. A company's account is built, signed and proved in the wallet (`finishCompanyInTheWallet`),
 * never here.
 */
export interface AccountCreationBuilder {
  /**
   * Whether the chain holds a contract at the account, at the indexer the person's wallet names: with the time of the
   * newest block it names and the newest time to live of the kept transactions. Throws when the indexer cannot say.
   */
  accountPresence?(input: {
    account: string;
    indexer: { indexerUri: string; indexerWsUri: string };
    transactions: string[];
  }): Promise<AccountPresenceOnTheWire>;
}

/**
 * The company this person has started and not finished, for which the press that finishes it is owed: every creation
 * still kept, since the wallet drops a creation from the saved keys as the last step of finishing it. The account is
 * the one the wallet built, once it has.
 */
export const companyAwaitingItsSecondPress = (
  accountId: string
): { accountId: string; account: AccountAddress | null } | null => {
  const saved = theCreation(accountId) ?? null;
  return saved !== null ? { accountId: saved.accountId, account: saved.deploy?.account ?? null } : null;
};

/** Every company this person is creating on a chain, each kept on its own, in the order they were started. A creation set aside is not among them. */
export const companiesBeingCreated = (): string[] =>
  Object.keys(keptKeyring().creations ?? {}).filter((id) => theCreation(id) !== undefined);

/** Whether this company is one this person is creating on a chain, kept with their saved keys, until its creation is finished. A creation set aside is not. */
export const companyBeingCreated = (accountId: string): boolean => theCreation(accountId) !== undefined;

/**
 * The label the wallet drew for the company being created, as this browser kept it: the one source of the label the
 * person is shown after the first press. Null when no creation is kept, or when it is another company's than the one asked
 * about.
 */
export const companyBeingCreatedLabel = (accountId: string): CompanyLabel | null =>
  theCreation(accountId)?.label ?? null;

/**
 * The name the person gave a company, as this device kept it with the company's creation, whether that creation is still
 * kept or was set aside: the one source of the name of a company that is not finished, which has no sealed record to open
 * yet: the name written on the kept request. Null for a company this device holds no creation of, or whose creation holds
 * no name; never the service's word for it, and never the roster opened here, which only the seat's own keys open.
 */
export const companyNameKeptHere = (accountId: string): string | null => {
  const kept = keptKeyring().creations?.[accountId] ?? keptKeyring().creationsSetAside?.[accountId];
  if (kept === undefined || kept === null) return null;
  return aNameIfAny(kept.request?.name);
};

const aNameIfAny = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * **THE FIRST PRESS: THE COMPANY IS FOUNDED IN THE WALLET** (`foundCompany`).
 *
 * The wallet draws the company's label, makes the founding seat from its words,
 * signs the founding roster and state and keeps the seat in the saved keys; the
 * service records what was founded, and the founding signer's committee key.
 * **NOTHING IS SENT TO THE CHAIN, AND NO ACCOUNT IS BUILT YET**: the second
 * press is one action the wallet runs whole, which builds the account and
 * finishes it (`finishCompanyInTheWallet`). It returns the label the wallet
 * drew, so the page can show the person the name their wallet gave the company.
 *
 * **A COMPANY IS NEVER REFUSED BECAUSE ANOTHER IS NOT FINISHED.** Each creation is kept on its own, under its own
 * company id, and carried on or started again on its own; a new one is added beside the others and never replaces one.
 * A kept creation from which nothing was sent to the chain can be dropped, by `forgetAnUnsentCreation`.
 */
export async function startCompanyHeldFromTheStart(
  spec: CompanyToFound,
  walletOrigin: string,
  view: Openable = walletInThisPage(window),
  atOrigin: string = window.location.origin
): Promise<{ accountId: string; label: CompanyLabel }> {
  /* Before the wallet is opened: a company is created with its founding signer only. */
  if (spec.signers.length !== 1 || spec.threshold !== 1) {
    throw new Error(
      'a company is created with you as its only signer, at a threshold of one; everybody else joins by ' +
        'invitation, their seat made on their own device. Nothing was created.'
    );
  }
  const founded = await foundCompany(spec, walletOrigin, view, atOrigin);
  return { accountId: founded.accountId, label: founded.label };
}

/**
 * Drops a kept creation from which nothing reached the chain, so the first press can make a company again: its
 * deploy was never built, or was built and never signed for or sent. It refuses when this browser keeps no creation
 * for the company, and when anything was signed or sent: that carries on, and dropping it would lose what the
 * wallet signed or what the chain already holds. The company's keys stay kept, because the service may already
 * list the company.
 */
export async function forgetAnUnsentCreation(accountId: string): Promise<void> {
  const saved = theCreation(accountId);
  if (saved === undefined) throw new Error('this browser keeps no creation for this company.');
  if (saved.signed !== null || saved.recorded) {
    throw new Error(
      "this company's second step was signed or sent, so it is carried on, not started again. Nothing was dropped."
    );
  }
  await forgetCreation(accountId);
}

/** What starting a kept creation again came to. */
export type StartedAgain =
  /** What was kept of it is dropped; the first press can make a company again. */
  | { readonly of: 'dropped' }
  /** Its account is on the chain, so it is finished, never dropped. */
  | { readonly of: 'on-the-chain' }
  /** Nothing shows it on the chain, but what was sent can still land for this many minutes. */
  | { readonly of: 'may-still-land'; readonly minutes: number }
  /** The chain could not be read well enough to say nothing landed. */
  | { readonly of: 'not-confirmed' };

/** The service's own margin past a transaction's time to live before it counts it as run out. */
const THE_SERVICES_MARGIN_MS = 5 * 60_000;

/**
 * Every creation this tab handed on for the person's wallet (`relayForTheCreation`), by company: the deploy and its
 * second step as the wallet built them, which may be newer than the copy kept in the saved keys, because the wallet
 * builds a creation again shortly before it runs out. Kept for the life of the tab and never sent anywhere: a creation
 * is never set aside while any copy handed on can still land.
 */
const CREATIONS_HANDED_ON = new Map<string, string[]>();

/** The service's creation standings in which the account's deploy has not landed. */
const DEPLOY_NOT_LANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>([
  'not-created',
  'deploy-sent',
  'deploy-expired'
]);

/** The service's creation standings in which the account's deploy has landed. */
const DEPLOY_LANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>([
  'finish-owed',
  'finish-expired',
  'finish-sent',
  'pay-key-owed',
  'finished'
]);

/**
 * **STARTING A KEPT CREATION AGAIN: ONLY WHEN THE CHAIN SHOWS NO ACCOUNT, AND NOTHING SENT CAN STILL LAND.**
 * Only the person who started it. A creation whose second step was never signed was never sent, and is dropped at once.
 * One that was signed or sent is set aside (not deleted: `takeUpACreationSetAside` finishes it if its account turns up)
 * only when all of this holds: the service does not say its deploy landed; the person's wallet does not read the
 * account; and this device, reading the chain at the indexer that wallet named (never the service's word), is told by
 * a clean answer that no contract is held at the address AND the chain's own newest block is past the newest time to
 * live of the kept transactions and of every copy this tab handed on for the wallet, read from their bytes, by the
 * service's five-minute margin; AND the service does not say the deploy it holds, which a copy the wallet built again
 * replaces, can still be sent (its word can only keep a creation, never set one aside). No device clock is used. Any
 * failure, an indexer not named, or a transaction that cannot be read keeps the creation. A landed deploy is finished,
 * never set aside. The company's keys stay kept.
 */
export async function startAnUnfinishedCreationAgain(
  accountId: string,
  walletOrigin: string,
  builder: AccountCreationBuilder | null,
  view?: Openable,
  atOrigin?: string
): Promise<StartedAgain> {
  const saved = theCreation(accountId);
  if (saved === undefined) throw new NoCreationKeptHere('this browser keeps no creation for this company.');
  refuseWhenNotTheStarter(saved);
  if (saved.signed === null && !saved.recorded) {
    await forgetAnUnsentCreation(accountId);
    return { of: 'dropped' };
  }
  const standing = (await companyCreationStanding(accountId)).state;
  if (DEPLOY_LANDED.has(standing)) return { of: 'on-the-chain' };
  if (!DEPLOY_NOT_LANDED.has(standing) || saved.deploy === null) return { of: 'not-confirmed' };
  const account = saved.deploy.account;
  try {
    await accountReadByTheWallet(walletOrigin, { company: saved.label, account }, view, atOrigin);
    return { of: 'on-the-chain' };
  } catch (e) {
    if (!(e instanceof WalletClosed && e.refusal.of === 'unreadable')) return { of: 'not-confirmed' };
  }
  const indexer = walletsIndexerNamed();
  if (indexer === null || builder === null || builder.accountPresence === undefined) return { of: 'not-confirmed' };
  let seen: AccountPresenceOnTheWire;
  try {
    seen = await builder.accountPresence({
      account,
      indexer,
      transactions: [
        ...new Set([
          saved.deploy.tx,
          ...(saved.signed === null ? [] : [saved.signed.tx]),
          ...(CREATIONS_HANDED_ON.get(accountId) ?? [])
        ])
      ]
    });
  } catch {
    return { of: 'not-confirmed' };
  }
  if (seen.held) return { of: 'on-the-chain' };
  if (seen.ttl === null || !Number.isFinite(seen.ttl) || !Number.isFinite(seen.blockTime))
    return { of: 'not-confirmed' };
  const endsAt = seen.ttl + THE_SERVICES_MARGIN_MS;
  if (seen.blockTime < endsAt)
    return { of: 'may-still-land', minutes: Math.max(1, Math.ceil((endsAt - seen.blockTime) / 60_000)) };
  /* A copy the wallet built again in another tab is not read here; the service holds it, and says whether it can still be sent. */
  if (standing === 'deploy-sent') return { of: 'not-confirmed' };
  const now = theCreation(accountId);
  if (now === undefined) return { of: 'dropped' };
  /* Carried again while the chain was read: what was read is not what is kept now. */
  if (now.deploy?.tx !== saved.deploy.tx || now.signed?.tx !== saved.signed?.tx) return { of: 'not-confirmed' };
  await setCreationAside(accountId);
  return { of: 'dropped' };
}

export { walletShowsPayKeyCommitted };

/**
 * Asks the wallet, quietly, whether the pay-record key is committed on the account THIS BROWSER KEPT for the
 * creation: the kept label and the kept deploy's account, never a pair a service names. Null when nothing is kept
 * for the company here; false when the kept creation built no deploy.
 */
export async function keptCreationShowsItsKeyCommitted(
  accountId: string,
  walletOrigin: string,
  view?: Openable,
  atOrigin?: string
): Promise<boolean | null> {
  const saved = theCreation(accountId);
  if (saved === undefined) return null;
  if (saved.deploy === null) return false;
  return await walletShowsPayKeyCommitted(walletOrigin, saved.label, saved.deploy.account, view, atOrigin);
}

/**
 * Drops what this browser kept to carry a creation on, once the company is finished: true when something was dropped,
 * false when nothing was kept. It asks the wallet itself, about the kept label and account, and refuses unless the
 * wallet shows the pay-record key committed there, so no caller can drop a creation on another's word. The
 * company's keys stay kept.
 */
export async function forgetAFinishedCreation(
  accountId: string,
  walletOrigin: string,
  view?: Openable,
  atOrigin?: string
): Promise<boolean> {
  if (theCreation(accountId) === undefined) return false;
  if ((await keptCreationShowsItsKeyCommitted(accountId, walletOrigin, view, atOrigin)) !== true) {
    throw new Error(
      "your wallet does not show this company's pay-record key committed on its account, so what was kept of its creation is kept. Nothing was dropped."
    );
  }
  if (theCreation(accountId) === undefined) return false;
  await forgetCreation(accountId);
  return true;
}

/**
 * **THE SECOND PRESS: FINISH CREATING THE COMPANY, AS ONE ACTION IN THE
 * WALLET** (`apps/wallet/src/actions/finish-company.ts`), in one window behind
 * one passkey: the wallet builds the account's deploy and its signed second
 * step, has them sent, finishes the account, and proves the pay-record key's
 * proposal, approval and seal, each from its own reads of the chain and with
 * the founding seat it makes again from its words. This page hands the wallet
 * the saved keys as the service holds them, keeps those the wallet seals
 * again, sends each transaction the wallet hands it where the wallet says
 * it goes (`relayForTheCreation`), and makes the one call the wallet asks, the
 * pay-record key's proposal written down with its raise beside it, for this
 * company alone. It proves and signs nothing itself.
 *
 * It resolves with where the action ended: done, or stopped at a step, which
 * the person carries on from with one more press (the wallet works out from
 * the chain what is already done).
 *
 * **IN A TAB THE WALLET HAS NOT YET READ FOR**, the company is named to the
 * wallet by the label the service's record gives it, in the same one window:
 * the wallet finishes it only when it drew that label and keeps its creation in
 * the saved keys, and the action's end answer tells this tab what they hold.
 */
export async function finishCompanyInTheWallet(
  accountId: string,
  walletOrigin: string,
  opts: { readonly onStep?: (at: StepAt) => void } = {},
  view: Openable = walletInThisPage(window),
  _atOrigin: string = window.location.origin
): Promise<ActOutcome> {
  const me = currentUser();
  if (!sessionIsLive() || me === null) throw new Error('not signed in');
  const saved = theCreation(accountId);
  if (saved === undefined && canOpenCompanies())
    throw new NoCreationKeptHere('this browser keeps no creation for this company.');
  if (saved !== undefined) refuseWhenNotTheStarter(saved);
  const person = me.id;
  const dialog = openTheWallet(view, walletOrigin);
  const send = walletCallsOnPage(() => currentUser()?.id ?? null);
  try {
    const label = saved !== undefined ? saved.label : (await companyNamedFor(accountId)).label;
    const handedIn = await savedKeysForTheWallet();
    const served = await servedForTheAction(accountId);
    const ended = await actInTheWallet(
      view,
      walletOrigin,
      {
        intent: { name: 'finish-company', company: label },
        relay: (transaction, at) => relayForTheCreation(accountId, transaction, at),
        call: async (request) => {
          if (!signedInAs(person))
            throw new Error('the person signed in changed, so nothing more is sent for this action.');
          /* Only for the company this press finishes: the wallet names the company by its label, this page by its record. */
          if (!creationOnPage.isItsOwn(accountId, request.path))
            throw new Error('finishing this company calls the service for this company alone.');
          return send(request);
        },
        savedKeys: {
          person,
          keyring: handedIn as unknown as KeyringHandedIn,
          served,
          /* Kept only for the person the action runs for: somebody else signed in on this tab since is never written over. */
          keep: async (sealed, ifVersion) => {
            if (!signedInAs(person)) return null;
            return keepWhatTheWalletSealed(sealed as unknown as Sealed, ifVersion);
          }
        },
        ...(opts.onStep === undefined ? {} : { onStep: opts.onStep }),
        minutes: 30,
        name: US_TO_A_WALLET.name,
        rdns: US_TO_A_WALLET.rdns
      },
      dialog
    );
    takeWhatTheActionLeft(ended, accountId);
    return ended;
  } catch (e) {
    putAway(dialog);
    throw e;
  } finally {
    doneWaiting();
    /* The finish gives the company its account on the chain: whatever this page read of the company before is stale, and whoever holds it is told. */
    readsAreStale({ company: accountId, why: STALE.actedInTheWallet, signedIn: true });
  }
}
/* The standings in which the service has already been handed the account's second step, so handing it again is not owed. */
const SECOND_STEP_HANDED: ReadonlySet<CompanyCreationState> = new Set<CompanyCreationState>([
  'finish-sent',
  'pay-key-owed',
  'finished'
]);

/**
 * **WHERE EACH TRANSACTION OF FINISHING A COMPANY GOES**, by what the wallet
 * says it is for (`FINISH_COMPANY_RELAYS`). True once the service has taken it;
 * false for anything else, which stops the action at that step. A name this
 * page does not know is refused, never guessed at.
 */
export async function relayForTheCreation(
  accountId: string,
  transaction: string,
  at: { readonly what?: string; readonly also?: string }
): Promise<boolean> {
  const handed = async (asked: Promise<unknown>): Promise<boolean> => {
    await asked;
    return true;
  };
  switch (at.what) {
    case 'creation':
    case 'creation-again': {
      if (at.also === undefined) return false;
      /* Kept before it is handed on: a copy the service may have sent can land whatever its answer was. */
      CREATIONS_HANDED_ON.set(accountId, [...(CREATIONS_HANDED_ON.get(accountId) ?? []), transaction, at.also]);
      /* The service records the account against the company it was told was founded; tell it first if it was not. */
      const saved = theCreation(accountId);
      if (saved !== undefined) await sendTheCompany(saved);
      /*
       * WHERE THE CREATION GOES IS WHAT THE SERVICE HOLDS, not what the wallet
       * did: the wallet cannot know whether a relay answered late was recorded.
       * A deploy the service holds and says may be replaced takes the one carried
       * again in its place; anything else goes to the creation itself, which
       * records a first deploy and sends the recorded one again.
       */
      const held = await companyCreationStanding(accountId);
      const replaces = held.state !== 'not-created' && held.replaceable === true;
      return handed(creationOnPage.handedOn(accountId, { deploy: transaction, insert: at.also }, replaces));
    }
    case 'creation-finish': {
      /* Handed again after a stop: already with the service, so nothing more is sent and the wallet carries on. */
      if (SECOND_STEP_HANDED.has((await companyCreationStanding(accountId)).state)) return true;
      return handed(creationOnPage.finished(accountId, { insert: transaction }));
    }
    case 'pay-key-approve':
      return handed(creationOnPage.payKey(accountId, { call: 'approve', tx: transaction }));
    case 'pay-key-seal':
      return handed(creationOnPage.payKey(accountId, { call: 'sealPayKey', tx: transaction }));
    default:
      return false;
  }
}

/** **WHETHER A COMPANY IS FINISHED**, as the service reads its record and the chain. */
export async function companyCreationStanding(
  accountId: string
): Promise<{ account: AccountAddress | null; state: CompanyCreationState; replaceable?: boolean }> {
  let answer;
  try {
    answer = (await creationOnPage.standing(accountId)) as {
      state?: unknown;
      account?: unknown;
      replaceable?: unknown;
    };
  } catch (e) {
    /* A company this browser keeps that the service never stored (the first press's send failed) is not created. */
    if (e instanceof NotOnTheService && theCreation(accountId) !== undefined)
      return { account: null, state: 'not-created' };
    throw e;
  }
  const state = creationStateOf(answer.state);
  if (typeof answer.replaceable === 'boolean') {
    return { account: readAccountAddress(answer.account), state, replaceable: answer.replaceable };
  }
  return { account: readAccountAddress(answer.account), state };
}

/** A state the service named, or `unknown` for anything this page does not know. */
const creationStateOf = (s: unknown): CompanyCreationState => COMPANY_CREATION_STATES.find((k) => k === s) ?? 'unknown';
