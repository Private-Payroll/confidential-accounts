/**
 * **A SUPER ADMIN'S OWN DEVICE SIGNING THE CHANGE THAT BRINGS THE COMPANY'S
 * CONTRACTS TO ITS COMMITTEE.**
 *
 * The company's committee is its super admins' keys at their own threshold,
 * and every contract must hold the same one. A contract that does not is
 * changed, and each change must be signed by enough of the keys that hold that
 * contract now. This asks the service which contracts are behind, checks that
 * the committee it names is the one holding the company's account on the
 * chain, as this person's own wallet reads it, or the super admins' own change
 * in progress - never one made from the signers or the roster. A key's
 * standing to sign one contract's change is being on that contract's
 * committee, and nothing else: a key the account no longer lists still signs a
 * vault it holds forward. It then asks their wallet to sign the change on
 * every contract they hold a place on, hands the signatures to the service to
 * keep, and asks the service to send each contract whose kept signatures reach
 * the threshold of the committee holding it; the service sends nothing on its
 * own, and the chain checks each against that contract's committee. Nothing
 * here reads a signer, a seat or the roster.
 *
 * **NOTHING SECRET LEAVES THIS DEVICE.** The wallet signs inside itself and
 * hands back signatures, each good for that one change only.
 */
import type { SuperAdminChangeInProgress } from './committee-here.js';
import { sameCommittee } from '../../../src/midnight/vault-committee.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';

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
    /** The places on the committee holding the contract now whose signatures the service keeps. */
    readonly signedIndexes: readonly number[];
    readonly required: number;
  }>;
  readonly notChangeable: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly address: string; readonly why: string }>;
}

/**
 * **THE ONLY COMMITTEES A CHANGE MAY BRING THE COMPANY'S CONTRACTS TO**: the one
 * holding the company's account, as this person's own wallet reads it off the
 * chain, or the super admins' own change in progress while one is. No signer,
 * no threshold of the signers and no roster is a source of either.
 */
export interface CommitteeTarget {
  readonly account: { readonly committee: readonly Key[]; readonly threshold: number };
  readonly inProgress: SuperAdminChangeInProgress | null;
}

const same = (a: Key, b: Key): boolean => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();

/** The contracts this person can still sign the change for: their key holds a place on the committee, and that place has not signed. */
export function contractsForMe(view: CommitteeChangeView, mine: Key): CommitteeChangeView['contracts'] {
  return view.contracts.filter((c) => c.now.committee.some((k, i) => same(k, mine) && !c.signedIndexes.includes(i)));
}

/**
 * **WHY THERE IS NOTHING FOR THIS PERSON TO SIGN**, told apart: they hold no
 * seat on any contract that is behind, or they have signed on every one they
 * hold a seat on.
 */
export function nothingForMe(view: CommitteeChangeView, mine: Key): string {
  const holdsASeat = view.contracts.some((c) => c.now.committee.some((k) => same(k, mine)));
  return holdsASeat
    ? 'you have signed the change on every contract you hold a seat on. The rest need the other super admins who hold '
      + 'those contracts now.'
    : 'you do not hold a seat on any contract that needs this change, so there is nothing for you to sign. The super '
      + 'admins who hold those contracts now sign it.';
}

/**
 * **WHY THIS DEVICE WILL NOT ASK ITS WALLET TO SIGN THE CHANGE THE SERVICE
 * DESCRIBES**, or null when it may. The committee to install must be one
 * `committeeInstallRefusals` allows, and exactly `target`'s - the super admins' change in
 * progress while one is, or else the committee holding the company's account on
 * the chain; and there must be a contract whose committee holds the key this
 * person's wallet gives, at a place not yet signed: holding that place is the
 * whole of their standing to sign that contract's change. The
 * service's answer is trusted for nothing the chain or the super admins' own
 * change can say.
 */
