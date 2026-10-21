import type { SealedAccount } from '../../../../src/core/types.js';
import { recordsEnteredOver } from 'vaults-web-shared/record-entered-here.js';
import { provedSeatsOf, type BelievedAccount } from 'vaults-web-shared/roster-here.js';
import { rosterEntryRefusal, type RosterWitnesses } from '../../../../src/core/roster-record.js';
import type { OpenedVaultKeysOffer } from '../../../../src/core/vault-keys.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { approverRosterFrom } from '../../../../src/core/vault-approvers.js';
import { READER_REFUSAL, rosterRefusalOf } from '../../../../src/midnight/secret-readers.js';
import {
  api, canOpenCompanies, currentUser, holdersFromTheWallet, openKeysWithWallet, recordsKeyFromTheWallet,
} from 'vaults-web-shared/keyring.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import { governedCallServiceFor } from 'vaults-web-shared/governed-call-on-device.js';
import {
  createCompanyVault, NOT_BUILT, SAID, START_STOP, VaultNotBuilt, VaultNotTheCompanys, VaultStartOwed,
  type NotBuiltCode, type SaidCode, type StartStopCode, type VaultInfoGiven, type VaultStage,
} from 'vaults-web-shared/vault-operation.js';
import { VaultInfoRefused, vaultInfoRecordsFor } from 'vaults-web-shared/vault-info-here.js';
import {
  deviceRecordsFor, deviceSignerFrom, marked, readersIn, vaultServiceFor,
} from 'vaults-web-shared/vault-page-doors.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import type { VaultService } from 'vaults-web-shared/vault-operation.js';
import { Fault, FAULT } from '../faults.js';
import { companyRoute } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { companyKeysFor, directoryHereFor, filingJudgeFor, openedHere, walletIndexerFor } from './filing-judge.js';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { giveTheVaultKeys, offersOpenHere } from './vault-keys.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * CREATING A COMPANY'S VAULT, OVER THE SHARED OPERATION, IN ITS ORDER.
 *
 * `createCompanyVault` is where the order lives: the committee the vault is
 * born held by is read from the chain, the vault is built and proved on this
 * device already held by it, and the deploy is sent. The operation then reads
 * the vault back as it was born and starts it - adopted by the company's
 * account, its adoption and first secret run written down as the company's
 * proposals by this seat, its pool
 * and nonce secret filed (or read back and checked against the chain), its first secret set, every signer's
 * sealed copy written - and ends only when the chain shows it started, or
 * names the proposal that waits for other signers' approvals. This file brings it
 * the keys this person's account gives for the company, this signer's own
 * three and records, the company's vault routes checked against the roster
 * this device opens, and the part of the page that builds vault transactions;
 * and it turns the answer into a fixed state or reason. It keeps nothing, and
 * decides nothing the operation does not.
 *
 * A VAULT SENT AND NOT YET STARTED IS SAID AS THAT, WITH ITS ADDRESS. The vault takes no money until it is started,
 * and `finishStarting` picks the operation up where it stopped.
 */

/**
 * Where creating a vault has got to, as the operation reports it, each said on
 * the screen in its own words: the vault built and sent, then started, which is the company's account adopting it, its private records
 * opened and read back, its secret set and a sealed copy written for each
 * signer, waiting for other signers' approvals wherever a round needs them.
 */
export const CREATING = {
  checking: 'checking', building: 'building', sending: 'sending', waitingForChain: 'waiting-for-chain',
  filingTheName: 'filing-the-name', adopting: 'adopting', openingThePool: 'opening-the-pool', readingTheSecretBack: 'reading-the-secret-back',
  settingTheSecret: 'setting-the-secret', writingTheCopies: 'writing-the-copies', waitingForApprovals: 'waiting-for-approvals',
  done: 'done',
} as const;
export type Creating = (typeof CREATING)[keyof typeof CREATING];

