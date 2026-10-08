import type { SealedAccount } from '../../../../src/core/types.js';
import type { BelievedAccount } from 'vaults-web-shared/roster-here.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { approverRosterFrom } from '../../../../src/core/vault-approvers.js';
import { READER_REFUSAL, type ReaderRefusalCode } from '../../../../src/midnight/secret-readers.js';
import { whyNotTheCommittee } from 'vaults-web-shared/handover-check.js';
import {
  api, canOpenCompanies, currentUser, holdersFromTheWallet, openKeysWithWallet, recordsKeyFromTheWallet, viewingKeyFor,
} from 'vaults-web-shared/keyring.js';
import type { VaultAddress } from 'midnight-identity/profile/company-label';
import { createCompanyVault, VaultHandoverOwed, VaultStartOwed, type VaultStage } from 'vaults-web-shared/vault-operation.js';
import { governedCallServiceFor } from 'vaults-web-shared/governed-call-on-device.js';
import {
  browserTemporaryKeys, deviceRecordsFor, deviceSignerFrom, marked, readersIn, vaultServiceFor,
} from 'vaults-web-shared/vault-page-doors.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { fromHex, type Hex } from '../../../../src/core/crypto.js';
import type { VaultService } from 'vaults-web-shared/vault-operation.js';
import { Fault, FAULT } from '../faults.js';
import { companyRoute } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { directoryHereFor, filingJudgeFor, openedHere, walletIndexerFor } from './filing-judge.js';
import { giveTheVaultKeys } from './vault-keys.js';
import { theVaultBuilder } from './vault-builder.js';
import { handoverOwed, readVaultRows } from './vault-rows.js';

/*
 * CREATING A COMPANY'S VAULT, OVER THE SHARED OPERATION, IN ITS ORDER.
 *
 * `createCompanyVault` is where the order lives: the committee is checked,
 * the vault is built and proved on this device with a key made here, that key
 * is kept in this browser before anything is sent, the vault is sent, and it
 * is handed to the company's committee as soon as the chain has it. The
 * operation then starts the vault - adopted by the company's account, its pool
 * and nonce secret filed (or read back and checked against the chain), its first secret set, every signer's
 * sealed copy written - and ends only when the chain shows it started, or
 * names the proposal that waits for other signers' approvals. This file brings it
 * the keys this person's account gives for the company, this signer's own
 * three and records, the company's vault routes checked against the roster
 * this device opens, the part of the page that builds vault transactions, and
 * this browser's store for the temporary key; and it turns the answer into a
 * fixed state or reason. It keeps nothing, and decides nothing the operation
 * does not.
 *
 * A VAULT SENT AND NOT YET HANDED OVER, OR HANDED OVER AND NOT YET STARTED, IS
 * SAID AS THAT, WITH ITS ADDRESS. The vault takes no money until it is started,
 * and `finishHandingOver` picks the operation up where it stopped.
 */

/**
 * Where creating a vault has got to, as the operation reports it, each said on
 * the screen in its own words: the vault built, sent and handed over, then
 * started, which is the company's account adopting it, its private records
 * opened and read back, its secret set and a sealed copy written for each
 * signer, waiting for other signers' approvals wherever a round needs them.
 */
export const CREATING = {
  checking: 'checking', building: 'building', sending: 'sending', waitingForChain: 'waiting-for-chain',
  handingOver: 'handing-over', waitingForHandover: 'waiting-for-handover',
  adopting: 'adopting', openingThePool: 'opening-the-pool', readingTheSecretBack: 'reading-the-secret-back',
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
  'handing the vault to the committee': CREATING.handingOver,
  'waiting for the handover': CREATING.waitingForHandover,
  'adopting the vault': CREATING.adopting,
  'opening the pool': CREATING.openingThePool,
  'reading the secret back': CREATING.readingTheSecretBack,
  'setting the secret': CREATING.settingTheSecret,
  'writing the sealed copies': CREATING.writingTheCopies,
  'waiting for approvals': CREATING.waitingForApprovals,
  done: CREATING.done,
};

/** What creating a vault, or finishing handing one over, came to. `done` is a vault started. */
export type VaultCreated =
  | { of: typeof ACTED.done; vault: string }
  | { of: typeof OWED.here | typeof OWED.elsewhere | typeof OWED.rosterDisagrees; vault: string }
  /**
   * Handed to the committee and not started: creating it again carries on.
   * `stopped` when it stopped at the check of who its secret is sealed to, and what resolves it.
   */
  | { of: typeof STARTING.owed; vault: string; stopped?: StartStopped }
  /** One round of its start waits for other signers' approvals: which, and how many it has and needs. */
  | { of: typeof STARTING.awaiting; vault: string; round: 'adoption' | 'first-secret'; approvals: number; needed: number }
  | { of: typeof ACTED.refused; why: ActRefusal };

