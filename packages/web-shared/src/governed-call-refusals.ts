/**
 * **WHY A CALL TO THE COMPANY ACCOUNT IS REFUSED BEFORE IT IS BUILT**: a field an approval never reads, a
 * wallet's key handed to a page, a proposal that is not the recorded one, a round this device did not open, and
 * a raise past its time. Each refusal names what was refused, and nothing is built or sent.
 */
import { raiseMayStillLandAt } from '../../../src/core/proposal-filing.js';
import { sameGovernance } from './governance-compared.js';
import {
  adoptionPayloadOf, assetKeyMadeHere, bytesOf, governancePayloadOf, hexOf, payKeyPayloadOf, policyBarOf,
  policyBarPayloadOf, policyCommitmentMadeHere, removalPayloadOf, removalThresholdOf, spendingPolicyPayloadOf,
  thresholdOf, vaultThresholdPayloadOf,
} from './governance-payload.js';
import type { GovernedCallDeps } from './governed-call-builder.js';
import {
  type GovernedCallOrder, NotWhatThisDeviceOpened, type OpenedRound, raisesARun, RecordDoesNotAddUp,
  type RoundChangeOnTheWire,
} from './governed-call-wire.js';
import { partsFor, raisedChange } from './governed-call-arguments.js';

/**
 * **A FIELD AN APPROVAL NEVER READS.** Reading one means the circuit has
 * changed under this device, and answering with any value would be answering
 * with a guess.
 */
export class NotReadByAnApproval extends Error {
  constructor(readonly field: string) {
    super(
      `approving a proposal read "${field}" from this device, and an approval has never needed it. ` +
        'The company\'s contract is not the one this page was built for; nothing was built or sent. ' +
        'Reload the page to use the current build.',
    );
    this.name = 'NotReadByAnApproval';
  }
}

/** A circuit that changed the record it was handed, which this design would drop. */
export class RecordChangedByTheCall extends Error {
  constructor(readonly circuit: string) {
    super(
      `the "${circuit}" call changed this device's record for the company, and nothing here keeps a ` +
        'record between calls, so the change would be lost. Nothing was proved or sent. The ' +
        'company\'s contract is not the one this page was built for.',
    );
    this.name = 'RecordChangedByTheCall';
  }
}

export const ACCOUNT_FIELDS = ['assetBlinding', 'assetId', 'proposalSalt', 'changeAmount', 'changeBatchDigest'] as const;

/**
 * **A WALLET'S COIN SECRET KEY NEVER REACHES A RECORD THIS PAGE BUILDS.** The
 * invitation a person takes their seat by (`invite`) holds the secret key that
 * spends every shielded coin they own, and only their own wallet proves the
 * seat with it. Thrown, with nothing built or sent, when anything handed to the
 * page's builder carries one.
 */
export class WalletKeyNotForAPage extends Error {
  constructor() {
    super('this page was handed the key a wallet takes an invited seat with, and that key spends every coin the wallet holds, so '
      + 'nothing was built or sent. Take the seat from your own wallet, never from a page; if a page asked you for it, do not '
      + 'use that page again.');
    this.name = 'WalletKeyNotForAPage';
  }
}

export const refuseAWalletsCoinKey = (...given: unknown[]): void => {
  if (given.some((x) => typeof x === 'object' && x !== null && 'invite' in x)) throw new WalletKeyNotForAPage();
};

/** The record, with the invitation a wallet takes a seat by a refusal rather than a value: no circuit this page builds reads it. */
export const withNoInvitation = <T extends object>(record: T): T => Object.defineProperty(record, 'invite', {
  enumerable: false,
  get: () => { throw new WalletKeyNotForAPage(); },
});

/** What each call is called in a sentence a person reads. */
const CALLED: Readonly<Record<string, string>> = {
  approve: 'approval', propose: 'proposal', removeSignerAndSetThreshold: 'removal', setThreshold: 'threshold change',
  adopt: 'adoption of the vault', sealPayKey: 'sealing of the pay-record key',
  setVaultThreshold: 'change of a vault\'s approvals needed', cancel: 'withdrawal',
  setPolicy: 'spending policy', setPolicyBar: 'change of the approvals a policy change needs',
};

