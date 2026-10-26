/**
 * **A PROPOSAL AS A SIGNER'S DEVICE WRITES IT DOWN: SEALED THERE, SIGNED BY
 * THE SEAT THAT RAISED IT.**
 *
 * What a proposal changes, who raised it and the salt its identity is made
 * with are sealed on the raising device under the company's key in force, the
 * way every signer's device opens them. Beside the envelope go only the facts
 * the chain shows anyway: its identity there, the payload that identity is
 * made from, and the key epoch it was sealed at. The whole filing is signed by
 * the raising seat's filing key, so the service can check it was a seat of the
 * company that wrote it (`filerSeatOf`) and every device can check the same.
 *
 * Pure: the page and the service both import it, and it loads nothing else.
 */
import { keyOf, type KeysHeld } from './company-key.js';
import type { Vouched } from '../midnight/record-tree.js';
import { canonical, commit, parseCanonical, seal, sign, signingPublicKeyOf, unseal, verify, type Hex, type Sealed } from './crypto.js';
import { openRecord, sealRecord } from './sealed-records.js';
import type { ProposalKind, Role, SealedProposal, ShieldedEntry } from './types.js';
import { seatInvitationRefusal, type Inviter, type SignedSeatInvitation } from './invitation.js';
import { paymentsCheckedDigest, type PaymentChecked } from './device-raise.js';

const DOMAIN = 'confidential-accounts/proposal-filing/v1';
const HEX64 = /^[0-9a-f]{64}$/u;

