/*
 * WHAT A PROPOSAL ASKS THE PERSON'S WALLET TO CHECK BEFORE IT APPROVES IT, OR PAYS A ONE-OFF PAYMENT ALREADY APPROVED,
 * read on this device from the company's sealed records alone: the proposal's own body, the run it pays a leg of or a retry of, the one-off payment it raises,
 * the invitation it carries. The wallet opens the same records itself and refuses a proposal that says otherwise, so
 * these are what the person is shown and the wallet checks, never what it trusts. Each field is named as the wallet's
 * approval reads it; a count or an amount stays a number until the act carries it (`proposalActInTheWallet`).
 */
import { parseCanonical, unseal } from '../../../src/core/crypto.js';
import { ledgerTokenOf } from '../../../src/core/assets.js';
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import type { AddSignerByAddress } from '../../../src/core/proposal-filing.js';
import { assetOfLeg, formOfLeg, isRunLeg, legEmployees, listOfRun } from '../../../src/core/run-legs.js';
import type { PayrollRun, Proposal, SealedProposal } from '../../../src/core/types.js';
import type { ProposalAsked } from './proposal-in-the-wallet.js';
import type { OneOffOnTheWire } from './vault-worker-client.js';

/** What the wallet is asked to check before it approves a proposal, under the names its approval reads them by. A change of policy names which change under `kind`. */
export type ProposalAsks = ProposalAsked;

/**
 * Why a waiting proposal of a kind the page approves carries no asks: its record, or the run or one-off payment it pays,
 * was not read or not believed on this device, or the network has never held it raised.
 */
export const ASKS_UNREAD = { notRead: 'not-read', notRaised: 'not-raised' } as const;
export type AsksUnread = (typeof ASKS_UNREAD)[keyof typeof ASKS_UNREAD];

/**
 * The words a proposal's asks are read and written in, compared and sent, never shown: the kind a change of policy is
 * listed as, the kinds it is sealed as with the name the wallet approves each under, the fields of a sealed proposal's
 * body the asks are read from, and the wallet's words for how a leg pays.
 */
const ASKED = {
  changePolicy: 'change-policy',
  policySealedAs: { 'set-spending-policy': 'spending-policy', 'set-policy-bar': 'policy-bar' } as Readonly<Record<string, string>>,
  body: { oneOff: 'oneOff', leaf: 'leaf', newThreshold: 'newThreshold', vault: 'vault', newPolicyBar: 'newPolicyBar', invited: 'invited' },
  form: { private: 'private', public: 'public' },
} as const;
const HEX64 = /^[0-9a-f]{64}$/u;
const hex64Of = (v: unknown): string | null => (typeof v === 'string' && HEX64.test(v.toLowerCase()) ? v.toLowerCase() : null);
const wholeOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null);

/** The one-off payment a proposal raises, as this device believes its record: its version and what it pays. */
export interface OneOffHere {
  readonly version: number;
  readonly oneOff: OneOffOnTheWire;
}

/** The records a proposal's asks are read from beyond its own body: the invitation it carries, and a one-off payment by its id. */
export interface AsksReads {
  readonly byAddress: (rec: SealedProposal) => AddSignerByAddress | null;
  readonly oneOff: (id: string) => Promise<OneOffHere | null>;
}

/**
 * What a proposal's asks came to: the asks, why a kind this page approves could not be read here, or null for a kind it does not approve. A one-off
 * payment's asks come with its payment leaf (`leaf`), as the worker built it from the record those asks were read from, when it built one; it is never one
 * of the asks the wallet is handed, only what the page asks the account about to say whether the payment is made.
 */
export type Asked = { readonly asks: ProposalAsks; readonly unread: null; readonly leaf?: string } | { readonly asks: null; readonly unread: AsksUnread } | null;
export const NOT_READ: Asked = { asks: null, unread: ASKS_UNREAD.notRead };
const asked = (asks: ProposalAsks | undefined): Asked => (asks === undefined ? NOT_READ : { asks, unread: null });

/**
 * A payroll proposal's asks: the run whose sealed record names it, for one leg or for a retry of some of that leg's
 * people, the leg's token and form, how many people it pays and what in all, and the vault the sealed proposal pays
 * from. A retry's people are the leg's people at the positions the retry names, as the wallet takes them; all of it is
 * read from the run's seal, where a retry is written with the run. A proposal no run names carries none.
 */
function payrollAsks(p: Proposal, runs: readonly PayrollRun[]): ProposalAsks | undefined {
  const vault = hex64Of(p.vault);
  for (const run of runs) {
    const main = Object.entries(run.proposalIds ?? {}).find(([, id]) => id === p.id)?.[0];
    const retried = main !== undefined ? undefined
      : Object.entries(run.payout ?? {}).flatMap(([leg, paid]) => (paid.retries ?? []).filter((r) => r.proposalId === p.id).map((r) => [leg, r] as const))[0];
    const leg = main ?? retried?.[0];
    if (leg === undefined) continue;
    const onTheLeg = isRunLeg(leg) ? legEmployees(run, leg) : [];
    const people = retried === undefined ? onTheLeg : retried[1].originalIndices.map((i) => onTheLeg[i]);
    if (vault === null || people.length === 0 || people.some((e) => e === undefined)) return undefined;
    return {
      run: run.id, period: run.period, list: listOfRun(run), vault, token: ledgerTokenOf(assetOfLeg(leg), formOfLeg(leg)),
      form: formOfLeg(leg) === 'shielded' ? ASKED.form.private : ASKED.form.public,
      payees: people.length, total: people.reduce((a, e) => a + BigInt(e!.amount), 0n),
    };
  }
  return undefined;
}

