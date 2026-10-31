import type { SealedAccount } from '../../../../src/core/types.js';
import { provedSeatsOf, type BelievedAccount } from 'vaults-web-shared/roster-here.js';
import { rosterEntryRefusal, type RosterWitnesses } from '../../../../src/core/roster-record.js';
import type { OpenedVaultKeysOffer } from '../../../../src/core/vault-keys.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { READER_REFUSAL, rosterRefusalOf } from '../../../../src/midnight/secret-readers.js';
import { actOnACompanyInTheWallet, api, canOpenCompanies, openKeysWithWallet } from 'vaults-web-shared/keyring.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  SAID, START_STOP, type SaidCode, type StartStopCode, type VaultInfoGiven,
} from 'vaults-web-shared/vault-operation.js';
import { readersIn } from 'vaults-web-shared/vault-page-doors.js';
import { Fault, FAULT } from '../faults.js';
import { companyRoute } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { companyKeysFor, directoryHereFor, openedHere } from './filing-judge.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { offersOpenHere } from './vault-keys.js';

/*
 * CREATING A COMPANY'S VAULT, AS ONE ACTION IN THE PERSON'S WALLET.
 *
 * The wallet runs the whole of it: it gives this person's own vault keys,
 * reads the committee the vault is born held by from the chain, builds and
 * proves the vault and every step of its start, makes the vault's secret and
 * seals it only to the seats the chain holds, and hands each transaction and
 * filing to this page to send. This file names the company to it from the
 * service's public record of it, makes the calls to the service the action's
 * route list names, and turns where the action ended into a fixed state or
 * reason. It signs nothing and holds no seat's secret.
 *
 * A VAULT SENT AND NOT YET STARTED IS SAID AS THAT, WITH ITS ADDRESS. The vault takes no money until it is started,
 * and `finishStarting` has the wallet carry on from where the chain shows it stopped.
 */

/**
 * Where creating a vault has got to, each said on the screen in its own words. The wallet's action reports only which
 * of its steps it is on (`stageOfTheStep`): `building` while it builds, sends and starts the vault, `checking` while it
 * brings the company's records up to date and files this person's vault keys before that and the records after it,
 * and `done` once it has ended.
 */
export const CREATING = { checking: 'checking', building: 'building', done: 'done' } as const;
export type Creating = (typeof CREATING)[keyof typeof CREATING];

/**
 * The wallet's actions as their entries name them, and the keys of what the create-vault action tells this page when
 * it ends; compared and sent, never shown.
 */
const WALLET = {
  createVault: 'create-vault', giveVaultKeys: 'give-vault-keys',
  vault: 'vault', said: 'said', stopped: 'stopped', round: 'round', approvals: 'approvals', needed: 'needed',
  adoption: 'adoption', firstSecret: 'first-secret',
} as const;

/**
 * The stage a step of the wallet's create-vault action is shown as. The action's steps are, in order: the company's
 * records brought up to date, this person's directory entry, their vault keys offered, the vault built, sent and
 * started, and the company's records filed again; so the step before the last is the vault's own.
 */
const stageOfTheStep = (at: { readonly step: number; readonly steps: number }): Creating =>
  (at.step === at.steps - 1 ? CREATING.building : CREATING.checking);


export { SAID };
export type { SaidCode };

/**
 * What creating a vault, or carrying one on, came to. `done` is a vault started. `said`, on a vault
 * started or waiting, is the kind of each thing the press could not leave in the company's records - its name, or a
 * setup proposal - for the page to word; the vault carries on without them.
 */
export type VaultCreated =
  | { of: typeof ACTED.done; vault: string; said?: readonly SaidCode[] }
  /**
   * Sent and not started: finishing it carries on, unless `stopped` says otherwise.
   * `stopped` when it stopped for a reason of its own, and what resolves it.
   */
  | { of: typeof STARTING.owed; vault: string; stopped?: StartStopped }
  /** One round of its start waits for other signers' approvals: which, and how many it has and needs. */
  | { of: typeof STARTING.awaiting; vault: string; round: 'adoption' | 'first-secret'; approvals: number; needed: number; said?: readonly SaidCode[] }
  | { of: typeof ACTED.refused; why: ActRefusal };

/** A vault sent whose start is not finished, or waits on other signers. */
export const STARTING = { owed: 'start-owed', awaiting: 'awaiting-approvals' } as const;

/**
 * **WHAT STOPPED A START, AND WHAT RESOLVES IT**, said on the screen in its own
 * words: the wallet reading the company again or being asked again, the
 * directory read again, every signer set up for vaults, the signers changed,
 * or nothing a press can clear, because the vault cannot be set up as it
 * stands.
 */