/** A vault handed to the committee whose start is not finished, or waits on other signers. */
export const STARTING = { owed: 'start-owed', awaiting: 'awaiting-approvals' } as const;

/**
 * **WHAT RESOLVES A START THAT STOPPED BEFORE ITS SECRET WAS APPROVED**, said
 * on the screen in its own words: the wallet reading the company again, the
 * company handed to its signers, the vault handed to the signers as they stand
 * now, every signer set up for vaults, or nothing a person here can do because
 * what the service sent did not check out.
 */
export const STOPPED = { wallet: 'wallet', handOver: 'hand-over', vault: 'vault', signers: 'signers', mismatch: 'mismatch' } as const;
export type StartStopped = (typeof STOPPED)[keyof typeof STOPPED];
export const STOPPED_BY: Record<ReaderRefusalCode, StartStopped> = {
  [READER_REFUSAL.walletReadNothing]: STOPPED.wallet,
  [READER_REFUSAL.accountNotHeld]: STOPPED.handOver,
  [READER_REFUSAL.vaultNotHeld]: STOPPED.vault,
  [READER_REFUSAL.committeeOutOfDate]: STOPPED.signers,
  [READER_REFUSAL.keysNotGiven]: STOPPED.signers,
  [READER_REFUSAL.notSigned]: STOPPED.mismatch,
  [READER_REFUSAL.seatNotHeld]: STOPPED.signers,
  [READER_REFUSAL.rosterNotTheChains]: STOPPED.mismatch,
  [READER_REFUSAL.readerNotASigner]: STOPPED.mismatch,
  [READER_REFUSAL.signerLeftOut]: STOPPED.mismatch,
  [READER_REFUSAL.vaultNotTheCompanys]: STOPPED.mismatch,
};

/**
 * A VAULT SENT AND NOT YET HELD BY THE COMMITTEE: this app puts no money into
 * it until it is. `here` when the key it was created with is in this browser,
 * so it can be finished from here; `elsewhere` when it is not, so only the
 * device that created it can finish handing it over; `rosterDisagrees` when
 * the committee the service reports for it is not the one the roster this
 * device opened names, so it is not handed over from here at all.
 */
export const OWED = { here: 'handover-owed', elsewhere: 'handover-owed-elsewhere', rosterDisagrees: 'handover-owed-roster-disagrees' } as const;

/** Whether a vault can be created now, and if not, why, each said on the screen in its own words. */
export const READY = {
  /** Every signer has given their vault keys and the committee is the one the roster names. */
  ready: 'ready',
  /** This person has not given their vault keys yet. */
  yoursMissing: 'yours-missing',
  /** This person has; not every other signer has yet. */
  othersMissing: 'others-missing',
  /** The committee the service reports is not the one the roster this device opened names. */
  rosterDisagrees: 'roster-disagrees',
  /** The company has no contract on the chain the service can read yet. */
  notOnChain: 'not-on-chain',
  /** The keys saved for this person are not open in this tab: their account opens them when they approve. */
  locked: 'locked',
} as const;
export type Ready = (typeof READY)[keyof typeof READY];
export type Readiness = { of: Ready } | { of: typeof ACTED.refused; why: ActRefusal };

/** The service's addresses and the words of its answers, compared and never shown. */
const SERVICE = {
  vaultKeys: '/vault-keys', authority: '/authority', vaults: '/vaults', slash: '/', chain: '/chain',
  startAccount: '/start/account', startSecret: '/start/secret', startCopy: '/start/copy', post: 'POST',
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

type Opened = { sealed: SealedAccount; keys: NonNullable<Awaited<ReturnType<typeof keysOnTheWayIn>>>; roster: () => Promise<BelievedAccount> };

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
  return { sealed, keys, roster };
}

/**
 * WHETHER A VAULT CAN BE CREATED NOW for the company `companyId`, read as the
 * legacy page reads it: the committee the service reports, checked against
 * the roster this device opens, and whether this person's own roster entry
 * carries their vault keys. Nothing is asked of the account.
 */
