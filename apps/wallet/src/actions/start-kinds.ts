/**
 * **A NEW VAULT'S ADOPTION AND ITS FIRST SECRET RUN, AS KINDS OF THE ONE APPROVAL.** Another seat set the vault up and
 * raised them; this wallet approves each with the person's seat and carries it out once the chain counts its bar. What
 * is approved is never the page's word: the company's record named is opened and held to the proposal this wallet makes
 * itself, the adoption's from the vault alone, the first secret run's from the secret the company's records hold for
 * the vault, read back and never filed again. Every check is the vault's own start's, made by the shared code before
 * each send (`approveStartRoundHere`, `carryStartRoundHere`): the adoption is refused once a removal has outrun it, and
 * whenever it would leave a vault short of signers who may approve its runs; the run only once every reader is a seat
 * the account holds, whose key its own wallet signed, and this signer's own copy opens. A round raised by a signer whose
 * removal is raised is neither approved nor carried out. Approving files nothing. Once the chain shows a proposal done
 * (the vault adopted, or started under the run's secret), its record is written down as carried out, the run's with its
 * public parts, which the service checks against its own read of the vault. A run whose secret is set and whose sealed
 * copies are still owed has them written by the next press (`afterClosed`).
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { readCompanyLabel, readAccountAddress, readVaultAddress } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import {
  ApprovalNotOwed, nothingWasSentBy, refuseARunALeaverRaisedHere,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import {
  approveStartRoundHere, carryStartRoundHere, finishedSecretRunHere, SAID, START_STOP, StartRoundRefused, startRoundOpenedHere, VaultStartOwed,
  type CreateVaultDoors, type StartRoundKind, type StartRoundNamed,
} from '../../../../packages/web-shared/src/vault-operation.js';
import { approversHere, governanceDoorsFor, handOverMarked, runsOutrunHere, type CompanyChain, type CompanyReach, type Handed } from './company-reach.js';
import { vaultDoorsFor, type CreateVaultReach } from './create-vault.js';
import { codeOfError, StepRefused, type ShownLine, type StepContext, type Words } from './definition.js';
import { oneOffNeeded } from './one-off-payment.js';
import { carryStep, type ApprovalStop, type CarryOut, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';

/** What approving a round of a vault's start needs beyond the company: the vault secrets this wallet keeps, its indexer, and how to wait. */
export interface StartKindsReach {
  readonly chain: () => CompanyChain;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly secrets: CreateVaultReach['secrets'];
  /** The indexer the wallet reads a vault at, for who holds it; absent, a round of a vault's start is refused. */
  readonly indexerHttp?: string;
}

