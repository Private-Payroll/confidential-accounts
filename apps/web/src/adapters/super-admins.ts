import { authorityHere, committeeWarning, EVERY_SUPER_ADMIN_NEEDED, ONE_SUPER_ADMIN_LEFT, superAdminsSeenHere } from 'vaults-web-shared/committee-here.js';
import type { ProposalFile } from 'vaults-web-shared/proposal-file.js';
import { approveSuperAdminChange, joinFromAFile, joiningKeys, raiseSuperAdminChange } from 'vaults-web-shared/super-admin-change.js';
import { countOf } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { api, ServiceRefused } from 'vaults-web-shared/keyring.js';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { sameCommittee, sameCommitteeKey } from '../../../../src/midnight/vault-committee.js';
import { superAdminSigned } from 'vaults-web-shared/super-admin-ask.js';
import {
  keepApproval, keepJoin, keepRaisedChange, keptChangeFile, RaiserLeaves, type KeptChange,
} from 'vaults-web-shared/super-admins-on-the-service.js';
import { companyRoute, SERVICE } from './handover-state.js';
import { READ } from './reads.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { superAdminDoorsFor, superAdminService, type SuperAdminReach } from './super-admin-doors.js';

type Key = { readonly tag: string; readonly value: string };

/** The shared change's word for a change of the super admins, passed and never shown. */
const SUPER_ADMIN_CHANGE = 'super-admins';

/** Why a super admin's step was refused, by name, each saying on screen what clears it. */
export const SUPER_ADMIN_WHY = {
  raiserLeaves: 'raiser-leaves', notASuperAdmin: 'not-a-super-admin', joinsMissing: 'joins-missing', noChange: 'no-change',
  notInstallable: 'not-installable', sameAsNow: 'same-as-now',
} as const;
export type SuperAdminWhy = (typeof SUPER_ADMIN_WHY)[keyof typeof SUPER_ADMIN_WHY];

export type SuperAdminActed =
  /** Done: `sent` once the change reached every contract; otherwise `held` says why it has not finished, or is null while it waits for signatures. */
  | { readonly of: typeof ACTED.done; readonly sent: boolean; readonly held: string | null }
  | { readonly of: typeof ACTED.refused; readonly why: SuperAdminWhy; readonly act?: undefined }
  | { readonly of: typeof ACTED.refused; readonly act: ActRefusal; readonly why?: undefined };

/** The one-key and every-key warnings, by name, for the screen's own words. */
export const SUPER_ADMIN_WARNING = { oneLeft: 'one-left', everyNeeded: 'every-needed' } as const;
export type SuperAdminWarning = (typeof SUPER_ADMIN_WARNING)[keyof typeof SUPER_ADMIN_WARNING];
const warningOf = (c: { readonly committee: readonly unknown[]; readonly threshold: number }): SuperAdminWarning | null => {
  const w = committeeWarning(c);
  return w === ONE_SUPER_ADMIN_LEFT ? SUPER_ADMIN_WARNING.oneLeft : w === EVERY_SUPER_ADMIN_NEEDED ? SUPER_ADMIN_WARNING.everyNeeded : null;
};

/** A change kept on the service, as this page shows it: what it installs, and which joining keys have signed it. */
export interface ChangeShown {
  readonly chainId: string;
  /** The key that raised it, and whether that is the person's own. */
  readonly raisedBy: Key;
  readonly raisedByMine: boolean;
  readonly committee: readonly Key[];
  readonly threshold: number;
  readonly joining: ReadonlyArray<{ readonly key: Key; readonly signed: boolean; readonly mine: boolean }>;
  readonly warning: SuperAdminWarning | null;
}

/** The super admins as the chain holds them, the person's own key, and the change kept for the account's counter now. */
export type SuperAdminsRead =
  | {
    readonly of: typeof READ.read;
    readonly committee: ReadonlyArray<{ readonly key: Key; readonly mine: boolean }>;
    readonly threshold: number;
    readonly warning: SuperAdminWarning | null;
    readonly mine: Key | null;
    readonly iAmOne: boolean;
    /** Every change kept at the account's counter now, in the order they were raised; none when the service shows this key none yet. */
    readonly changes: readonly ChangeShown[];
    /** The company's contracts as the account on the chain lists them: the account, and every vault it adopted or retired. */
    readonly contracts: readonly string[];
  }
  | { readonly of: typeof ACTED.refused; readonly act: ActRefusal };

const notLetIn = (e: unknown): boolean => e instanceof ServiceRefused && e.body['refused'] === SUPER_ADMIN_WHY.notASuperAdmin;