/** The operation's own stages, each to the one a screen says; a stage of another operation is none of these, and is not passed on. */
const STAGE: Partial<Record<VaultStage, Creating>> = {
  'checking the committee': CREATING.checking,
  'building the vault': CREATING.building,
  'sending the vault': CREATING.sending,
  'waiting for the chain': CREATING.waitingForChain,
  'filing the name': CREATING.filingTheName,
  'adopting the vault': CREATING.adopting,
  'opening the pool': CREATING.openingThePool,
  'reading the secret back': CREATING.readingTheSecretBack,
  'setting the secret': CREATING.settingTheSecret,
  'writing the sealed copies': CREATING.writingTheCopies,
  'waiting for approvals': CREATING.waitingForApprovals,
  done: CREATING.done,
};

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
export const STOPPED_BY: Record<StartStopCode, StartStopped> = {
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
  /** The keys saved for this person are not open in this tab: their account opens them when they approve. */
  locked: 'locked',
} as const;
export type Ready = (typeof READY)[keyof typeof READY];
export type Readiness = { of: Ready } | { of: typeof ACTED.refused; why: ActRefusal };

/** The service's addresses and the words of its answers, compared and never shown. */
const SERVICE = {
  vaultKeys: '/vault-keys', offers: '/offers', authority: '/authority', vaults: '/vaults', slash: '/',
  startAccount: '/start/account', startSecret: '/start/secret', startCopy: '/start/copy', post: 'POST',
  proposals: '/api/proposals/', carried: '/carried',
} as const;

/** The company's routes a vault's start is sent through, beside the vault routes the page already calls. */
const withTheStart = (companyId: string, service: VaultService): VaultService => {
  const at = (vault: string, route: string) => companyRoute(companyId, SERVICE.vaults + SERVICE.slash + vault + route);
  /* A refusal keeps the service's own mark of whether anything was sent, as the page's other vault routes do. */
  const post = (path: string, body: unknown) => marked(() => api(path, { method: SERVICE.post, body: JSON.stringify(body) }));
  return {
    ...service,
    startAccountCall: (vault, body) => post(at(vault, SERVICE.startAccount), body),
    startSecret: (vault, tx) => post(at(vault, SERVICE.startSecret), { tx }),
    startCopy: (vault, tx, place) => post(at(vault, SERVICE.startCopy), { tx, place }),
  };
};

type Opened = {
  sealed: SealedAccount; keys: NonNullable<Awaited<ReturnType<typeof keysOnTheWayIn>>>; roster: () => Promise<BelievedAccount>;
  /** The company's keys as this device believes them (`companyKeysFor`). */
  companyKeys: CompanyKeyHere;
};

/** Keys saved for the person that are not open in this tab, and a read that does not ask the account to open them. */
const LOCKED = READY.locked;

/**
 * The company as this device opens it, for this person, or why not. The keys
 * saved for them are opened with their account when `open` says to (an
 * action the person pressed); a read never asks the account, and says the
 * keys are not open yet rather than that they are on another device.
 */
async function opened(personId: string, companyId: string, open: boolean): Promise<Opened | ActRefusal | typeof LOCKED> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  if (!canOpenCompanies()) {
    if (!open) return LOCKED;
    await openKeysWithWallet(ACCOUNT_ORIGIN);
  }
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  const keys = await keysOnTheWayIn(companyId, async () => sealed);
  if (keys === null) return ACT_REFUSAL.noKeysHere;
  const roster = async () => {
    const account = await openedHere(await api(companyRoute(companyId)) as SealedAccount);
    /* The keys for this company were found just above, so it opens; a company that does not is a fault in this code. */
    if (account === null) throw new Fault(FAULT.vaultCompanyDidNotOpen);
    return account;
  };
  return { sealed, keys, roster, companyKeys: await companyKeysFor(companyId, sealed, keys) };
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
 * Nothing is asked of the account.
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

/** How long the operation waits between asks of the chain. */
const pacing = (onStage: (stage: Creating) => void) => ({
  sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }),
  progress: (stage: VaultStage) => { const s = STAGE[stage]; if (s !== undefined) onStage(s); },
});

/** The refusal each way the operation declines to build a vault is said as. */
export const NOT_BUILT_AS: Record<NotBuiltCode, ActRefusal> = {
  [NOT_BUILT.seatUnknown]: ACT_REFUSAL.seatUnknown,
  [NOT_BUILT.seatNotBelieved]: ACT_REFUSAL.seatNotBelieved,
  [NOT_BUILT.seatMayNotRaise]: ACT_REFUSAL.seatMayNotRaise,
  [NOT_BUILT.committeeUnread]: ACT_REFUSAL.committeeUnread,
  [NOT_BUILT.committeeNotInstallable]: ACT_REFUSAL.committeeNotInstallable,
  [NOT_BUILT.pageOutOfDate]: ACT_REFUSAL.pageOutOfDate,
};