/** Where a round of a vault's start stands once this wallet's approval is counted. */
export const START_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.approve-start.why.${key}`, ...(values === undefined ? {} : { values }),
});
const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };
const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const vaultOf = (intent: ActIntent): Hex | null => {
  const v = readVaultAddress(intent.fields['vault']);
  return v === null ? null : String(v).toLowerCase() as Hex;
};

/**
 * A refusal of the shared code's, or one that stopped after something was handed over to be sent, in this kind's
 * words. An adoption a removal has outrun is said as the chain never carrying it out.
 */
const stoppedAs = (e: unknown, handed: Handed, notSent: string): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  const stoppedAt = e instanceof StartRoundRefused || e instanceof VaultStartOwed ? e.stoppedAt : undefined;
  if (stoppedAt === START_STOP.adoptionStale) throw new StepRefused(why('outrun'), stoppedAt);
  const says = e instanceof VaultStartOwed ? e.why : said(e);
  throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? notSent : 'may-be-sent', { says }), stoppedAt ?? codeOfError(e));
};

/**
 * One round of a vault's start: `adoption`, a change to the company judged at the higher of its hold and the account's
 * threshold and never carried out once a removal has outrun it, or `first-secret`, a secret run of the vault's (its
 * first secret, or one replacing it) judged at the higher of its hold and the vault's bar, plus each signer removed since
 * its raise, and never approved or carried once a signer has been removed since its raise.
 */
function startKind(reach: StartKindsReach, round: StartRoundKind): ProposalKind {
  const named = (intent: ActIntent): StartRoundNamed => ({ vault: vaultOf(intent)!, round, proposal: intent.fields['proposal']! });
  /*
   * The doors the vault's own start takes, with every send marked as handed over, and the company as a change to it
   * counts it for the vault check, its open runs among it.
   */
  const doorsFor = (ctx: StepContext, r: CompanyReach, handed: Handed): CreateVaultDoors => {
    if (reach.indexerHttp === undefined) throw new StepRefused(why('not-approved', { says: 'This wallet does not know the indexer it reads a vault at, so nothing was approved. Nothing was sent.' }));
    const d = vaultDoorsFor(ctx, r, reach as unknown as CreateVaultReach);
    const marked = <A extends unknown[], R>(f: ((...a: A) => Promise<R>) | undefined) => (f === undefined ? undefined
      : (...a: A): Promise<R> => { handed.over = true; return f(...a); });
    return {
      ...d,
      service: {
        ...d.service, startAccountCall: marked(d.service.startAccountCall), startSecret: marked(d.service.startSecret),
        startCopy: marked(d.service.startCopy),
      },
      handOver: handOverMarked(d.handOver, handed),
      approvers: () => approversHere(r, () => runsOutrunHere(r)),
    };
  };
  /* A round its raiser filed after their own removal was raised is neither approved nor carried out. */
  const leaverChecked = async (ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<void> => {
    try {
      await refuseARunALeaverRaisedHere(governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal)).records!, r.accountId, r.companyKeys, intent.fields['proposal']!);
    } catch (e) {
      if (e instanceof ActionStopped) throw e;
      throw new StepRefused(why('not-approved', { says: said(e) }), codeOfError(e));
    }
  };
  const notWrittenDown = (ctx: StepContext, says: string | null): void => { if (says !== null) ctx.tell({ said: SAID.proposalNotWrittenDown }); };
  const carryOut: CarryOut = async (ctx, r, intent, _round, handed) => {
    await leaverChecked(ctx, r, intent);
    let out: Awaited<ReturnType<typeof carryStartRoundHere>>;
    try {
      out = await carryStartRoundHere(doorsFor(ctx, r, handed), named(intent));
    } catch (e) {
      return stoppedAs(e, handed, 'not-carried');
    }
    notWrittenDown(ctx, out.said);
    return out.state === 'waiting' ? { state: START_STATE.waiting } : undefined;
  };
  const kind: ProposalKind = {
    fields: ['vault'],
    changesTheCompany: round === 'adoption',
    shown: async (intent): Promise<readonly ShownLine[]> => {
      const vault = intent.fields['vault'] ?? '';
      if (round === 'adoption') {
        return [
          { key: 'act.approve-start.shown.adopt', values: { vault }, from: 'page' },
          { key: 'act.approve-start.shown.checks-adopt', from: 'action' },
          { key: 'act.approve-start.shown.approve', from: 'action' },
        ];
      }
      const label = readCompanyLabel(intent.fields['company']);
      const account = readAccountAddress(intent.fields['account']);
      const seated = label === null || account === null ? null
        : await reach.chain().holders(account, label).then((h) => ('key' in h ? null : h.seats.length), () => null);
      const readers = intent.fields['readers'];
      return [
        { key: 'act.approve-start.shown.secret', values: { vault }, from: 'page' },
        seated === null
          ? { key: 'act.approve-start.shown.sealed-to-unread', from: 'action' }
          : { key: 'act.approve-start.shown.sealed-to', values: { seats: seated }, from: 'wallet' },
        ...(readers === undefined || readers === '' ? [] : [{ key: 'act.approve-start.shown.readers', values: { names: readers }, from: 'page' as const }]),
        { key: 'act.approve-start.shown.checks-secret', from: 'action' },
        { key: 'act.approve-start.shown.carry-secret', from: 'action' },
        { key: 'act.approve-start.shown.approve', from: 'action' },
      ];
    },
    check: (intent) => (vaultOf(intent) === null ? why('not-a-vault') : null),
    opened: async (ctx, r, intent) => {
      const handed: Handed = { over: false };
      try {
        const found = await startRoundOpenedHere(doorsFor(ctx, r, handed), named(intent));
        notWrittenDown(ctx, found.said);
        return { id: intent.fields['proposal']!, chainId: found.chainId };
      } catch (e) {
        return stoppedAs(e, handed, 'not-approved');
      }
    },
    needed: round === 'adoption'
      ? (onChain, held) => Math.max(onChain.needed ?? 0, held.approvals)
      : (onChain, held, intent) => oneOffNeeded(onChain, held, vaultOf(intent) ?? ''),
    approve: async (ctx, r, intent, _round, handed) => {
      await leaverChecked(ctx, r, intent);
      let done: Awaited<ReturnType<typeof approveStartRoundHere>>;
      try {
        done = await approveStartRoundHere(doorsFor(ctx, r, handed), named(intent));
      } catch (e) {
        return stoppedAs(e, handed, 'not-approved');
      }
      if (done !== 'approved') throw new ApprovalNotOwed(done === 'counted' ? 'counted' : 'carried-out');
    },
    stateAt: (atItsBar) => (atItsBar ? START_STATE.atItsBar : START_STATE.waiting),
    ...(round === 'adoption' ? {} : {
      /* A run closed by the set of its secret, with sealed copies still owed: they are written, and the run written down. */
      afterClosed: async (ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<string | null> => {
        const handed: Handed = { over: false };
        let out: Awaited<ReturnType<typeof finishedSecretRunHere>>;
        try {
          out = await finishedSecretRunHere(doorsFor(ctx, r, handed), named(intent));
        } catch (e) {
          return stoppedAs(e, handed, 'not-carried');
        }
        if (out === null) return null;
        notWrittenDown(ctx, out.said);
        return out.state;
      },
    }),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.approve-start.step.carry' }, carryOut)],
    why: kindWhy,
  };
  return kind;
}

/** **A NEW VAULT'S ADOPTION**, approved and carried out through the one approval. */
export const adoptVaultKind = (reach: StartKindsReach): ProposalKind => startKind(reach, 'adoption');

/**
 * **A VAULT'S SECRET RUN**, its first or one replacing it, approved and carried out through the one approval: set, and
 * every signer's copy written.
 */
export const vaultSecretKind = (reach: StartKindsReach): ProposalKind => startKind(reach, 'first-secret');