/**
 * **WHY A CALL COULD NOT BE BUILT, IN THE CONTRACT'S OR THE WITNESS'S OWN
 * WORDS.** The call builder lifts a failed assertion's sentence to the top, but
 * a witness that refuses - "you are not a signer on this account" - arrives
 * wrapped as a generic failure to run the circuit, with the sentence one level
 * down. That sentence is the one a person can act on, so it is brought up.
 */
export class CallNotBuilt extends Error {
  constructor(readonly circuit: string, why: string, options?: { cause?: unknown }) {
    super(`this ${CALLED[circuit] ?? 'proposal'} could not be built on this device: ${why}. Nothing was proved or sent.`, options);
    this.name = 'CallNotBuilt';
  }
}

export const theWitnessSaid = (circuit: string, e: unknown): unknown => {
  const outer = e as { _tag?: unknown; cause?: unknown } | null;
  const inner = outer?.cause as { message?: unknown } | undefined;
  if (outer?._tag === 'ContractRuntimeError' && inner instanceof Error && typeof inner.message === 'string' && inner.message !== '') {
    return new CallNotBuilt(circuit, inner.message, { cause: e });
  }
  return e;
};

/**
 * **A CALL IS BUILT ONLY FOR THE PROPOSAL THE SERVICE WROTE DOWN.** Its
 * identity is made here, by the contract's own functions, from what this device
 * was handed - the run or the change, and the salt - and compared with the
 * identity the service recorded. A mismatch - a salt, a window, a vault, a leaf
 * or a threshold that is not the recorded proposal's - is refused before
 * anything is built, because the chain would otherwise hold, or act on, a
 * proposal the service's record does not describe. Each carrying out this device
 * builds (the circuits of `GovernedCallOrder`) is checked the same way: its change
 * and its salt must make the approved round's identity. A recovery of the record
 * anchor is checked where it is built (`buildRecoverAnchorCall`).
 */