export const STOPPED = {
  wallet: 'wallet', walletAsk: 'wallet-ask', directory: 'directory', signers: 'signers', mismatch: 'mismatch',
  adoptionStale: 'adoption-stale', tooFewApprovers: 'too-few-approvers', readersCannotOpen: 'readers-cannot-open',
  anotherSecret: 'another-secret', readBackOnly: 'read-back-only',
} as const;
export type StartStopped = (typeof STOPPED)[keyof typeof STOPPED];
const STOPPED_BY: Record<StartStopCode, StartStopped> = {
  [READER_REFUSAL.walletReadNothing]: STOPPED.wallet,
  [READER_REFUSAL.directoryUnread]: STOPPED.directory,
  [READER_REFUSAL.keysNotGiven]: STOPPED.signers,
  [READER_REFUSAL.notSigned]: STOPPED.mismatch,
  [READER_REFUSAL.seatNotHeld]: STOPPED.signers,
  [READER_REFUSAL.rosterNotTheChains]: STOPPED.mismatch,
  [READER_REFUSAL.readerNotASigner]: STOPPED.mismatch,
  [READER_REFUSAL.signerLeftOut]: STOPPED.mismatch,
  [READER_REFUSAL.vaultNotTheCompanys]: STOPPED.mismatch,
  [START_STOP.walletNotAnswered]: STOPPED.walletAsk,
  [START_STOP.adoptionStale]: STOPPED.adoptionStale,
  [START_STOP.tooFewApprovers]: STOPPED.tooFewApprovers,
  [START_STOP.readersCannotOpen]: STOPPED.readersCannotOpen,
  [START_STOP.anotherSecret]: STOPPED.anotherSecret,
  [START_STOP.readBackOnly]: STOPPED.readBackOnly,
};

/** Whether finishing the set-up again can clear this stop: not where the vault cannot be set up as it stands. */
export const pressingAgainCanClear = (stopped: StartStopped | undefined): boolean =>
  stopped !== STOPPED.mismatch && stopped !== STOPPED.adoptionStale && stopped !== STOPPED.anotherSecret && stopped !== STOPPED.readBackOnly;

/** Whether a vault can be created now, and if not, why, each said on the screen in its own words. */
export const READY = {
  /** Every active signer this device believes has vault keys it can open, on a seat the directory holds. */
  ready: 'ready',
  /** This person has not given their vault keys yet. */
  yoursMissing: 'yours-missing',
  /** This person has; not every other signer has yet. */
  othersMissing: 'others-missing',
  /** The company has no contract on the chain, or no label this device can read it by, yet. */
  notOnChain: 'not-on-chain',
  /** The keys saved for this person are not open in this tab: their wallet opens them when they approve. */
  locked: 'locked',
} as const;
export type Ready = (typeof READY)[keyof typeof READY];
export type Readiness = { of: Ready } | { of: typeof ACTED.refused; why: ActRefusal };

/** The service's addresses and the words of its answers, compared and never shown. */
const SERVICE = { vaultKeys: '/vault-keys', offers: '/offers', authority: '/authority' } as const;

type Opened = {
  sealed: SealedAccount; keys: NonNullable<Awaited<ReturnType<typeof keysOnTheWayIn>>>; roster: () => Promise<BelievedAccount>;
  /** The company's keys as this device believes them (`companyKeysFor`). */
  companyKeys: CompanyKeyHere;
};

/** Keys saved for the person that are not open in this tab, and a read that does not ask the wallet to open them. */
const LOCKED = READY.locked;

/**
 * The company as this device opens it, for this person, or why not: read with
 * this seat's public halves and the keys the person's wallet opened for this
 * tab, never a seat's secret. The wallet is asked to read the keys saved for
 * them when `open` says to (an action the person pressed); a read never asks
 * it, and says the keys are not open yet rather than that they are on another
 * device.
 */
async function opened(personId: string, companyId: string, open: boolean): Promise<Opened | ActRefusal | typeof LOCKED> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  if (!canOpenCompanies(companyId)) {
    if (!open) return LOCKED;
    await openKeysWithWallet(ACCOUNT_ORIGIN);
  }
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  const keys = await keysOnTheWayIn(companyId);
  if (keys === null) return ACT_REFUSAL.noKeysHere;
  const roster = async () => {
    const account = await openedHere(await api(companyRoute(companyId)) as SealedAccount);
    /* The keys for this company were found just above, so it opens; a company that does not is a fault in this code. */
    if (account === null) throw new Fault(FAULT.vaultCompanyDidNotOpen);
    return account;
  };
  return { sealed, keys, roster, companyKeys: await companyKeysFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey }) };
}

