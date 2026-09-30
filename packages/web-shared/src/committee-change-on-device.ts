/**
 * **A SIGNER'S OWN DEVICE SIGNING THE CHANGE THAT BRINGS THE COMPANY'S
 * CONTRACTS TO ITS COMMITTEE AS IT STANDS NOW.**
 *
 * When a signer joins or leaves, or the threshold changes, the company's
 * account and every vault still carry the committee they had. Each must be
 * changed, and each change must be signed by enough of the keys that hold that
 * contract now. This asks the service which contracts are behind, checks the
 * committee it names against the roster this device opened, asks this
 * person's wallet to sign the change on every contract they hold a seat on,
 * and hands the signatures to the service, which puts them together and sends
 * each change once enough have signed.
 *
 * **NOTHING SECRET LEAVES THIS DEVICE.** The wallet signs inside itself and
 * hands back signatures, each good for that one change only.
 */
import { whyNotTheCommittee, type Roster } from './handover-check.js';
import { rosterVaultKeys } from '../../../src/core/vault-keys.js';

import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';

type Key = { tag: string; value: string };
type CommitteeValue = { committee: Key[]; threshold: number };

/** What the service says about the change owed, as the settings screen reads it. */
export interface CommitteeChangeView {
  /** The address of the company's account, the contract every change here reaches first. */
  readonly company: string | null;
  /**
   * The company's label, from the same record: what the wallet derives the key
   * it signs with from, and reads back off the account above before it signs.
   * Null for a company created without one, which no wallet can sign for.
   */
  readonly label: string | null;
  readonly to: CommitteeValue | null;
  readonly why: string | null;
  readonly contracts: ReadonlyArray<{
    readonly contract: 'account' | 'vault';
    readonly address: string;
    readonly counter: string;
    readonly now: CommitteeValue;
    readonly signedSeats: readonly number[];
    readonly required: number;
  }>;
  readonly notChangeable: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly address: string; readonly why: string }>;
}

const same = (a: Key, b: Key): boolean => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();

/** The contracts this person can still sign the change for: they hold a seat, and that seat has not signed. */
export function contractsForMe(view: CommitteeChangeView, mine: Key): CommitteeChangeView['contracts'] {
  return view.contracts.filter((c) => c.now.committee.some((k, i) => same(k, mine) && !c.signedSeats.includes(i)));
}

/**
 * **WHY THERE IS NOTHING FOR THIS PERSON TO SIGN**, told apart: they hold no
 * seat on any contract that is behind, or they have signed on every one they
 * hold a seat on.
 */
export function nothingForMe(view: CommitteeChangeView, mine: Key): string {
  const holdsASeat = view.contracts.some((c) => c.now.committee.some((k) => same(k, mine)));
  return holdsASeat
    ? 'you have signed the change on every contract you hold a seat on. The rest need the other signers who hold those '
      + 'contracts now.'
    : 'you do not hold a seat on any contract that needs this change, so there is nothing for you to sign. The signers '
      + 'who hold those contracts now sign it.';
}

/**
 * **WHY THIS DEVICE WILL NOT ASK ITS WALLET TO SIGN THE CHANGE THE SERVICE
 * DESCRIBES**, or null when it may. The committee to install must be exactly
 * the keys this device's roster names, one per seated signer; its threshold
 * must be the one the company's record this device opened holds, when the
 * device has opened it; this person's own roster entry must carry the key their
 * wallet gives; and there must be a contract they hold a seat on and have not
 * yet signed.
 *
 * **WHAT THE THRESHOLD CHECK IS WORTH.** The record is sealed under the
 * company's viewing key, which the service is given, so a service that
 * rewrites the record can pass it. It stops a service that only reports a
 * lower threshold than the company chose; the wallet's screen shows the
 * threshold before and after for the rest.
 */
export function whyNotSignCommitteeChange(
  view: CommitteeChangeView, mine: Key, roster: Roster & { policy?: { threshold: number } }, me: { signerId: string },
): string | null {
  return committeeChangeRefusal(view, mine, roster, me)?.why ?? null;
}

/**
 * **WHICH KIND OF REFUSAL IT IS**, as a code a screen compares: nothing for this
 * person to sign, which is not a fault; or anything else, which stops the
 * change being signed from here.
 */
export const COMMITTEE_CHANGE_REFUSAL = { nothingToSign: 'nothing-to-sign', refused: 'refused' } as const;
export type CommitteeChangeRefusalCode = (typeof COMMITTEE_CHANGE_REFUSAL)[keyof typeof COMMITTEE_CHANGE_REFUSAL];