/** A proposal's own name in this product: `prp_` and twelve characters. */
export const PROPOSAL_ID = /^prp_[A-Za-z0-9_-]{12}$/u;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** A new proposal's name, made where the proposal is written down. */
export const newProposalId = (random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string =>
  `prp_${Array.from(random(12), (b) => ALPHABET[b & 63]).join('')}`;

/** What a device files for a proposal: the plain facts the chain shows, and the envelope. */
export interface ProposalFiling {
  readonly id: string;
  readonly digest: Hex;
  readonly chainId: Hex;
  readonly keyEpoch: number;
  readonly createdAt: string;
  readonly sealed: Sealed;
  /**
   * **WHAT A PAYROLL PROPOSAL PAYS, COMMITTED TO**: `paysCommitmentOf` over the
   * vault, the asset and every payment's kind, token and amount, keyed with the
   * proposal's salt and the company's asset blinding. Present on a payroll
   * proposal and only there. The service keeps it and never sees what it commits
   * to; every signer's device holds it to the run it builds again.
   */
  readonly pays?: Hex;
}

/** The raising seat's signature over the filing, and the key it is checked against. */
export interface ProposalFiledBy { readonly publicKey: Hex; readonly signature: Hex }

export type SignedProposalFiling = ProposalFiling & { readonly filedBy: ProposalFiledBy };

/** The exact text the raising seat signs: the company, then every field of the filing. */
export const proposalFilingMessage = (company: string, f: ProposalFiling): string => canonical({
  domain: DOMAIN, company, id: f.id, digest: f.digest, chainId: f.chainId, keyEpoch: f.keyEpoch, createdAt: f.createdAt,
  sealed: { iv: f.sealed.iv, tag: f.sealed.tag, body: f.sealed.body },
  ...(f.pays === undefined ? {} : { pays: f.pays }),
});

/** The filing, signed by the seat raising it. The signing secret stays on the device. */
export const signProposalFiling = (company: string, f: ProposalFiling, signingSecret: Hex): SignedProposalFiling => ({
  id: f.id, digest: f.digest, chainId: f.chainId, keyEpoch: f.keyEpoch, createdAt: f.createdAt, sealed: f.sealed,
  ...(f.pays === undefined ? {} : { pays: f.pays }),
  filedBy: { publicKey: signingPublicKeyOf(signingSecret), signature: sign(proposalFilingMessage(company, f), signingSecret) },
});

/**
 * **WHY THIS IS NOT A PROPOSAL FILING FOR `company`, OR NULL WHEN IT IS ONE**
 * whose signature covers exactly it. Who the signing key belongs to is the
 * directory's question, asked by the caller.
 */
export const proposalFilingRefusal = (company: string, f: unknown): string | null => {
  if (typeof f !== 'object' || f === null) return 'it is not a proposal';
  const r = f as Partial<SignedProposalFiling>;
  if (typeof r.id !== 'string' || !PROPOSAL_ID.test(r.id)) return 'it does not carry a proposal\'s name';
  if (typeof r.digest !== 'string' || !HEX64.test(r.digest)) return 'it does not carry what the proposal commits to';
  if (typeof r.chainId !== 'string' || !HEX64.test(r.chainId)) return 'it does not carry the proposal\'s identity on the chain';
  if (!Number.isInteger(r.keyEpoch) || (r.keyEpoch as number) < 0) return 'it does not say which key it is sealed under';
  if (typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) return 'it does not say when it was written';
  const s = r.sealed as Partial<Sealed> | undefined;
  if (typeof s !== 'object' || s === null || typeof s.iv !== 'string' || typeof s.tag !== 'string' || typeof s.body !== 'string') {
    return 'it carries no sealed proposal';
  }
  if (r.pays !== undefined && (typeof r.pays !== 'string' || !HEX64.test(r.pays))) return 'what it says it pays is not a commitment';
  const by = r.filedBy as Partial<ProposalFiledBy> | undefined;
  if (typeof by?.publicKey !== 'string' || typeof by.signature !== 'string') return 'it is not signed';
  let ok = false;
  try { ok = verify(proposalFilingMessage(company, r as ProposalFiling), by.signature, by.publicKey); } catch { ok = false; }
  return ok ? null : 'its signature does not cover exactly this proposal for this company';
};

/** What a payroll proposal pays: the vault, the asset, and each payment's kind, token and amount. */
export interface ProposalPays {
  readonly vault: string;
  readonly asset: string;
  readonly payments: Iterable<PaymentChecked>;
}

/**
 * **THE COMMITMENT A PAYROLL PROPOSAL'S FILING CARRIES TO WHAT IT PAYS**, keyed
 * with the proposal's salt and the company's asset blinding. The service is
 * handed the salt with every filing, so a commitment keyed by the salt alone
 * could be opened there by trying amounts; the asset blinding is held only by
 * the company's signers. The payments are taken in order and as
 * `paymentsCheckedDigest` takes them.
 */
export const paysCommitmentOf = (pays: ProposalPays, salt: string, assetBlinding: string): Hex => {
  if (!HEX64.test(salt.toLowerCase()) || !HEX64.test(assetBlinding.toLowerCase())) {
    throw new Error('what a proposal pays is committed to with its salt and the company\'s asset blinding, and one of them is missing.');
  }
  const key = commit(canonical({ domain: `${DOMAIN}/pays-key`, salt: salt.toLowerCase() }), assetBlinding.toLowerCase() as Hex);
  return commit(canonical({
    domain: `${DOMAIN}/pays`, vault: pays.vault.toLowerCase(), asset: pays.asset.toLowerCase(),
    payments: paymentsCheckedDigest(pays.payments),
  }), key);
};

/** What a governance proposal changes, as its sealed payload holds it. */
export type GovernancePayloadBody =
  /**
   * A seat: the person waiting for it, the invitation naming its leaf, carried to their own entry once seated, and
   * the seat raising it as an inviter record (`inviter`), handed to the person's wallet on its first records-key ask.
   */
  | { readonly signerId: string; readonly invited?: SignedSeatInvitation; readonly inviter?: Inviter }
  | { readonly newThreshold: number }
  | { readonly vault: Hex; readonly newThreshold: number }
  /** A vault's spending policy for one currency: the currency's blinded key, never the currency, and the policy's commitment. */
  | { readonly vault: Hex; readonly assetKey: Hex; readonly commitment: Hex }
  | { readonly newPolicyBar: number }
  /**
   * A signer removed: the leaf the chain takes off, and the retirement of its seat in the company's directory that
   * every approving device signs with its approval. None for a leaf the company's directory holds no entry for.
   */
  | { readonly leaf: Hex; readonly retirement?: RetirementTerms }
  /** A new vault taken into the company's account, by its address. */
  | { readonly vault: Hex };

/**
 * **WHAT A REMOVAL'S RETIREMENT SAYS, AS ITS PROPOSAL CARRIES IT**: the last
 * version of each record the leaving seat filed, its records-key statement as
 * its own wallet signed it where one exists, and the approvals it is signed
 * at. Every approving device signs exactly these, over the directory version
 * next when it signs, and refuses terms it would not have made itself.
 */
export interface RetirementTerms {
  readonly filedUpTo: Readonly<Record<string, number>>;
  /**
   * The anchored head `filedUpTo` was taken at, as the anchor names it: what every approving device judges the
   * boundary against, so what the leaving seat anchors after it voids nothing. Absent on terms raised before heads were
   * named, which no device approves.
   */
  readonly atHead?: string;
  readonly statement?: { readonly recordsKey: string; readonly seat: string; readonly signature: string };
  readonly threshold: number;
}

/**
 * The governance kinds a device seals. A vault's spending policy, the
 * approvals a policy change needs and a new vault's adoption are named here and
 * not yet among the kinds the company's proposal list says in words, which
 * reads each as a change to the company.
 */
type GovernanceKind = Extract<ProposalKind, 'add-signer' | 'remove-signer' | 'set-threshold' | 'set-vault-threshold'> | 'set-spending-policy'
  | 'set-policy-bar' | typeof ADOPT_VAULT;

/** A new vault's adoption into the company's account: a governance proposal, raised by the device setting the vault up. */
export const ADOPT_VAULT = 'adopt-vault';

/**
 * A new vault's first secret run: the run its signers approve the vault's
 * first secret under. It moves no money and is approved only from setting the
 * vault up, never from the proposals list.
 */
export const VAULT_SECRET = 'vault-secret';

/** The two proposals setting up a new vault raises, which a device acts on only from setting that vault up. */
export const VAULT_START_KINDS: readonly string[] = Object.freeze([ADOPT_VAULT, VAULT_SECRET]);

/**
 * **A GOVERNANCE PROPOSAL'S ENVELOPE, SEALED ON THE DEVICE RAISING IT**, in the
 * shape every signer's device opens a proposal: what it is, what the person is
 * shown, the vault it concerns (none, for governance), and the payload with the
 * change its identity is made from. A governance proposal moves no money, so its
 * change is zero in the reserved "no asset".
 */
export const sealGovernanceProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly kind: GovernanceKind;
  readonly summary: string; readonly noVault: Hex; readonly body: GovernancePayloadBody;
  readonly change: { readonly asset: string; readonly amount: bigint; readonly batchDigest: Hex; readonly salt: Hex };
  /** The seat raising it, and its role, as the company's directory holds them. */
  readonly proposedBy: string; readonly proposerRole?: Role;
}): Sealed => sealRecord('proposals', input.accountId, {
  vault: input.noVault, kind: input.kind, summary: input.summary,
  sealedPayload: seal(canonical({ ...input.body, entries: [], __change: input.change }), input.viewingKey),
  proposedBy: input.proposedBy, ...(input.proposerRole === undefined ? {} : { proposerRole: input.proposerRole }),
  approvals: [],
}, input.viewingKey);