/**
 * WHETHER A VAULT CAN BE CREATED NOW for the company `companyId`, read from
 * what the signers themselves have given and this device believes, never from
 * a committee the service reports: a vault is ready when every active signer
 * of the roster this device believes has vault keys it can open - folded into
 * that roster, or still open as the signer's own offer - on a seat the
 * company's directory holds for them, which is a reader only when the signer's
 * own wallet attested the records key that seat names. These are the readers
 * the vault's start wraps its secret to. It is ready only when the first
 * secret's own check of the signers against the account (`rosterRefusalOf`)
 * would pass over that roster; an open offer counts only when the fold would
 * take it. A signer short of keys is this person's (`yoursMissing`) or
 * another's (`othersMissing`, which is also said while that check refuses).
 * Nothing is asked of the wallet.
 */
export async function readVaultReadiness(personId: string, companyId: string): Promise<Readiness> {
  try {
    const o = await opened(personId, companyId, false);
    if (o === LOCKED) return { of: READY.locked };
    if (typeof o === 'string') return { of: ACTED.refused, why: o };
    const label = o.sealed.companyLabel, account = o.sealed.contractAddress;
    const authority = await api(companyRoute(companyId, SERVICE.authority)) as { company?: unknown } | null;
    if (authority?.company === null || typeof label !== 'string' || typeof account !== 'string') return { of: READY.notOnChain };
    const [named, served] = await Promise.all([o.roster(), api(companyRoute(companyId, SERVICE.vaultKeys + SERVICE.offers))]);
    const [companyLabel, accountAddress] = [label as CompanyLabel, account as AccountAddress];
    const offers = offersOpenHere(companyId, served, o.companyKeys, companyLabel, accountAddress);
    /*
     * The roster as pressing Create would fold it: a signer with no keys in the roster takes the keys of their own open
     * offer, on their own seat, and only an offer the fold would take (`rosterEntryRefusal`, against the seats and entries
     * the directory shows). Those keys count only if the signer's own signing key signed them (`rosterVaultKeys`), and
     * their wallet's statement in them is what makes their seat a reader the directory believes.
     */
    const withOffers = (taken: (s: BelievedAccount['signers'][number], offer: OpenedVaultKeysOffer) => boolean) => ({
      ...named, signers: named.signers.map((s) => {
        const offer = s.vaultKeys === undefined || s.vaultKeys === null ? offers.get((s.leafCommitment ?? '').toLowerCase()) : undefined;
        return offer === undefined || !taken(s, offer) ? s : { ...s, vaultKeys: offer.keys };
      }),
    });
    const readFor = (roster: typeof named) => directoryHereFor(companyId, companyLabel, accountAddress, o.companyKeys, async () => roster)();
    const before = await readFor(withOffers(() => true));
    const witnesses: RosterWitnesses = {
      accountId: companyId, label: companyLabel, account: accountAddress, seatsOnTheChain: before.holders.seats,
      directory: provedSeatsOf(before.dir.seats), own: null, retired: before.dir.seats.filter((x) => x.retired !== null).map((x) => x.seat),
    };
    let dropped = false;
    const takenByTheFold = (s: BelievedAccount['signers'][number], offer: OpenedVaultKeysOffer): boolean => {
      const taken = rosterEntryRefusal({ ...s, vaultKeys: offer.keys, directoryEntry: { committeeKey: offer.entry.committeeKey, statement: offer.entry.statement } }, witnesses) === null;
      dropped = dropped || !taken;
      return taken;
    };
    const offered = withOffers(takenByTheFold);
    /* An offer the fold would refuse attests nothing: the directory is read again without it. */
    const here = dropped ? await readFor(offered) : before;
    const readers = await readersIn(async () => here).signers();
    const keyed = new Map(rosterVaultKeys(offered).map((r) => [r.signerId, r.keys]));
    const given = (s: BelievedAccount['signers'][number]): boolean => {
      const reader = readers.find((x) => x.id.toLowerCase() === (s.leafCommitment ?? '').toLowerCase());
      return reader !== undefined && (keyed.get(s.id) ?? null) !== null;
    };
    /* The first secret's own check of the signers against the account, over the roster as it would then stand. */
    const refused = rosterRefusalOf({
      company: companyLabel, account: accountAddress, roster: rosterVaultKeys(offered), seats: { seats: here.holders.seats },
      directory: { seats: here.dir.seats, leafOf: here.leafOf },
    });
    const short = named.signers.filter((s) => s.status === 'active' && !given(s));
    const mine = named.signers.find((s) => s.status === 'active' && s.id === o.keys.signerId);
    if (mine === undefined || short.includes(mine)) return { of: READY.yoursMissing };
    return { of: short.length === 0 && refused === null ? READY.ready : READY.othersMissing };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}




/** What a stopped start of a vault is told as, by the code the wallet's action ended with. */
const STOPPED_CODES = new Set<string>(Object.keys(STOPPED_BY));
const SAID_CODES = new Set<string>(Object.values(SAID));

/**
 * The company as the service names it in public: its record, label and
 * account, which the wallet checks on the chain itself before it acts. Null
 * for a company with no account on the chain yet.
 */
export const namedFor = async (companyId: string): Promise<{ record: string; company: string; account: string } | null> => {
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  const company = sealed?.companyLabel, account = sealed?.contractAddress;
  return typeof company === 'string' && typeof account === 'string' ? { record: companyId, company, account } : null;
};

/**
 * CREATE A VAULT for the company `companyId`, born held by its committee, or,
 * with `resume`, carry on starting the vault named: one action in the person's
 * wallet, which gives their own vault keys first, then builds, proves and signs
 * every step itself and hands each to this page to send. This page names the
 * company and the vault's name and description, and reads back only where the
 * action got to.
 */
async function run(
  personId: string, companyId: string, onStage: (stage: Creating) => void, resume?: string, info?: VaultInfoGiven,
): Promise<VaultCreated> {
  try {
    if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const named = await namedFor(companyId);
    if (named === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    onStage(CREATING.checking);
    const ended = await actOnACompanyInTheWallet({
      name: WALLET.createVault, ...named,
      ...(resume === undefined ? {} : { vault: resume.toLowerCase() }),
      ...(info === undefined ? {} : { title: info.name.trim(), about: info.description.trim() }),
    }, ACCOUNT_ORIGIN, { onStep: (at) => onStage(stageOfTheStep(at)) });
    const told = ended.outcome ?? {};
    const toldVault = told[WALLET.vault], toldSaid = told[WALLET.said];
    const vault = typeof toldVault === 'string' ? toldVault : null;
    const said = typeof toldSaid === 'string'
      ? { said: toldSaid.split(',').filter((c): c is SaidCode => SAID_CODES.has(c)) } : {};
    if (ended.of === 'stopped') {
      if (vault === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
      const stopped = told[WALLET.stopped];
      return typeof stopped === 'string' && STOPPED_CODES.has(stopped)
        ? { of: STARTING.owed, vault, stopped: STOPPED_BY[stopped as StartStopCode] }
        : { of: STARTING.owed, vault };
    }
    if (vault === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    onStage(CREATING.done);
    const round = told[WALLET.round];
    if (round === WALLET.adoption || round === WALLET.firstSecret) {
      /* The wallet tells each count as a number; one it did not tell is none. */
      const count = (of: string): number => { const n = told[of]; return typeof n === 'number' ? n : 0; };
      return { of: STARTING.awaiting, vault, round, approvals: count(WALLET.approvals), needed: count(WALLET.needed), ...said };
    }
    return { of: ACTED.done, vault, ...said };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * Asks the person's wallet to read their saved keys for this tab, in one window, so their companies open here.
 * Resolves done, or the refusal: no wallet set up, nobody signed in, or the wallet declined.
 */
export async function openYourKeys(personId: string): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
  try {
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    await openKeysWithWallet(ACCOUNT_ORIGIN);
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/**
 * CREATE A VAULT for the company, held by the company's committee from its deploy, as one action in the person's
 * wallet. `info`, when given, is the vault's name and description, filed in the company's records right after the deploy.
 */
export const createVault = (personId: string, companyId: string, onStage: (stage: Creating) => void, info?: VaultInfoGiven): Promise<VaultCreated> =>
  run(personId, companyId, onStage, undefined, info);

/**
 * CARRY ON SETTING UP the vault `vault`, which the committee has held since it was sent and which is not started: from
 * any signer's wallet, which approves its adoption and its first secret with this signer's own keys once every key that
 * secret is sealed to checks out. `info`, when given, is the vault's name and description, filed before the set up
 * carries on, for a vault none was filed for; one filed already is kept and said.
 */
export const finishStarting = (
  personId: string, companyId: string, vault: string, onStage: (stage: Creating) => void, info?: VaultInfoGiven,
): Promise<VaultCreated> => run(personId, companyId, onStage, vault, info);

/**
 * GIVE YOUR VAULT KEYS to the company `companyId`, on their own: one action in
 * the person's wallet, which signs their records key and directory entry,
 * files the entry and offers the company their seat's vault keys itself.
 */
export async function giveYourVaultKeys(personId: string, companyId: string): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  try {
    if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const named = await namedFor(companyId);
    if (named === null) return { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
    const ended = await actOnACompanyInTheWallet({ name: WALLET.giveVaultKeys, ...named }, ACCOUNT_ORIGIN);
    return ended.of === 'done' ? { of: ACTED.done } : { of: ACTED.refused, why: ACT_REFUSAL.didNotFinish };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