export function refuseARaiseThatIsNotTheRecordedOne(deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder): void {
  if ((order.circuit === 'approve' && order.of === undefined) || order.circuit === 'cancel') return;
  const P = deps.accountPure;
  let made: Uint8Array;
  if (order.circuit === 'approve') {
    made = P.proposalIdOf(governancePayloadOf(deps, order.of!.governance), P.noVault(), bytesOf('proposal\'s salt', order.of!.proposalSalt));
  } else if (order.circuit === 'propose' && raisesARun(order)) {
    const [, root, payees, opensAt, closesAt, required, , vault] = partsFor(order) as [unknown, Uint8Array, bigint, bigint, bigint, bigint, unknown, Uint8Array];
    made = P.proposalIdOf(P.runPayload(root, payees, opensAt, closesAt, required), vault, bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'propose') {
    made = P.proposalIdOf(governancePayloadOf(deps, raisedChange(order)), P.noVault(), bytesOf('proposal\'s salt', order.half.proposalSalt));
  } else if (order.circuit === 'removeSignerAndSetThreshold') {
    made = P.proposalIdOf(removalPayloadOf(deps, order.leaf, removalThresholdOf(order.threshold)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'adopt') {
    made = P.proposalIdOf(adoptionPayloadOf(deps, order.vault), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'sealPayKey') {
    made = P.proposalIdOf(payKeyPayloadOf(deps, order.commitment), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setVaultThreshold') {
    made = P.proposalIdOf(vaultThresholdPayloadOf(deps, order.vault, order.threshold), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setPolicy') {
    made = P.proposalIdOf(spendingPolicyPayloadOf(deps, order.vault, assetKeyMadeHere(deps, order.asset, order.assetBlinding),
      order.commitment), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else if (order.circuit === 'setPolicyBar') {
    made = P.proposalIdOf(policyBarPayloadOf(deps, order.bar), P.noVault(), bytesOf('proposal\'s salt', order.proposalSalt));
  } else {
    made = P.proposalIdOf(P.setThresholdPayload(thresholdOf(order.threshold)), P.noVault(),
      bytesOf('proposal\'s salt', order.proposalSalt));
  }
  const hex = Array.from(made, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== String(order.proposal).toLowerCase()) {
    throw new Error(
      order.circuit === 'propose'
        ? 'the proposal this device was asked to raise is not the one the company wrote down: its parts and its salt '
          + 'make another identity. Nothing was built or sent. Reload the page and try again.'
        : order.circuit === 'approve'
          ? 'the proposal this device was asked to approve is not for the change asked for here. Nothing was built or '
            + 'sent. Reload the page and try again; if it happens again, do not approve it.'
          : 'the approved proposal this device was asked to act on is not for this change: the change and its salt make '
            + 'another identity. Nothing was built or sent. Reload the page and try again.');
  }
}

const same = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();
const changeNamed = (g: RoundChangeOnTheWire | undefined): string =>
  (g?.kind === 'threshold' || g?.kind === 'vault-threshold' ? 'threshold' : g?.kind === 'adopt-vault' ? 'vault adopted'
    : g?.kind === 'pay-key' ? 'pay-record key' : g?.kind === 'spending-policy' ? 'policy' : g?.kind === 'policy-bar' ? 'policy bar'
      : g?.kind === 'recover-anchor' ? 'recovery' : g?.kind === 'add-signer' ? 'invitation' : g?.kind === 'retire-vault' ? 'vault retired' : 'leaf');

/**
 * **EACH CARRYING OUT IS THE CHANGE ITS PROPOSAL APPROVED.** A removal, a threshold, a vault's threshold, an adoption,
 * the pay-record key, a spending policy and its bar are each held to the change this device opened, and refused by
 * name where they differ. Answers whether `order` is one of them, so its check is done.
 */
type CarryingOut = Extract<GovernedCallOrder, {
  readonly circuit: 'removeSignerAndSetThreshold' | 'setThreshold' | 'setVaultThreshold' | 'adopt' | 'sealPayKey' | 'setPolicy' | 'setPolicyBar';
}>;
const carryingOutRefused = (
  deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder, g: OpenedRound['governance'], refuse: (value: string) => never,
): order is CarryingOut => {
  if (order.circuit === 'removeSignerAndSetThreshold') {
    if (g?.kind !== 'remove-signer' || order.removing !== true || !same(order.leaf, g.leaf)) refuse('leaf');
    /* The threshold carried out is the one the removal was raised with: none or 0 keeps the threshold in force. */
    const raised = g?.kind === 'remove-signer' ? g.threshold ?? '0' : '0';
    if (removalThresholdOf(order.threshold) !== removalThresholdOf(raised)) refuse('threshold');
    return true;
  }
  if (order.circuit === 'setThreshold') {
    if (g?.kind !== 'threshold' || thresholdOf(order.threshold) !== thresholdOf(g.threshold)) {
      refuse('threshold');
    }
    return true;
  }
  if (order.circuit === 'setVaultThreshold') {
    if (g?.kind !== 'vault-threshold' || !same(order.vault, g.vault) || thresholdOf(order.threshold) !== thresholdOf(g.threshold)) {
      refuse('threshold');
    }
    return true;
  }
  if (order.circuit === 'adopt') {
    if (g?.kind !== 'adopt-vault' || !same(order.vault, g.vault)) refuse('vault adopted');
    return true;
  }
  if (order.circuit === 'sealPayKey') {
    if (g?.kind !== 'pay-key' || !same(order.commitment, g.commitment)) refuse('pay-record key');
    return true;
  }
  if (order.circuit === 'setPolicy') {
    /*
     * The policy carried out is the one approved: the vault, the currency's key
     * made here from what this device is handed, and a commitment the opening
     * this device holds makes, all the proposal's own.
     */
    if (g?.kind !== 'spending-policy' || !same(order.vault, g.vault) || !same(order.commitment, g.commitment)
      || !same(assetKeyMadeHere(deps, order.asset, order.assetBlinding), g.assetKey)
      || !same(policyCommitmentMadeHere(deps, order.policy), g.commitment)) {
      refuse('policy');
    }
    return true;
  }
  if (order.circuit === 'setPolicyBar') {
    if (g?.kind !== 'policy-bar' || policyBarOf(order.bar) !== policyBarOf(g.bar)) refuse('policy bar');
    return true;
  }
  return false;
};

/**
 * **NOTHING IS PROVED WITH A VALUE THIS DEVICE DID NOT READ ITSELF, BUT TWO.**
 *
 * The proposal's identity is remade, with the contract's own functions, from
 * the payload and vault its record carries and the salt sealed inside it, and
 * must be the identity the record names. Then every value the service sent -
 * the proposal's identity, the salt, the leaf or the threshold, the run, the
 * vault and the account's half - must be the one read here, or the call is
 * refused naming the value, before anything is built. A seat or a threshold
 * change must also be the change whose payload the record carries.
 *
 * **THE FIRST IS THE ACCOUNT'S ASSET BLINDING**, which is the service's: see
 * the account's half above. **THE SECOND IS THE RUN ITSELF - ITS PAYOUT ROOT,
 * ITS COUNT OF PAYEES AND ITS WINDOW - WHICH IS ONLY AS GOOD AS THE RECORD**:
 * the payload the run must make is kept on the record beside the sealed part,
 * not inside it, so a record written down with another run passes here. And
 * the chain's state a call is built against is the one the service read.
 */
export function refuseWhatThisDeviceDidNotOpen(
  deps: Pick<GovernedCallDeps, 'accountPure'>, order: GovernedCallOrder, opened: OpenedRound,
): void {
  if (typeof opened !== 'object' || opened === null) {
    throw new Error('this device could not read the company\'s record of this proposal, so nothing was built or sent. '
      + 'Reload the page and try again.');
  }
  const P = deps.accountPure;
  const c = order.circuit;
  const refuse = (value: string): never => { throw new NotWhatThisDeviceOpened(value, c); };
  const made = hexOf(P.proposalIdOf(bytesOf('proposal\'s payload', opened.digest), bytesOf('vault', opened.vault),
    bytesOf('proposal\'s salt', opened.salt)));
  if (!same(made, opened.chainId)) throw new RecordDoesNotAddUp(c);
  if (!same(order.proposal, opened.chainId)) refuse('proposal identity');
  const saltHanded = order.circuit === 'propose' ? order.half.proposalSalt
    : order.circuit === 'approve' ? order.of?.proposalSalt : order.circuit === 'cancel' ? undefined : order.proposalSalt;
  if (saltHanded !== undefined && !same(saltHanded, opened.salt)) refuse('salt');
  const g = opened.governance;
  if (g !== undefined) {
    if (!same(opened.vault, hexOf(P.noVault()))) refuse('vault');
    if (!same(hexOf(governancePayloadOf(deps, g)), opened.digest)) refuse(changeNamed(g));
  }
  if (order.circuit === 'approve') {
    if (order.of !== undefined && (g === undefined || !sameGovernance(order.of.governance, g))) {
      refuse(changeNamed(order.of.governance));
    }
    return;
  }
  /* A withdrawal names only the proposal, and the proposal is the one this device opened. */
  if (order.circuit === 'cancel') return;
  if (carryingOutRefused(deps, order, g, refuse)) return;
  if (raisesARun(order)) {
    if (g !== undefined) refuse('change');
    const [, root, payees, opensAt, closesAt, required, , vault] = partsFor(order) as [unknown, Uint8Array, bigint, bigint, bigint, bigint, unknown, Uint8Array];
    if (!same(hexOf(P.runPayload(root, payees, opensAt, closesAt, required)), opened.digest)) refuse('run');
    if (!same(hexOf(vault), opened.vault)) refuse('run vault');
  } else if (g === undefined || !sameGovernance(raisedChange(order), g)) {
    refuse(changeNamed(raisedChange(order)));
  }
  const h = opened.half;
  if (h === undefined) {
    throw new Error('this device could not read the change sealed in the company\'s record of this proposal, so it cannot '
      + 'send it. Nothing was built or sent. Reload the page and try again.');
  }
  if (!same(order.half.assetId, h.assetId)) refuse('asset');
  if (String(order.half.changeAmount) !== String(h.changeAmount)) refuse('amount');
  if (!same(order.half.changeBatchDigest, h.changeBatchDigest)) refuse('payments digest');
}

/** A raise refused before it is built: by this device's clock the chain no longer takes it, and never will. */
export class RaiseTooLate extends Error {
  readonly nothingWasSent = true;
  constructor(readonly raiseBy: string) {
    super(`the chain takes this proposal's raise only before ${new Date(Number(raiseBy) * 1000).toISOString()}, and by this `
      + 'device\'s clock that time has passed, so it can never be raised. Nothing was built or sent. Withdraw it if it is '
      + 'written down, and raise it again.');
    this.name = 'RaiseTooLate';
  }
}

/** Refuses a raise once this device's clock has reached the deadline it would carry. */
export const refuseARaisePastItsTime = (deps: Pick<GovernedCallDeps, 'now'>, raiseBy: string): void => {
  if (!raiseMayStillLandAt(raiseBy, (deps.now ?? Date.now)())) throw new RaiseTooLate(raiseBy);
};