/**
 * A one-off payment's asks: what its believed record pays, and to whom, when that record says this proposal raised it;
 * with that record's payment leaf when the worker built one and it is thirty-two bytes.
 */
async function oneOffAsks(rec: SealedProposal, body: Readonly<Record<string, unknown>>, reads: AsksReads): Promise<Asked> {
  const named = body[ASKED.body.oneOff] as { readonly id?: unknown; readonly version?: unknown } | null | undefined;
  if (typeof named?.id !== 'string') return NOT_READ;
  const read = await reads.oneOff(named.id);
  const o = read?.oneOff;
  if (read == null || o === undefined || read.version !== named.version || o.proposal.id !== rec.id || o.proposal.chainId.toLowerCase() !== rec.chainId.toLowerCase()) return NOT_READ;
  const leaf = hex64Of(o.leaf);
  return {
    asks: {
      vault: o.vault.toLowerCase(), token: o.token, amount: o.amount, payee: o.payee.address, reason: o.reason,
      ...(o.payee.ref === null ? {} : { vendor: o.payee.ref }), ...(o.payee.name === null ? {} : { payeeName: o.payee.name }),
    },
    unread: null,
    ...(leaf === null ? {} : { leaf }),
  };
}

/** An invitation by address's asks: who it seats, with which role, at which address and rights, under which coin key, and any threshold it sets. */
function addSignerAsks(rec: SealedProposal, reads: AsksReads): ProposalAsks | undefined {
  const opened = reads.byAddress(rec);
  const terms = opened?.invited.terms;
  const invite = terms?.invite;
  if (opened == null || terms === undefined || invite === undefined || opened.coinPublicKey === null) return undefined;
  return {
    personName: terms.name, role: terms.role, address: invite.address, scope: invite.scope, coinKey: opened.coinPublicKey,
    ...(invite.threshold === undefined ? {} : { threshold: invite.threshold }),
  };
}

/** A removal's asks: the seat it removes, and the threshold it leaves the company at when it sets one. */
function removalAsks(body: Readonly<Record<string, unknown>>): ProposalAsks | undefined {
  const leaf = hex64Of(body[ASKED.body.leaf]);
  const t = body[ASKED.body.newThreshold];
  if (leaf === null || (t !== undefined && (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0))) return undefined;
  return { leaf, ...(typeof t === 'number' && t > 0 ? { threshold: t } : {}) };
}

/**
 * What a proposal asks the wallet to check, by its kind: its asks, or why they could not be read here, or null for
 * a kind the page does not approve, among them an invitation whose signed terms name no address. A spending policy's
 * terms open only with a signer's own key, held in their wallet, so its asks name the vault alone: the wallet reads the
 * terms itself and shows them for the signer to confirm before it approves.
 */
export async function proposalAsksHere(here: { readonly rec: SealedProposal; readonly opened: Proposal }, viewingKey: KeysHeld, runs: readonly PayrollRun[], reads: AsksReads): Promise<Asked> {
  const { rec, opened: p } = here;
  const kind = p.kind as string;
  if (kind === 'payroll') return asked(payrollAsks(p, runs));
  if (kind === 'pay-key') return { asks: {}, unread: null };
  const body = parseCanonical<Record<string, unknown> | null>(unseal(p.sealedPayload, keyOf(viewingKey, rec.keyEpoch))) ?? {};
  const vault = hex64Of(body[ASKED.body.vault]);
  const threshold = wholeOf(body[ASKED.body.newThreshold]);
  switch (kind) {
    case 'add-signer': {
      /* An invitation by address names the address it seats in its signed terms; one that names none is not approved here. */
      const terms = (body[ASKED.body.invited] as { readonly terms?: { readonly invite?: unknown } } | null | undefined)?.terms;
      return terms?.invite === undefined ? null : asked(addSignerAsks(rec, reads));
    }
    case 'transfer': return oneOffAsks(rec, body, reads);
    case 'remove-signer': return asked(removalAsks(body));
    case 'set-threshold': return asked(threshold === null ? undefined : { threshold });
    case 'set-vault-threshold': return asked(threshold === null || vault === null ? undefined : { threshold, vault });
    case 'set-spending-policy': return asked(vault === null ? undefined : { kind: ASKED.policySealedAs[kind]!, vault });
    case 'set-policy-bar': {
      const bar = wholeOf(body[ASKED.body.newPolicyBar]);
      return asked(bar === null ? undefined : { kind: ASKED.policySealedAs[kind]!, bar });
    }
    case 'adopt-vault': case 'vault-secret': return asked(vault === null ? undefined : { vault });
    default: return null;
  }
}

/** The kind a proposal is listed as: a change to a spending policy or to the approvals one needs is `change-policy`, whichever it is sealed as. */
export const listedKindOf = <K extends string>(kind: K): K | typeof ASKED.changePolicy => ((kind as string) in ASKED.policySealedAs ? ASKED.changePolicy : kind);
