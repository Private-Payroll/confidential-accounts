/**
 * **A PROPOSAL AS A SIGNER'S DEVICE WRITES IT DOWN: SEALED THERE, SIGNED BY
 * THE SEAT THAT RAISED IT.**
 *
 * What a proposal changes, who raised it and the salt its identity is made
 * with are sealed on the raising device under the company's viewing key, the
 * way every signer's device opens them. Beside the envelope go only the facts
 * the chain shows anyway: its identity there, the payload that identity is
 * made from, and the key epoch it was sealed at. The whole filing is signed by
 * the raising seat's filing key, so the service can check it was a seat of the
 * company that wrote it (check S) and every device can check the same.
 *
 * Pure: the page and the service both import it, and it loads nothing else.
 */
import { canonical, commit, seal, sign, signingPublicKeyOf, verify, type Hex, type Sealed } from './crypto.js';
import { sealRecord } from './sealed-records.js';
import type { ProposalKind, Role, ShieldedEntry } from './types.js';
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
   * vault, the asset and every payment's kind, token and amount, made with the
   * proposal's own salt. Present on a payroll proposal and only there. The
   * service checks the vault's public money over the payments it commits to;
   * every signer's device opens the salt and holds it to the run it builds again.
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
 * **THE COMMITMENT A PAYROLL PROPOSAL'S FILING CARRIES TO WHAT IT PAYS**, made
 * with the proposal's salt, which only the company's signers open. The payments
 * are taken in order and as `paymentsCheckedDigest` takes them.
 */
export const paysCommitmentOf = (pays: ProposalPays, salt: string): Hex => commit(canonical({
  domain: `${DOMAIN}/pays`, vault: pays.vault.toLowerCase(), asset: pays.asset.toLowerCase(),
  payments: paymentsCheckedDigest(pays.payments),
}), salt.toLowerCase() as Hex);

/** What a governance proposal changes, as its sealed payload holds it. */
export type GovernancePayloadBody =
  | { readonly signerId: string }
  | { readonly newThreshold: number }
  | { readonly vault: Hex; readonly newThreshold: number };

/**
 * **A GOVERNANCE PROPOSAL'S ENVELOPE, SEALED ON THE DEVICE RAISING IT**, in the
 * shape every signer's device opens a proposal: what it is, what the person is
 * shown, the vault it concerns (none, for governance), and the payload with the
 * change its identity is made from. A governance proposal moves no money, so its
 * change is zero in the reserved "no asset".
 */
export const sealGovernanceProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly kind: Extract<ProposalKind, 'add-signer' | 'set-threshold' | 'set-vault-threshold'>;
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

/** Whether a value names a proposal kind this file seals. */
export const isGovernanceKind = (kind: unknown): kind is 'add-signer' | 'set-threshold' | 'set-vault-threshold' =>
  kind === 'add-signer' || kind === 'set-threshold' || kind === 'set-vault-threshold';

/** What a round's entries commit to, folded into the change its proposal seals. */
export const batchDigestOf = (entries: readonly ShieldedEntry[]): Hex => commit(canonical(entries), '');

/**
 * **A PAYROLL RUN'S LEG, SEALED AS A PROPOSAL OF THE COMPANY'S**, exactly as a
 * governance proposal is: the vault that pays it, a summary, the payload - the
 * run, the leg's form and its entries, the change and the approvals the run's
 * total needs - sealed under the company's viewing key, and the seat raising
 * it. The device raising the leg seals it and signs the filing.
 */
export const sealPayrollProposal = (input: {
  readonly accountId: string; readonly viewingKey: Hex; readonly vault: Hex; readonly summary: string;
  readonly payload: { readonly runId: string; readonly form: string; readonly entries: readonly ShieldedEntry[] };
  readonly change: { readonly asset: string; readonly amount: bigint; readonly batchDigest: Hex; readonly salt: Hex };
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