/** A kept change's counter as the service wrote it, in digits; null for anything else. */
const counterOf = (written: string | undefined): bigint | null => (written !== undefined && /^[0-9]+$/u.test(written) ? BigInt(written) : null);

/**
 * Every change kept at the account's counter now: the only ones that can still land. None when the service does not let
 * this key read them; null, with what stopped it, when anything else stopped the read, for the caller to answer as a refusal.
 */
async function keptNow(reach: SuperAdminReach, counter: bigint): Promise<{ readonly kept: readonly KeptChange[] | null; readonly failed?: unknown }> {
  try {
    return { kept: (await superAdminService(reach).kept()).filter((c) => counterOf(c.change.contracts[0]?.counter) === counter) };
  } catch (e) {
    return notLetIn(e) ? { kept: [] } : { kept: null, failed: e };
  }
}

/** Why a read or a press of a super admin's step stopped: the doors could not be opened, since the wallet named no indexer. */
const NO_DOORS = { of: ACTED.refused, act: ACT_REFUSAL.committeeUnread } as const;

/**
 * **WHO THE SUPER ADMINS ARE, READ FROM THE CHAIN ONLY.** No seat, roster or record names them: the keys on the
 * committee holding the company's account, and the person's own key for the company when the link brought them.
 */
export async function readSuperAdmins(reach: SuperAdminReach): Promise<SuperAdminsRead> {
  try {
    const mine = reach.asSuperAdmin ? (await superAdminSigned(reach.company, ACCOUNT_ORIGIN)).key : null;
    const doors = await superAdminDoorsFor(reach);
    if (doors === null) return NO_DOORS;
    const seen = await superAdminsSeenHere(doors.chain, {
      account: reach.company.account, createdByTheCompany: [], inProgress: null, seats: [], ownWalletKey: mine,
    });
    const keptRead = await keptNow(reach, seen.superAdmins.counter);
    const { kept } = keptRead;
    if (kept === null) return { of: ACTED.refused, act: refusalOf(keptRead.failed) };
    const shown = (c: KeptChange): ChangeShown => {
      /* A key is joining where any contract still to move does not hold it, as the device judges before it signs. */
      const behind = seen.contracts.flatMap((x) => (x.authority === null || sameCommittee(x.authority, c.change) ? [] : [x.authority]));
      return {
        chainId: c.chainId, raisedBy: c.raisedBy.key, raisedByMine: mine !== null && sameCommitteeKey(mine, c.raisedBy.key),
        committee: c.change.committee, threshold: c.change.threshold, warning: warningOf(c.change),
        joining: joiningKeys(c.change.committee, behind).map((k) => ({ key: k, signed: c.joined.some((j) => sameCommitteeKey(j.key, k)), mine: mine !== null && sameCommitteeKey(mine, k) })),
      };
    };
    return {
      of: READ.read, mine, iAmOne: seen.iAmOne, threshold: seen.superAdmins.threshold, warning: warningOf(seen.superAdmins),
      committee: seen.shown.map((s) => ({ key: s.key, mine: s.mine })),
      changes: kept.map(shown),
      contracts: seen.contracts.map((c) => c.address.toLowerCase()),
    };
  } catch (e) {
    return { of: ACTED.refused, act: refusalOf(e) };
  }
}

const refusedBy = (e: unknown): SuperAdminActed => {
  if (e instanceof RaiserLeaves) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.raiserLeaves };
  if (notLetIn(e)) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.notASuperAdmin };
  return { of: ACTED.refused, act: refusalOf(e) };
};

/** The kept change with this identity, as the file every check runs on. */
async function keptFile(reach: SuperAdminReach, chainId: string): Promise<ProposalFile | null> {
  const kept = (await superAdminService(reach).kept()).find((c) => c.chainId === chainId);
  return kept === undefined ? null : keptChangeFile(kept, reach.company.account);
}

/**
 * **RAISE A CHANGE.** Raised against the chain on this device, signed by the raiser's wallet, and kept by the service
 * so every super admin finds it here. A change that takes the raiser's own key off is raised by another super admin.
 */
export async function raiseChange(
  reach: SuperAdminReach, to: { readonly committee: readonly Key[]; readonly threshold: number },
  now: { readonly committee: readonly Key[]; readonly threshold: number },
): Promise<SuperAdminActed> {
  if (whyNotInstallable(to) !== null) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.notInstallable };
  if (sameCommittee(to, now)) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.sameAsNow };
  try {
    const doors = await superAdminDoorsFor(reach);
    if (doors === null) return NO_DOORS;
    const mine = await doors.wallet.key({ company: reach.company.label, account: reach.company.account });
    const held = await authorityHere(doors.chain, reach.company.account);
    if (held !== null && !held.committee.some((k) => sameCommitteeKey(k, mine))) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.notASuperAdmin };
    const raised = await raiseSuperAdminChange(doors, {
      change: { kind: SUPER_ADMIN_CHANGE, committee: to.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: to.threshold },
      company: reach.company.label, account: reach.company.account, summary: '',
    });
    await keepRaisedChange(doors, superAdminService(reach), raised.file);
    return { of: ACTED.done, sent: false, held: null };
  } catch (e) {
    return refusedBy(e);
  }
}

