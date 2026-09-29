import { NETWORK } from 'midnight-identity/network';
import type { SealedAccount } from '../../../../src/core/types.js';
import { rosterVaultKeys } from '../../../../src/core/vault-keys.js';
import { whyNotTheCommittee } from 'vaults-web-shared/handover-check.js';
import { api, canOpenCompanies, companyKeysForVaults, openAccount, openKeysWithWallet, viewingKeyFor } from 'vaults-web-shared/keyring.js';
import { createCompanyVault, VaultHandoverOwed, type VaultStage } from 'vaults-web-shared/vault-operation.js';
import { browserTemporaryKeys, giveVaultKeys, vaultServiceFor } from 'vaults-web-shared/vault-page-doors.js';
import type { VaultService } from 'vaults-web-shared/vault-operation.js';
import { startVaultBuilder, type VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import { Fault, FAULT } from '../faults.js';
import { companyRoute } from './handover-state.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { handoverOwed, readVaultRows } from './vault-rows.js';

/*
 * CREATING A COMPANY'S VAULT, OVER THE SAME SHARED OPERATION
 * `src/web-legacy/VaultPanel.tsx` RUNS, IN ITS ORDER.
 *
 * `createCompanyVault` is where the order lives: the committee is checked,
 * the vault is built and proved on this device with a key made here, that key
 * is kept in this browser before anything is sent, the vault is sent, and it
 * is handed to the company's committee as soon as the chain has it. The
 * operation ends only when the chain says the committee holds the vault. This
 * file brings it the keys this person's account gives for the company, the
 * company's vault routes checked against the roster this device opens, the
 * part of the page that builds vault transactions, and this browser's store
 * for the temporary key; and it turns the answer into a fixed state or
 * reason. It keeps nothing, and decides nothing the operation does not.
 *
 * A VAULT SENT AND NOT YET HANDED OVER IS SAID AS THAT, WITH ITS ADDRESS. The
 * service takes no money into it until the chain says the committee holds
 * it, and `finishHandingOver` picks the operation up where it stopped.
 */

/** Where creating a vault has got to, as the operation reports it, each said on the screen in its own words. */
export const CREATING = {
  checking: 'checking', building: 'building', sending: 'sending', waitingForChain: 'waiting-for-chain',
  handingOver: 'handing-over', waitingForHandover: 'waiting-for-handover', done: 'done',
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
  done: CREATING.done,
};

/** What creating a vault, or finishing handing one over, came to. */
export type VaultCreated =
  | { of: typeof ACTED.done; vault: string }
  | { of: typeof OWED.here | typeof OWED.elsewhere | typeof OWED.rosterDisagrees; vault: string }
  | { of: typeof ACTED.refused; why: ActRefusal };

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
const SERVICE = { vaultKeys: '/vault-keys', authority: '/authority', vaults: '/vaults', slash: '/', chain: '/chain' } as const;

type Opened = { sealed: SealedAccount; keys: NonNullable<Awaited<ReturnType<typeof keysOnTheWayIn>>>; roster: () => Promise<NonNullable<ReturnType<typeof openAccount>>> };

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
    const account = openAccount(await api(companyRoute(companyId)) as SealedAccount);
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

/**
 * The part of the page that builds vault transactions, started the first time
 * a vault is created or handed over, and kept for the life of the page. A
 * start that failed is not kept, so the next press tries again.
 */
let builder: Promise<VaultBuilderClient> | null = null;
const theBuilder = (): Promise<VaultBuilderClient> => {
  builder ??= startVaultBuilder(NETWORK);
  builder.catch(() => { builder = null; });
  return builder;
};

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
    const released = await companyKeysForVaults(companyId, ACCOUNT_ORIGIN);
    await giveVaultKeys(api, companyId, {
      committeeKey: released.committeeKey, companyKey: released.companyKey, signingSecret: o.keys.signingSecret,
      signerId: o.keys.signerId, viewingKey: viewingKeyFor(o.sealed),
    });
    service = vaultServiceFor(api, companyId, o.roster);
    const done = await createCompanyVault({
      ...pacing(onStage), account: released.company, service,
      builder: await theBuilder(), keys: browserTemporaryKeys(),
    }, resume as Parameters<typeof createCompanyVault>[1]);
    return { of: ACTED.done, vault: done.vault };
  } catch (e) {
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

/** FINISH HANDING OVER the vault `vault`, which this device sent and the committee does not hold yet. */
export const finishHandingOver = (personId: string, companyId: string, vault: string, onStage: (stage: Creating) => void): Promise<VaultCreated> =>
  run(personId, companyId, onStage, vault);