/**
 * What a press the operation refused is said as: each of its own refusals by its own kind, a refusal from the
 * service marked as having sent nothing as that, and anything else by the kind `refusalOf` tells it apart by.
 */
const createRefusalOf = (e: unknown): ActRefusal => {
  if (e instanceof VaultNotBuilt) return NOT_BUILT_AS[e.code];
  if (e instanceof VaultNotTheCompanys) return ACT_REFUSAL.vaultNotTheCompanys;
  if (e instanceof VaultInfoRefused) return ACT_REFUSAL.vaultInfoRefused;
  return (e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true ? ACT_REFUSAL.nothingSent : refusalOf(e);
};

/**
 * CREATE A VAULT for the company `companyId`, born held by its committee, or,
 * with `resume`, carry on starting the vault named. The company's keys come
 * from this person's account first, and their own vault keys are given with
 * them (the service keeps the first set).
 */
async function run(
  personId: string, companyId: string, onStage: (stage: Creating) => void, resume?: string, info?: VaultInfoGiven,
): Promise<VaultCreated> {
  try {
    const o = await opened(personId, companyId, true);
    if (typeof o === 'string') return { of: ACTED.refused, why: o === LOCKED ? ACT_REFUSAL.didNotFinish : o };
    const released = await giveTheVaultKeys(companyId, o.keys, o.companyKeys, o.roster);
    if (released.of === ACTED.refused) return released;
    const service = withTheStart(companyId, vaultServiceFor(api, companyId, o.roster));
    /* This signer's own pool, journals and records, over the records route, wrapped to the seats the directory names now. */
    const directoryRead = directoryHereFor(companyId, released.company, released.account, o.companyKeys, o.roster);
    const readers = readersIn(directoryRead);
    const entered = recordsEnteredOver(api, companyId, o.keys.signingSecret);
    const proposalsService = governedCallServiceFor(api);
    const companyKeys: CompanyKeyHere = o.companyKeys;
    const done = await createCompanyVault({
      ...pacing(onStage), account: released.account, service,
      builder: await theVaultBuilder(),
      me: deviceSignerFrom(released.signed.statement.seat, released.companyKey),
      myRecordsKey: recordsKeypairFrom(fromHex(released.companyKey)).publicKey as Hex,
      signers: readers.signers,
      records: deviceRecordsFor(o.keys.signingSecret, filingJudgeFor(companyId, released.company, released.account, o.companyKeys, o.roster),
        () => currentUser()?.id ?? null, entered),
      vaultInfo: vaultInfoRecordsFor(companyId, o.keys.signingSecret,
        filingJudgeFor(companyId, released.company, released.account, o.companyKeys, o.roster), () => currentUser()?.id ?? null),
      /* The vault's adoption and first secret run, written down as the company's proposals by this seat and raised with them. */
      proposals: {
        accountId: companyId, directory: directoryRead, companyKeys, signingSecret: o.keys.signingSecret, entered,
        carried: (id, body) => api(SERVICE.proposals + id + SERVICE.carried, { method: SERVICE.post, body: JSON.stringify(body) }),
        service: {
          callState: proposalsService.callState, send: proposalsService.send,
          file: proposalsService.file!, sealedProposals: proposalsService.sealedProposals!,
        },
      },
      material: { signingSecret: o.keys.signingSecret, blinding: o.keys.blinding, scope: (o.keys as { scope?: Hex }).scope },
      /* The vault's company account as this person's own wallet reads it for each step, with no press. */
      onChain: async () => ({
        holders: (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account })).holders,
      }),
      /* The vault itself is read in this device's vault worker, at the indexer this person's own wallet names. */
      indexer: () => walletIndexerFor(released.company, released.account),
      secretReaders: {
        company: released.company,
        /*
         * Who holds the company and the vault, asked of this signer's account afresh for every check, so a check
         * after a wait never rests on what was read before it; the vault is read by the account itself. The same
         * screen shows the person who will hold the vault's first secret: a confirmation, not a lock on the chain.
         */
        read: async (vault, firstSecret) => {
          const now = await recordsKeyFromTheWallet(ACCOUNT_ORIGIN, {
            company: released.company, account: released.account, seat: released.signed.statement.seat, vault: vault as string as VaultAddress,
            ...(firstSecret === undefined ? {} : { firstSecret }),
          });
          return { ...now.seats, vault: now.vault };
        },
        roster: async () => rosterVaultKeys(await o.roster()),
        /* Each reader's seat's opening, from the company's directory as this device believes it, read afresh. */
        directory: async () => {
          const here = await directoryRead();
          return { seats: here.dir.seats, leafOf: here.leafOf };
        },
      },
      /*
       * The company as this device counts it before the adoption is raised, approved or carried out: the account's
       * threshold, each vault's own and the vaults it holds, all as this person's own wallet reads the account, and the
       * seated signers with the rights the roster records for them - only those whose seat the wallet reads the account
       * holding, so a signer the roster names that the chain does not seat is not counted among those who can approve.
       */
      approvers: async () => {
        const [account, held, wide] = await Promise.all([
          o.roster(),
          /* Refused, with what was not read, when the wallet could not read the account. */
          holdersFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account }),
          (await theVaultBuilder()).companyWide(),
        ]);
        const onTheChain = new Set(held.holders.seats.map((x) => x.toLowerCase()));
        return approverRosterFrom({
          threshold: held.holders.approvals, vaultThresholds: held.holders.vaultThresholds,
          seated: account.signers.filter((x) => x.status === 'active' && x.leafCommitment !== null && onTheChain.has(x.leafCommitment.toLowerCase()))
            .map((x) => ({ leaf: x.leafCommitment!, ...(x.rights === undefined ? {} : { rights: x.rights }) })),
          adoptedVaults: held.holders.adoptedVaults, companyWide: wide,
        });
      },
      vaultName: (vault) => vault,
    }, resume as Parameters<typeof createCompanyVault>[1], info);
    const said = done.saidCodes === undefined ? {} : { said: done.saidCodes };
    if (done.state === 'awaiting-approvals') {
      return { of: STARTING.awaiting, vault: done.vault, ...done.awaiting, ...said };
    }
    return { of: ACTED.done, vault: done.vault, ...said };
  } catch (e) {
    if (e instanceof VaultStartOwed) {
      return e.stoppedAt === undefined ? { of: STARTING.owed, vault: e.vault } : { of: STARTING.owed, vault: e.vault, stopped: STOPPED_BY[e.stoppedAt] };
    }
    return { of: ACTED.refused, why: createRefusalOf(e) };
  }
}