/**
 * **THE INVITATION BEHIND A SEAT, AS THE COMPANY'S PROPOSAL TO ADD IT CARRIES
 * IT**: the one whose seat is `seat`, opened from the company's proposals, each
 * with the company's key of the epoch it was sealed at; null when none carries one for that seat. The proposal
 * carries the invitation naming the seat's leaf, which the person's own
 * directory entry must carry, on every way in. Nothing here is believed: a
 * member's device judges the invitation where it judges the entry.
 */
export const seatInvitationIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): SignedSeatInvitation | null => seatAddedIn(proposals, accountId, viewingKey, seat)?.invited ?? null;

/**
 * **THE SEAT THAT RAISED THE PROPOSAL ADDING `seat`, AS AN INVITER RECORD**:
 * its wallet key, the directory entry its wallet signed and its own seat's
 * opening, as the proposal carries them; null when none carries one. Handed to
 * the person's own wallet on its first records-key ask, which believes it only
 * where that seat is on the account as the wallet reads it, and its opening
 * proves that key for it; nothing here is believed.
 */
export const seatInviterIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): Inviter | null => seatAddedIn(proposals, accountId, viewingKey, seat)?.inviter ?? null;

/** What one opened proposal to add a seat carries: its request id, its invitation, and the seat that raised it. */
/** A proposal as an add-signer one is read from: its company, its sealed body, and the key epoch it was sealed at. */
type ProposalOpened = Pick<SealedProposal, 'accountId' | 'sealed'> & Partial<Pick<SealedProposal, 'keyEpoch'>>;

interface AddSignerOpened {
  readonly rec: ProposalOpened & Partial<Pick<SealedProposal, 'chainId'>>;
  readonly signerId: unknown;
  readonly invited?: SignedSeatInvitation;
  readonly inviter?: Inviter;
}