export async function readVaultReadiness(personId: string, companyId: string): Promise<Readiness> {
  try {
    const o = await opened(personId, companyId, false);
    if (o === LOCKED) return { of: READY.locked };
    if (typeof o === 'string') return { of: ACTED.refused, why: o };
    const [served, named] = await Promise.all([api(companyRoute(companyId, SERVICE.vaultKeys)), o.roster()]) as [
      { committee: { committee: { tag: string; value: string }[] } | null }, Awaited<ReturnType<Opened['roster']>>,
    ];
    if (served.committee !== null) {
      return { of: whyNotTheCommittee(served.committee.committee, named) === null ? READY.ready : READY.rosterDisagrees };
    }
    /* No committee: the company is not on the chain yet, or not every signer has given their vault keys. */
    const authority = await api(companyRoute(companyId, SERVICE.authority)) as { company?: unknown } | null;
    if (authority?.company === null) return { of: READY.notOnChain };
    const mine = rosterVaultKeys(named).find((r) => r.signerId === o.keys.signerId)?.keys ?? null;
    return { of: mine === null ? READY.yoursMissing : READY.othersMissing };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}

/** How long the operation waits between asks of the chain. */
const pacing = (onStage: (stage: Creating) => void) => ({
  sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }),
  progress: (stage: VaultStage) => { const s = STAGE[stage]; if (s !== undefined) onStage(s); },
});

/** A refusal from the service marked as having sent nothing is said as that; anything else is told apart by its kind. */
const createRefusalOf = (e: unknown): ActRefusal =>
  ((e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true ? ACT_REFUSAL.nothingSent : refusalOf(e));

/**
 * CREATE A VAULT for the company `companyId` and hand it to its committee, or,
 * with `resume`, finish handing over the vault this device sent earlier. The
 * company's keys come from this person's account first, and their own vault
 * keys are given with them (the service keeps the first set), as the legacy
 * page does on every press.
 */
async function run(personId: string, companyId: string, onStage: (stage: Creating) => void, resume?: string): Promise<VaultCreated> {
  let service: VaultService | null = null;
  try {
    const o = await opened(personId, companyId, true);
    if (typeof o === 'string') return { of: ACTED.refused, why: o === LOCKED ? ACT_REFUSAL.didNotFinish : o };
    const released = await giveTheVaultKeys(companyId, o.keys, viewingKeyFor(o.sealed), o.roster);
    if (released.of === ACTED.refused) return released;
    service = withTheStart(companyId, vaultServiceFor(api, companyId, o.roster));
    /* This signer's own pool, journals and records, over the records route, wrapped to the seats the directory names now. */
    const readers = readersIn(directoryHereFor(companyId, released.company, released.account, o.roster));
    const done = await createCompanyVault({
      ...pacing(onStage), account: released.account, service,
      builder: await theVaultBuilder(), keys: browserTemporaryKeys(),
      me: deviceSignerFrom(released.signed.statement.seat, released.companyKey),
      myRecordsKey: recordsKeypairFrom(fromHex(released.companyKey)).publicKey as Hex,
      signers: readers.signers,
      records: deviceRecordsFor(o.keys.signingSecret, filingJudgeFor(companyId, released.company, released.account, o.roster),
        () => currentUser()?.id ?? null),
      material: { signingSecret: o.keys.signingSecret, blinding: o.keys.blinding, scope: (o.keys as { scope?: Hex }).scope },
      /* The vault's company account as this person's own wallet reads it for each step, with no press. */
      onChain: async () => ({
        holders: (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account })).holders,
      }),
      /* The vault itself is read in this device's vault worker, at the indexer this person's own wallet names. */
      indexer: () => walletIndexerFor(released.company, released.account),
      secretReaders: {
        company: released.company, committeeKey: released.signed.committeeKey,
        /*
         * Who holds the company and the vault, asked of this signer's account afresh for every check, so a check
         * after a wait never rests on what was read before it; the vault is read by the account itself.
         */
        read: async (vault) => {
          const now = await recordsKeyFromTheWallet(ACCOUNT_ORIGIN, {
            company: released.company, account: released.account, seat: released.signed.statement.seat, vault: vault as string as VaultAddress,
          });
          return { ...now.seats, vault: now.vault };
        },
        roster: async () => rosterVaultKeys(await o.roster()),
      },
      /*
       * The company as this device counts it before the adoption is raised, approved or carried out: the bars the chain
       * holds, the seated signers and the rights the roster records for them, and the vaults the account holds as this
       * person's own wallet reads it.
       */
      approvers: async () => {
        const [status, account, held, wide] = await Promise.all([
          /* Refused, with what was not read, when the chain's account could not be read. */
          governedCallServiceFor(api).bars!(companyId),
          o.roster(),
          holdersFromTheWallet(ACCOUNT_ORIGIN, { company: released.company, account: released.account }),
          (await theVaultBuilder()).companyWide(),
        ]);
        return approverRosterFrom({
          threshold: status.threshold, vaultThresholds: status.vaultThresholds,
          seated: account.signers.filter((x) => x.status === 'active' && x.leafCommitment !== null)
            .map((x) => ({ leaf: x.leafCommitment!, ...(x.rights === undefined ? {} : { rights: x.rights }) })),
          adoptedVaults: held.holders.adoptedVaults, companyWide: wide,
        });
      },
      vaultName: (vault) => vault,
    }, resume as Parameters<typeof createCompanyVault>[1]);
    if (done.state === 'awaiting-approvals') {
      return { of: STARTING.awaiting, vault: done.vault, ...done.awaiting };
    }
    return { of: ACTED.done, vault: done.vault };
  } catch (e) {
    if (e instanceof VaultStartOwed) {
      return e.stoppedAt === undefined ? { of: STARTING.owed, vault: e.vault } : { of: STARTING.owed, vault: e.vault, stopped: STOPPED_BY[e.stoppedAt] };
    }
    if (e instanceof VaultHandoverOwed) {
      if (service !== null && await rosterRefusedItsCommittee(companyId, e.vault, service)) return { of: OWED.rosterDisagrees, vault: e.vault };
      /* Only the key it was created with can hand it over, and it is kept only in the browser that created it. */
      return { of: (await keyHere(e.vault)) ? OWED.here : OWED.elsewhere, vault: e.vault };
    }
    return { of: ACTED.refused, why: createRefusalOf(e) };
  }
}