/** **SIGN AS A JOINING KEY.** The person's wallet signs the kept change with its own key, and the service keeps the signature. */
export async function joinChange(reach: SuperAdminReach, chainId: string): Promise<SuperAdminActed> {
  try {
    const file = await keptFile(reach, chainId);
    if (file === null) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.noChange };
    const doors = await superAdminDoorsFor(reach);
    if (doors === null) return NO_DOORS;
    const joined = await joinFromAFile(doors, file);
    await keepJoin(superAdminService(reach), file, joined, await doors.wallet.key({ company: reach.company.label, account: reach.company.account }));
    return { of: ACTED.done, sent: false, held: null };
  } catch (e) {
    return refusedBy(e);
  }
}

/**
 * **APPROVE.** Only once every joining key has signed: the wallet signs each contract's update its key holds a place on,
 * the service keeps those signatures for the next super admin, and the change is sent once enough have signed.
 */
export async function approveChange(reach: SuperAdminReach, change: ChangeShown): Promise<SuperAdminActed> {
  if (change.joining.some((j) => !j.signed)) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.joinsMissing };
  try {
    const file = await keptFile(reach, change.chainId);
    if (file === null) return { of: ACTED.refused, why: SUPER_ADMIN_WHY.noChange };
    const doors = await superAdminDoorsFor(reach);
    if (doors === null) return NO_DOORS;
    const approved = await approveSuperAdminChange(doors, file);
    await keepApproval(superAdminService(reach), file, approved.file);
    /* Short of signatures only, it waits for the next super admin; anything else that held it back is said as it is. */
    const waitsOnly = approved.contracts.every((c) => c.state === 'current' || c.state === 'sent' || c.state === 'waiting');
    return { of: ACTED.done, sent: approved.done, held: approved.done || waitsOnly ? null : approved.held };
  } catch (e) {
    return refusedBy(e);
  }
}

const VAULT_ADDRESS = /^[0-9a-f]{64}$/u;

/**
 * **THE VAULTS THE COMPANY CREATED THAT ITS ACCOUNT DOES NOT LIST YET**, for a signer: read from the company's own list
 * of vaults (a member's read), less every contract the account lists on the chain. No change of the super admins
 * names them, since the service sends only for a vault the account lists; each is moved once the account lists it.
 */
export async function notYetAdopted(accountId: string, listed: readonly string[]): Promise<readonly string[]> {
  const got = await api(companyRoute(accountId, SERVICE.vaults)) as { rows?: unknown };
  const rows = Array.isArray(got.rows) ? got.rows as ReadonlyArray<{ vault?: unknown }> : [];
  const known = new Set(listed.map((a) => a.toLowerCase()));
  return rows.flatMap((r) => {
    const vault = typeof r.vault === 'string' ? r.vault.toLowerCase() : '';
    return VAULT_ADDRESS.test(vault) && !known.has(vault) ? [vault] : [];
  });
}

/** The company a signer has chosen, named by its label and account as the service lists them; null when it names neither yet. */
export async function reachOfTheCompany(companyId: string): Promise<SuperAdminReach | null> {
  const named = await api(companyRoute(companyId, SERVICE.change)) as { label?: unknown; company?: unknown };
  const label = readCompanyLabel(named.label);
  const account = readAccountAddress(named.company);
  return label === null || account === null ? null : { company: { accountId: companyId, label, account }, asSuperAdmin: false };
}

/** How many approvals a change asks for, as typed or as read: a whole number, or null for anything else. */
export function countTyped(entry: string | number): number | null {
  if (typeof entry === 'number') return Number.isSafeInteger(entry) && entry >= 0 ? entry : null;
  const typed = entry.trim();
  return /^[0-9]{1,6}$/u.test(typed) ? countOf(BigInt(typed)) : null;
}

/** The kind of key a super admin joins with, as the chain names it; passed, never shown. */
const JOINING_KEY = 'schnorr';

/** The committee a change installs: the keys now that are kept, then each key typed to join. */
export const committeeAfter = (now: readonly Key[], kept: readonly string[], adding: readonly string[]): Key[] =>
  [...now.filter((k) => kept.includes(k.value)), ...adding.map((value) => ({ tag: JOINING_KEY, value }))];
