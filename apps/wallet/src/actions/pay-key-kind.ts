/**
 * **THE PAY-RECORD KEY'S PROPOSAL, APPROVED AND CARRIED OUT BY ANY SIGNER IN
 * THE WALLET** (`approve-proposal`'s `pay-key` kind). The founding signer's
 * device raises it when it finishes the company, beside its record, which the
 * service keeps before it sends the raise (`finish-company.ts`). When the
 * founding seat cannot meet its bar alone, another signer approves it here, and
 * any signer whose approval brings it to its bar carries it out by sealing its
 * own copy of the key, which commits the account to it.
 *
 * What it approves, and from where: the record the service lists under the
 * name the page gave, opened under the company's key and believed as one a
 * seat of this company wrote down, of kind `pay-key`; the pay-record key the
 * company's signed first state holds, opened with the company's founding key;
 * the proposal's identity, payload and salt this wallet makes again from that
 * key with the account's own functions, which the record must name exactly, so
 * the key the approvers saw is the one sealed. Where the proposal stands, and
 * this seat's own approval, from the chain. The leaver check before every
 * approval and every carrying out. Approving files no record and raises
 * nothing; withdrawing it stays refused (`withdraw-proposal.ts`).
 */
import { x25519 } from '@noble/curves/ed25519.js';
import type { ActIntent } from 'midnight-identity/profile/request';
import { NO_ASSET } from '../../../../src/core/assets.js';
import { fromHex, toHex, type Hex } from '../../../../src/core/crypto.js';
import { PAY_KEY_SUMMARY, payKeyProposalIn } from '../../../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../../../src/core/types.js';
import { payKeyRoundOf, type PayKeyPure } from '../../../../src/midnight/pay-key-round.js';
import { sealPayKeyTo } from '../../../../src/midnight/run-keys.js';
import type { GovernedCallOrder, OpenedRound, RoundOnChain } from '../../../../packages/web-shared/src/governed-call-builder.js';
import { ApprovalNotOwed, refuseARunALeaverRaisedHere } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { believedFilerHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import { signedStateHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { handedOver } from '../../../../packages/web-shared/src/hand-over.js';
import { governanceDoorsFor, handOverMarked, pureCircuits, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ShownLine, type StepContext, type Words } from './definition.js';
import { carryStep, onTheChain, type ApprovalStop, type CarryOut, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';

/** What the pay-record key's kind reads and waits with. A test hands in its own. */
export interface PayKeyKindReach {
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's own functions the proposal's identity is made with; the account's compiled ones unless a test hands its own. */
  readonly payKeyPure?: () => Promise<PayKeyPure>;
  /** How long to wait for the chain to show what was sent, and how often to look. */
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** Where an approval leaves the proposal: waiting for the others' approvals, or at its bar for the carrying out. */
export const PAY_KEY_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.approve-pay-key.why.${key}`, ...(values === undefined ? {} : { values }),
});
const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };
const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const ZERO = '00'.repeat(32);
const WAIT_MS = 180_000;
const EVERY_MS = 5_000;

/** The proposal as this wallet opened it and made it again from the company's own pay-record key. */
interface PayKeyOpened {
  readonly chainId: Hex;
  readonly digest: Hex;
  readonly commitment: Hex;
  readonly salt: Hex;
  readonly noVault: Hex;
  readonly key: Hex;
}

/** The pay-record key's kind of the one approval. */
export function payKeyKind(reach: PayKeyKindReach): ProposalKind {
  const pure = reach.payKeyPure ?? (async () => (await pureCircuits()).account as unknown as PayKeyPure);
  const recordsOf = (ctx: StepContext, r: CompanyReach) => governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal)).records!;

  /*
   * The record under the page's name, opened and believed, and the proposal this wallet makes from the key the
   * company's signed first state holds: refused unless the two name the same proposal, payload, salt and key.
   */
  const openedHere = async (ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<PayKeyOpened> => {
    const records = recordsOf(ctx, r);
    const id = intent.fields['proposal']!;
    try {
      const rec = ((await records.proposals!()) as readonly SealedProposal[]).find((p) => p.id === id && p.accountId === r.accountId);
      const held = rec === undefined ? null : payKeyProposalIn(rec, r.accountId, r.companyKeys);
      if (rec === undefined || held === null) throw new StepRefused(why('not-a-pay-key'));
      await believedFilerHere(records, r.accountId, rec);
      const { payKey } = await signedStateHere(records, r.accountId, r.companyKeys);
      const P = await pure();
      const round = payKeyRoundOf(P, payKey as Hex);
      const noVault = toHex(P.noVault()).toLowerCase() as Hex;
      if (held.commitment !== round.commitment || held.digest !== round.payload || held.salt !== round.salt
        || held.chainId !== round.proposal || held.vault !== noVault) throw new StepRefused(why('not-as-held'));
      return { chainId: round.proposal, digest: round.payload, commitment: round.commitment, salt: round.salt, noVault, key: payKey as Hex };
    } catch (e) {
      if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
      throw new StepRefused(why('not-approved', { says: said(e) }), codeOfError(e));
    }
  };

  const leaverChecked = async (ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<void> => {
    try {
      await refuseARunALeaverRaisedHere(recordsOf(ctx, r), r.accountId, r.companyKeys, intent.fields['proposal']!);
    } catch (e) {
      if (e instanceof ActionStopped) throw e;
      throw new StepRefused(why('not-approved', { says: said(e) }), codeOfError(e));
    }
  };

  /* One call built and proved here with this seat's own material, then handed to the service's creation route, or straight to the chain. */
  const sent = async (r: CompanyReach, o: PayKeyOpened, order: GovernedCallOrder, handed: Handed): Promise<void> => {
    const chain = await r.chain.callState(r.account);
    if (chain === null) {
      throw Object.assign(new Error('this wallet could not read the company\'s account at one block, so nothing was built or sent.'), { nothingWasSent: true });
    }
    const opened = {
      chainId: o.chainId, digest: o.digest, vault: o.noVault, salt: o.salt, summary: PAY_KEY_SUMMARY,
      governance: { kind: 'pay-key', commitment: o.commitment }, half: { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: ZERO },
    } as OpenedRound;
    const { tx } = await r.builder.governedCall({
      account: r.account, order, opened, chain,
      material: { signingSecret: r.seat.signingSecret as Hex, blinding: r.seat.blinding as Hex, scope: r.seat.scope },
    });
    await handedOver(handOverMarked(r.handOver, handed), {
      tx, call: { kind: 'account-call', contract: r.account, circuit: order.circuit },
      viaService: async () => {
        handed.over = true;
        await r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/creation/pay-key`, {
          method: 'POST', body: JSON.stringify({ call: order.circuit, tx }),
        });
      },
      after: async () => undefined,
    });
  };

  /* The chain read until it shows what was sent; a wait that runs out stops the action, which reads the chain again. */
  const shown = async (ctx: StepContext, r: CompanyReach, chainId: Hex, done: (s: RoundOnChain | undefined) => boolean): Promise<void> => {
    const every = reach.everyMs ?? EVERY_MS;
    for (let waited = 0; waited <= (reach.waitMs ?? WAIT_MS); waited += every) {
      if (done(await onTheChain(r, chainId))) return;
      await reach.pause(every, ctx.signal);
    }
    throw new Error('the network does not show it yet. Press again: what the network already holds is not sent twice.');
  };

  const governance = (o: PayKeyOpened) => ({ kind: 'pay-key', commitment: o.commitment }) as const;

  const carryOut: CarryOut = async (ctx, r, intent, round, handed) => {
    await leaverChecked(ctx, r, intent);
    const o = await openedHere(ctx, r, intent);
    if (o.chainId !== round.chainId.toLowerCase()) throw new StepRefused(why('not-as-held'));
    const wrappingPublicKey = toHex(x25519.getPublicKey(fromHex(String(r.seat.wrappingSecret).toLowerCase()))) as Hex;
    await sent(r, o, {
      circuit: 'sealPayKey', wrap: sealPayKeyTo(o.key, wrappingPublicKey), commitment: o.commitment, proposal: o.chainId, proposalSalt: o.salt,
    } as GovernedCallOrder, handed);
    await shown(ctx, r, o.chainId, (s) => s?.held === 'closed');
  };

  const kind: ProposalKind = {
    fields: [],
    changesTheCompany: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.approve-pay-key.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' },
      { key: 'act.approve-pay-key.shown.checks', from: 'action' },
      { key: 'act.approve-pay-key.shown.approve', from: 'action' },
    ],
    check: () => null,
    opened: async (ctx, r, intent) => {
      const o = await openedHere(ctx, r, intent);
      return { id: intent.fields['proposal']!, chainId: o.chainId };
    },
    needed: (round, held) => Math.max(round.needed ?? 0, held.approvals),
    approve: async (ctx, r, intent, round, handed) => {
      await leaverChecked(ctx, r, intent);
      const o = await openedHere(ctx, r, intent);
      if (o.chainId !== round.chainId.toLowerCase()) throw new StepRefused(why('not-as-held'));
      const now = await onTheChain(r, o.chainId);
      if (now?.held === 'closed') throw new ApprovalNotOwed('carried-out');
      if (now?.approvedHere === true) throw new ApprovalNotOwed('counted');
      await sent(r, o, { circuit: 'approve', proposal: o.chainId, of: { governance: governance(o), proposalSalt: o.salt } } as GovernedCallOrder, handed);
      /* This seat's own approval on the chain, never a count another signer's approval can also raise. */
      await shown(ctx, r, o.chainId, (s) => s?.approvedHere === true || s?.held === 'closed');
    },
    stateAt: (atItsBar) => (atItsBar ? PAY_KEY_STATE.atItsBar : PAY_KEY_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.approve-pay-key.step.carry' }, carryOut)],
    why: kindWhy,
  };
  return kind;
}