/** Every proposal to add a seat the key of its own epoch opens, with what it carries; one that key does not open names nothing. */
const addSignersOpened = (
  proposals: readonly (ProposalOpened & Partial<Pick<SealedProposal, 'chainId'>>)[], accountId: string, viewingKey: KeysHeld,
): AddSignerOpened[] => proposals.flatMap((rec) => {
  try {
    const key = keyOf(viewingKey, rec.keyEpoch);
    const envelope = openRecord<{ kind: string; sealedPayload: Sealed }>('proposals', accountId, rec.sealed, key);
    if (envelope.kind !== 'add-signer') return [];
    const body = parseCanonical<{ signerId?: unknown; invited?: unknown; inviter?: unknown }>(unseal(envelope.sealedPayload, key));
    const invited = seatInvitationRefusal(body.invited) === null ? body.invited as SignedSeatInvitation : undefined;
    const inviter = body.inviter as Inviter | undefined;
    return [{ rec, signerId: body.signerId, ...(invited === undefined ? {} : { invited }), ...(typeof inviter === 'object' && inviter !== null ? { inviter } : {}) }];
  } catch {
    /* A record its epoch's key does not open, or whose epoch this device cannot reach, names no seat of this company's. */
    return [];
  }
});

/**
 * The proposal adding `seat`: the one whose invitation names that leaf, read by
 * the leaf and never by the order the service lists them in. Where proposals
 * carry two different invitations for one leaf, none is taken: which one the
 * signers approved is not this list's to say.
 */
const seatAddedIn = (
  proposals: readonly ProposalOpened[], accountId: string, viewingKey: KeysHeld, seat: string,
): AddSignerOpened | null => {
  const named = addSignersOpened(proposals, accountId, viewingKey).filter((x) => x.invited?.terms.leaf?.toLowerCase() === seat.toLowerCase());
  return new Set(named.map((x) => x.invited!.signature.toLowerCase())).size === 1 ? named[0]! : null;
};

/**
 * **WHETHER THE CHAIN HOLDS A PROPOSAL TO SEAT THE REQUEST `signerId` OPEN**:
 * one this key opens, for that request, whose id is among the proposals the
 * chain holds open (`openOnTheChain`, as the device's own read of the chain
 * gives them) - approved or not - or one whose id on the chain the seat that
 * raised it did not sign. A request is not withdrawn while one is: the chain
 * could still seat its leaf. What the service writes of a proposal's standing
 * is never asked.
 */
export const seatStillProposedFor = (
  proposals: readonly SealedProposal[], accountId: string, viewingKey: KeysHeld, signerId: string, openOnTheChain: readonly string[],
): boolean => addSignersOpened(proposals, accountId, viewingKey).some((x) => {
  if (x.signerId !== signerId) return false;
  /* Its id on the chain counts only as the seat that raised it signed it; one nobody signed could be any proposal. */
  if (proposalFilingRefusal(accountId, x.rec) !== null) return true;
  return openOnTheChain.some((id) => id.toLowerCase() === String(x.rec.chainId).toLowerCase());
});

/** Whether a value names a proposal kind this file seals. */
export const isGovernanceKind = (kind: unknown): kind is GovernanceKind =>
  kind === 'add-signer' || kind === 'remove-signer' || kind === 'set-threshold' || kind === 'set-vault-threshold'
  || kind === 'set-spending-policy' || kind === 'set-policy-bar' || kind === ADOPT_VAULT;

/** What a round's entries commit to, folded into the change its proposal seals. */
export const batchDigestOf = (entries: readonly ShieldedEntry[]): Hex => commit(canonical(entries), '');

/**
 * **A PAYROLL RUN'S LEG, SEALED AS A PROPOSAL OF THE COMPANY'S**, exactly as a
 * governance proposal is: the vault that pays it, a summary, the payload - the
 * run, the leg's form and its entries, the window the run is raised with,
 * the change and the approvals the run's total needs - sealed under the company's viewing key, and the seat raising
 * it. The device raising the leg seals it and signs the filing.
 */