/**
 * WHETHER THE ROSTER THIS DEVICE OPENED REFUSED THE COMMITTEE THE SERVICE
 * REPORTS FOR `vault`: the service's own view names a committee, or says the
 * committee holds the vault, and the same view checked against the roster
 * (`vaultServiceFor`'s own check) does not. Then finishing the handover from
 * here can never work, and that is said rather than "not finished yet". A read
 * that fails is taken as no.
 */
async function rosterRefusedItsCommittee(companyId: string, vault: string, service: VaultService): Promise<boolean> {
  try {
    const served = await api(companyRoute(companyId, SERVICE.vaults + SERVICE.slash + vault + SERVICE.chain)) as { committee?: unknown; heldByCommittee?: unknown } | null;
    const checked = await service.chain(vault as Parameters<VaultService['chain']>[0]);
    return ((served?.committee ?? null) !== null && (checked.committee ?? null) === null)
      || (served?.heldByCommittee === true && checked.heldByCommittee !== true);
  } catch {
    return false;
  }
}

/** A vault sent and not yet held by the company's signers, with its number among the company's vaults and whether this browser holds the key that can finish handing it over. */
export interface OwedVault { vault: string; number: number; here: boolean }

/** Whether this browser holds the key `vault` was created with; false when it does not, or when its store cannot be read. */
const keyHere = async (vault: string): Promise<boolean> => {
  try {
    return (await browserTemporaryKeys().get(vault as Parameters<ReturnType<typeof browserTemporaryKeys>['get']>[0])) !== null;
  } catch {
    return false;
  }
};

/** The company's vaults sent and not yet held by its signers, each with whether it can be finished from this browser; none when they could not be read. */
export async function readOwedVaults(personId: string, companyId: string): Promise<readonly OwedVault[]> {
  const rows = await readVaultRows(personId, companyId);
  const owed = (rows ?? []).map((row, i) => ({ row, number: i + 1 })).filter((x) => handoverOwed(x.row));
  return Promise.all(owed.map(async ({ row, number }) => ({ vault: row.vault, number, here: await keyHere(row.vault) })));
}

/** OPEN THE KEYS SAVED FOR THE PERSON with their account, so whether a vault can be created can be read. */
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

/** CREATE A VAULT for the company, and hand it to the company's committee. */
export const createVault = (personId: string, companyId: string, onStage: (stage: Creating) => void): Promise<VaultCreated> =>
  run(personId, companyId, onStage);

/**
 * FINISH HANDING OVER the vault `vault`, which this device sent and the committee does not hold yet, or CARRY ON
 * SETTING UP one the committee holds and that is not started: from any signer's device, which approves its
 * adoption and its first secret with this signer's own keys once every key that secret is sealed to checks out.
 */
export const finishHandingOver = (personId: string, companyId: string, vault: string, onStage: (stage: Creating) => void): Promise<VaultCreated> =>
  run(personId, companyId, onStage, vault);

/**
 * GIVE YOUR VAULT KEYS for the company `companyId`, where creating a vault
 * waits on them, so a vault can be created once every signer has. Nothing but
 * the keys is sent.
 */
export async function giveYourVaultKeys(personId: string, companyId: string): Promise<{ of: typeof ACTED.done } | { of: typeof ACTED.refused; why: ActRefusal }> {
  try {
    const o = await opened(personId, companyId, true);
    if (typeof o === 'string') return { of: ACTED.refused, why: o === LOCKED ? ACT_REFUSAL.didNotFinish : o };
    const given = await giveTheVaultKeys(companyId, o.keys, viewingKeyFor(o.sealed), o.roster);
    if (given.of === ACTED.refused) return given;
    return { of: ACTED.done };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
