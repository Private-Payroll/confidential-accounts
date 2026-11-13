import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import { openedWithAnyKey } from '../../../../src/core/company-key.js';
import { openFromInbox } from '../../../../src/core/sealed-records.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import { SeatMayNotInvite, refuseASeatThatMayNotInvite } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { InvitationNotBound, nothingWasSentBy } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { seatSignerOnDevice } from '../../../../packages/web-shared/src/signer-by-link.js';
import { FiledNotEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, governanceDoorsFor, keptReach, type CompanyChain, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { invitingSeatOf } from './invite.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * PROPOSING THE SEAT OF A PERSON WHO JOINED BY A LINK OR A CODE, IN THE WALLET. Their request for a seat waits on the
 * company; this wallet's seat raises the proposal to seat their leaf at the address their own wallet signed, which is
 * this seat's approval, once the fingerprint the person read out is the one their request makes. Their seat's rights
 * are the ones their own seat was made with. A request that carries no address their wallet signed is refused before
 * anything is sent, with words to withdraw it: nobody could take that seat. This wallet's seat is named in the proposal
 * as who invited them. The proposal then waits for the approvals the account needs; the person's wallet takes the seat.
 */

/** What the action reads the company with: the wallet's own chain and builder, and the account's commitments. */
export interface RaiseWaitingSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's commitments, which make an address's commitment from its coin key and a salt. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex }>;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.raise-waiting-signer.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The rights the waiting person's own seat was made with, read from their request as the company's key opens it. */
const scopeOfTheRequest = (r: CompanyReach, signerId: string): Hex => {
  const box = r.sealed.pendingSigners.find((p) => p.id === signerId);
  if (box === undefined) throw new StepRefused(why('not-waiting'));
  let payload: PendingSignerPayload;
  try {
    payload = openedWithAnyKey(r.companyKeys, (key) => openFromInbox<PendingSignerPayload>(box.sealed, r.accountId, key));
  } catch (e) {
    throw new StepRefused(why('not-opened', { says: said(e) }), codeOfError(e));
  }
  const scope = payload.opening?.scope;
  if (typeof scope !== 'string' || !/^[0-9a-f]{64}$/u.test(scope.toLowerCase())) throw new StepRefused(why('no-scope'));
  return scope.toLowerCase() as Hex;
};

/** The action that raises, with this wallet's seat, the proposal to seat a person waiting who joined by a link or a code. */
export function raiseWaitingSignerAction(reach: RaiseWaitingSignerReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.raise-waiting-signer.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.raise-waiting-signer.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.raise-waiting-signer.shown.read-out', values: { fingerprint: intent.fields['readOut'] ?? '' }, from: 'page' },
      { key: 'act.raise-waiting-signer.shown.checks', from: 'action' },
      { key: 'act.raise-waiting-signer.shown.raise', from: 'action' },
      ...upkeepShown(),
      { key: 'act.raise-waiting-signer.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.raise-waiting-signer.check.seat' },
      { key: 'act.raise-waiting-signer.check.request' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => (['record', 'signer', 'personName', 'readOut'].some((k) => (intent.fields[k] ?? '').trim() === '') ? why('not-a-signer') : null),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.raise-waiting-signer.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.raise-waiting-signer.step.raise' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const signerId = intent.fields['signer']!;
          const inviting = await invitingSeatOf(ctx, r, (k) => why(k));
          try {
            refuseASeatThatMayNotInvite(inviting);
          } catch (e) {
            throw new StepRefused(why('may-not', { says: said(e) }), codeOfError(e));
          }
          const scope = scopeOfTheRequest(r, signerId);
          const commitments = await reach.commitments();
          const handed: Handed = { over: false };
          const doors = governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed);
          let state: string;
          try {
            ({ state } = await seatSignerOnDevice(doors, {
              companyKeys: r.companyKeys, signerId, readOut: intent.fields['readOut']!.trim(), invite: { scope },
              inviter: { committeeKey: inviting.committeeKey, statement: inviting.statement, opening: inviting.opening },
              inviteAddressOf: (c, salt) => commitments.inviteAddressOf(c, salt),
            }));
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof FiledNotEntered) throw new StepRefused(why('filed-not-entered', { says: said(e) }), codeOfError(e));
            if (!handed.over && (e instanceof InvitationNotBound || e instanceof SeatMayNotInvite)) {
              throw new StepRefused(why('not-raised', { says: said(e) }), codeOfError(e));
            }
            throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-raised' : 'may-be-sent', { says: said(e) }), codeOfError(e));
          }
          read.renew();
          ctx.tell({ state });
        },
      };
      return [upkeep.first, seat, raise, upkeep.last];
    },
  } satisfies ActionDefinition);
}