export const sealPayrollProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly vault: Hex; readonly summary: string;
  readonly payload: {
    readonly runId: string; readonly form: string; readonly entries: readonly ShieldedEntry[];
    /**
     * The leg's root, its payee count and the run's window, as its identity
     * on chain is made from them: where a device reads when the run's window
     * closes, checked against that identity.
     */
    readonly window: { readonly root: Hex; readonly payees: string; readonly opensAt: string; readonly closesAt: string };
  };
  /**
   * The change, with what the salt is made from beside it - the head its raiser
   * checked and a random value: the one place they are kept.
   */
  readonly change: { readonly asset: string; readonly amount: bigint; readonly batchDigest: Hex; readonly salt: Hex; readonly vouched: Vouched };
  readonly required?: bigint;
  readonly proposedBy: string; readonly proposerRole?: Role;
}): Sealed => sealRecord('proposals', input.accountId, {
  vault: input.vault, kind: 'payroll', summary: input.summary,
  sealedPayload: seal(canonical({
    ...input.payload, __change: input.change, ...(input.required ? { __required: input.required } : {}),
  }), input.viewingKey),
  proposedBy: input.proposedBy, ...(input.proposerRole === undefined ? {} : { proposerRole: input.proposerRole }),
  approvals: [],
}, input.viewingKey);

/**
 * **A NEW VAULT'S FIRST SECRET RUN, SEALED AS A PROPOSAL OF THE COMPANY'S** on
 * the device raising it: the vault, and the run's root, payee count and window
 * with the salt in its change, which together make its identity on the chain
 * again (`proposalIdOf` over the run's payload, the vault and the salt), so any
 * signer's device can check the record is the run the chain holds. It is
 * sealed to every reader of the company's proposals, so it is given nothing
 * the run was made from: never the vault's secret, the run's nonce or a sealed
 * copy of the secret, none of which its input can carry.
 */
export const sealVaultSecretProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly summary: string;
  readonly run: {
    readonly vault: Hex; readonly root: Hex; readonly payees: string; readonly opensAt: string; readonly closesAt: string;
  };
  readonly change: { readonly asset: string; readonly amount: bigint; readonly batchDigest: Hex; readonly salt: Hex };
  readonly proposedBy: string;
}): Sealed => sealRecord('proposals', input.accountId, {
  vault: input.run.vault, kind: VAULT_SECRET, summary: input.summary,
  sealedPayload: seal(canonical({
    vault: input.run.vault, root: input.run.root, payees: input.run.payees, opensAt: input.run.opensAt, closesAt: input.run.closesAt,
    __change: input.change,
  }), input.viewingKey),
  proposedBy: input.proposedBy, approvals: [],
}, input.viewingKey);

/** The one size every one-off proposal's payload is sealed at: its record's name, its change and room to spare. */
export const TRANSFER_PAYLOAD_BYTES = 1024;

const paddedTransferPayload = (text: string): string => {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > TRANSFER_PAYLOAD_BYTES) throw new Error('this one-off payment\'s proposal does not fit the size every one is sealed at');
  return text + ' '.repeat(TRANSFER_PAYLOAD_BYTES - bytes);
};

/** The proposal kind a one-off payment from a vault is raised as. */
export const TRANSFER = 'transfer' satisfies ProposalKind;

/**
 * **A ONE-OFF PAYMENT, SEALED AS A PROPOSAL OF THE COMPANY'S** on the device
 * raising it: the vault and the one-off record it is raised over, by its id and
 * version, with the salt and the amount in its change, as every proposal
 * carries its change. To whom it pays and why are in that record
 * (`one-off-record.ts`), sealed under the company's one-offs key, never here:
 * any signer's device opens the record, rebuilds the run from it and checks it
 * is the run the chain holds. Never one of payroll's proposals.
 *
 * **SEALED AT ONE SIZE**, as its record is: the payload is padded to
 * `TRANSFER_PAYLOAD_BYTES`, so the length the service keeps says nothing of how
 * many digits the amount in its change has.
 */
export const sealTransferProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly vault: Hex; readonly summary: string;
  readonly oneOff: { readonly id: string; readonly version: number };
  readonly change: { readonly asset: string; readonly amount: bigint; readonly batchDigest: Hex; readonly salt: Hex };
  readonly proposedBy: string; readonly proposerRole?: Role;
}): Sealed => sealRecord('proposals', input.accountId, {
  vault: input.vault, kind: TRANSFER, summary: input.summary,
  sealedPayload: seal(paddedTransferPayload(canonical({ oneOff: { id: input.oneOff.id, version: input.oneOff.version }, __change: input.change })),
    input.viewingKey),
  proposedBy: input.proposedBy, ...(input.proposerRole === undefined ? {} : { proposerRole: input.proposerRole }),
  approvals: [],
}, input.viewingKey);