/** Whether this browser holds the key `vault` was created with; false when it does not, or when its store cannot be read. */
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
 * CREATE A VAULT for the company, held by the company's committee from its deploy. `info`, when given, is the
 * vault's name and description, filed in the company's records right after the deploy.
 */
export const createVault = (personId: string, companyId: string, onStage: (stage: Creating) => void, info?: VaultInfoGiven): Promise<VaultCreated> =>
  run(personId, companyId, onStage, undefined, info);

/**
 * CARRY ON SETTING UP the vault `vault`, which the committee has held since it was sent and which is not started: from
 * any signer's device, which approves its adoption and its first secret with this signer's own keys once every key that
 * secret is sealed to checks out. `info`, when given, is the vault's name and description, filed before the set up
 * carries on, for a vault none was filed for; one filed already is kept and said.
 */
export const finishStarting = (
  personId: string, companyId: string, vault: string, onStage: (stage: Creating) => void, info?: VaultInfoGiven,
): Promise<VaultCreated> => run(personId, companyId, onStage, vault, info);

/**
 * GIVE YOUR VAULT KEYS for the company `companyId`, where creating a vault
 * waits on them, so a vault can be created once every signer has. Nothing but
 * the keys is sent.
 */
export async function giveYourVaultKeys(personId: string, companyId: string): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  try {
    const o = await opened(personId, companyId, true);
    if (typeof o === 'string') return { of: ACTED.refused, why: o === LOCKED ? ACT_REFUSAL.didNotFinish : o };
    const given = await giveTheVaultKeys(companyId, o.keys, o.companyKeys, o.roster);
    if (given.of === ACTED.refused) return given;
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
