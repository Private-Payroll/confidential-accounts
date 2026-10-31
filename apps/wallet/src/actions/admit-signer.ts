import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import { SeatKeyNotFromTheInvitee } from '../../../../src/core/seat-invite-proof.js';
import { admitSignerHere, rosterHere, SeatNotReadOnTheChain, WaitingIdTaken } from '../../../../packages/web-shared/src/roster-here.js';
import { FiledNotEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, governanceDoorsFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * FINISHING ADDING A SIGNER WHO TOOK THEIR SEAT BY ADDRESS, IN THE WALLET. The person's own wallet took the seat on the
 * chain and asked to be admitted; this wallet admits them with its own seat: it checks their request against the seat
 * the chain shows their invitation's proposal took, records the coin key of the address they were invited at, files
 * the company's list of signers with them in it and wraps the company's key to the key they gave. Nothing is read out:
 * the chain is the check. The service refuses the admission until the chain holds their seat. A chain that could not be
 * read stops it to be pressed again, never as a seat that is not theirs; an id the service gave them that another entry
 * of the roster carries stops it before anything is signed. Every refusal carries the kind of error that caused it as
 * its code, for the page's report.
 */

/** What the admit action reads the company with: the wallet's own chain and builder, and the account's commitments. */
export interface AdmitSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's commitments, which make an address's commitment from its coin key and a salt. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex }>;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the admission got to, as the action tells the page. */
export const ADMIT_STATE = { admitted: 'admitted', alreadyAdmitted: 'already-admitted' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.admit-signer.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The action that admits, with this wallet's seat, a signer whose own wallet took their seat by address. */
export function admitSignerAction(reach: AdmitSignerReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.admit-signer.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.admit-signer.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.admit-signer.shown.checks', from: 'action' },
      { key: 'act.admit-signer.shown.admit', from: 'action' },
      ...upkeepShown(),
      { key: 'act.admit-signer.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.admit-signer.check.seat' },
      { key: 'act.admit-signer.check.chain' },
      { key: 'act.admit-signer.check.one-seat' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => (['record', 'signer', 'personName'].some((k) => (intent.fields[k] ?? '') === '') ? why('not-a-signer') : null),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.admit-signer.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const admit: ActionStep = {
        title: { key: 'act.admit-signer.step.admit' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const signerId = intent.fields['signer']!;
          const commitments = await reach.commitments();
          const { roster } = governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal));
          try {
            /*
             * Taken up again after the admission was filed: the roster read here enters this seat's own filing again
             * if its entry was lost, and holds them, so nothing is filed twice. Only an entry with the waiting request's
             * own seat counts: the id is the service's, and a seated entry under it with another seat is another
             * signer's, which the admission refuses.
             */
            const here = await rosterHere(roster);
            const waiting = here.opened.signers.find((s) => s.id === signerId && s.status === 'pending');
            if (here.account.signers.some((s) => s.id === signerId && s.status === 'active'
              && (waiting === undefined || (s.leafCommitment ?? '').toLowerCase() === (waiting.leafCommitment ?? '').toLowerCase()))) {
              read.renew();
              ctx.tell({ state: ADMIT_STATE.alreadyAdmitted });
              return;
            }
            await admitSignerHere({ ...roster, commitments }, { signerId, readOut: '', name: intent.fields['personName']! });
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            const code = codeOfError(e);
            if (e instanceof WaitingIdTaken) throw new StepRefused(why('id-taken'), code);
            if (e instanceof SeatNotReadOnTheChain) throw new StepRefused(why('chain-unread'), code);
            if (e instanceof SeatKeyNotFromTheInvitee) throw new StepRefused(why('not-the-invited', { says: said(e) }), code);
            if (e instanceof FiledNotEntered) throw new StepRefused(why('filed-not-entered', { says: said(e) }), code);
            throw new StepRefused(why('not-admitted', { says: said(e) }), code);
          }
          read.renew();
          ctx.tell({ state: ADMIT_STATE.admitted });
        },
      };
      return [upkeep.first, seat, admit, upkeep.last];
    },
  } satisfies ActionDefinition);
}