/**
 * **THE SAME CHECK AS `whyNotSignCommitteeChange`, WITH ITS KIND AS A CODE**, or
 * null when the wallet may be asked. `why` is the sentence that function gives.
 */
export function committeeChangeRefusal(
  view: CommitteeChangeView, mine: Key, roster: Roster & { policy?: { threshold: number } }, me: { signerId: string },
): { code: CommitteeChangeRefusalCode; why: string } | null {
  const refused = (why: string) => ({ code: COMMITTEE_CHANGE_REFUSAL.refused, why });
  if (view.to === null || view.company === null) return refused(view.why ?? 'this company has no committee yet.');
  if (readCompanyLabel(view.label) === null || readAccountAddress(view.company) === null) {
    return refused('the service did not say which company this is in a way a wallet can check - its label, and the '
      + 'account that carries it - so no change is signed from here.');
  }
  const notTheRosters = whyNotTheCommittee(view.to.committee, roster);
  if (notTheRosters !== null) return refused(`${notTheRosters} No change is signed from here.`);
  if (roster.policy !== undefined && roster.policy.threshold !== view.to.threshold) {
    return refused(`the service says ${view.to.threshold} of the company's signers must sign a change after this one, and the `
      + `company's own record says ${roster.policy.threshold}. No change is signed from here. Reload the page, and if it `
      + 'happens again, contact support.');
  }
  const myEntry = rosterVaultKeys(roster).find((r) => r.signerId === me.signerId);
  if (!myEntry?.keys || !same(myEntry.keys.committeeKey, mine)) {
    return refused('the company\'s roster does not carry the key your wallet gives for this company as yours, so no change is '
      + 'signed from here. Open the company with the wallet your vault keys were set up from.');
  }
  if (view.contracts.length === 0) return refused('every contract of this company is already held by its committee as it stands now.');
  if (contractsForMe(view, mine).length === 0) return { code: COMMITTEE_CHANGE_REFUSAL.nothingToSign, why: nothingForMe(view, mine) };
  return null;
}

export interface CommitteeChangeDoors {
  /** What the service says is owed now. */
  readonly view: () => Promise<CommitteeChangeView>;
  /** This person's committee key for the company, as their wallet gives it. */
  readonly walletKey: () => Promise<Key>;
  /** The company's sealed roster, opened on this device afresh. */
  readonly roster: () => Promise<Roster & { policy?: { threshold: number } }>;
  /** Asks the wallet to sign; resolves with what it signed. */
  readonly askWallet: (ask: {
    company: CompanyLabel; account: AccountAddress; to: CommitteeValue;
    contracts: Array<{ contract: 'account' | 'vault'; address: string; counter: string; now: CommitteeValue }>;
  }) => Promise<{ signer: Key; signatures: ReadonlyArray<{ address: string; counter: string; seat: number; signature: Key }> }>;
  /** Hands the signatures to the service. */
  readonly send: (body: {
    to: CommitteeValue; signatures: Array<{ address: string; counter: string; seat: number; signature: Key }>;
  }) => Promise<{ results: ReadonlyArray<Record<string, unknown>> }>;
}

/** Nothing was wrong: there is simply nothing for this person to sign. The wallet was not asked. */
export class NothingToSign extends Error {
  readonly code = COMMITTEE_CHANGE_REFUSAL.nothingToSign;
  constructor(message: string) {
    super(message);
    this.name = 'NothingToSign';
  }
}

/** Signs the change on every contract this person can, and hands the signatures over. */
export async function signCommitteeChangeOnDevice(
  doors: CommitteeChangeDoors, me: { signerId: string },
): Promise<{ results: ReadonlyArray<Record<string, unknown>> }> {
  const view = await doors.view();
  const mine = await doors.walletKey();
  const refused = committeeChangeRefusal(view, mine, await doors.roster(), me);
  if (refused !== null) {
    throw refused.code === COMMITTEE_CHANGE_REFUSAL.nothingToSign ? new NothingToSign(refused.why) : new Error(refused.why);
  }
  const to = view.to!;
  const contracts = contractsForMe(view, mine).map((c) => ({ contract: c.contract, address: c.address, counter: c.counter, now: c.now }));
  const signed = await doors.askWallet({
    company: readCompanyLabel(view.label)!, account: readAccountAddress(view.company)!, to, contracts,
  });
  if (!same(signed.signer, mine)) {
    throw new Error('the wallet signed with a key other than the one it gives for this company, so nothing was handed on.');
  }
  return doors.send({
    to,
    signatures: signed.signatures.map((s) => ({ address: s.address, counter: s.counter, seat: s.seat, signature: s.signature })),
  });
}