export function whyNotSignCommitteeChange(view: CommitteeChangeView, mine: Key, target: CommitteeTarget): string | null {
  return committeeChangeRefusal(view, mine, target)?.why ?? null;
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
  view: CommitteeChangeView, mine: Key, target: CommitteeTarget,
): { code: CommitteeChangeRefusalCode; why: string } | null {
  const refused = (why: string) => ({ code: COMMITTEE_CHANGE_REFUSAL.refused, why });
  if (view.to === null || view.company === null) return refused(view.why ?? 'this company has no committee yet.');
  if (readCompanyLabel(view.label) === null || readAccountAddress(view.company) === null) {
    return refused('the service did not say which company this is in a way a wallet can check - its label, and the '
      + 'account that carries it - so no change is signed from here.');
  }
  /* The same rule every door that installs a committee asks, so a wallet is never asked to sign what the service refuses. */
  const notInstallable = whyNotInstallable(view.to);
  if (notInstallable !== null) return refused(`no change is signed from here: ${notInstallable}`);
  const must = target.inProgress ?? target.account;
  if (!sameCommittee(view.to, must)) {
    return refused(target.inProgress === null
      ? 'the service asks for a change to a committee other than the one holding the company\'s account on the chain, as '
        + 'your wallet reads it, and no change of the super admins is in progress. Who holds the company\'s contracts '
        + 'changes only by the super admins\' own change, never because a signer joined or left. No change is signed from here.'
      : 'the service asks for a change to a committee other than the one the super admins\' change in progress installs. '
        + 'No change is signed from here.');
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
  /** The committees a change may bring the contracts to, read from the chain at this person's own wallet. */
  readonly target: () => Promise<CommitteeTarget>;
  /** Asks the wallet to sign; resolves with what it signed. */
  readonly askWallet: (ask: {
    company: CompanyLabel; account: AccountAddress; to: CommitteeValue;
    contracts: Array<{ contract: 'account' | 'vault'; address: string; counter: string; now: CommitteeValue }>;
  }) => Promise<{ signer: Key; signatures: ReadonlyArray<{ address: string; counter: string; seat: number; signature: Key }> }>;
  /** Hands the signatures to the service to keep; each result says how many verify and how many the contract needs. */
  readonly send: (body: {
    to: CommitteeValue; signatures: Array<{ address: string; counter: string; index: number; signature: Key }>;
  }) => Promise<{ results: ReadonlyArray<Record<string, unknown>> }>;
  /** Asks the service to send one contract's update, built from the signatures it keeps. */
  readonly sendNow: (update: { address: string; counter: string; to: CommitteeValue }) => Promise<unknown>;
}

/** Nothing was wrong: there is simply nothing for this person to sign. The wallet was not asked. */
export class NothingToSign extends Error {
  readonly code = COMMITTEE_CHANGE_REFUSAL.nothingToSign;
  constructor(message: string) {
    super(message);
    this.name = 'NothingToSign';
  }
}

/**
 * Signs the change on every contract this person can, hands the signatures to
 * the service to keep, and asks it to send each contract whose kept
 * signatures reach that contract's threshold. Returns the keeping's results.
 */
export async function signCommitteeChangeOnDevice(
  doors: CommitteeChangeDoors,
): Promise<{ results: ReadonlyArray<Record<string, unknown>> }> {
  const view = await doors.view();
  const mine = await doors.walletKey();
  const refused = committeeChangeRefusal(view, mine, await doors.target());
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
  const kept = await doors.send({
    to,
    signatures: signed.signatures.map((s) => ({ address: s.address, counter: s.counter, index: s.seat, signature: s.signature })),
  });
  for (const r of kept.results) {
    const c = contracts.find((x) => x.address === r.address);
    if (c === undefined || r.state !== 'kept' || typeof r.have !== 'number' || typeof r.required !== 'number' || r.have < r.required) continue;
    await doors.sendNow({ address: c.address, counter: c.counter, to });
  }
  return kept;
}
