import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import type { SeatOpening } from '../../../../src/core/seat-opening.js';
import { isSignerRole } from '../../../../src/core/roles.js';
import type { Role } from '../../../../src/core/types.js';
import { InvitationNotMade, InvitationRefused, SeatMayNotInvite, type InvitationSend, type InvitingCompany } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { addSignerFromCodeHere, CodeNotTaken } from '../../../../packages/web-shared/src/invitation-by-code.js';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { liveLeafReader, type LeafReader } from '../chain/seat-leaf.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { invitingSeatOf } from './invite.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * ADDING A SIGNER FROM THE CODE THEIR OWN WALLET MADE, IN THE WALLET. Somebody already in the company pastes the code a
 * person's wallet signed; this wallet's seat files an invitation for them and their request for a seat, sealed to the
 * company, so the next step is to propose their seat. The code is believed only when its seat is shown to be made for
 * the wallet that signed it and it carries the address that wallet signed to take the seat with, made from its own
 * coin key; a code's seat is made for every right on every vault, so it is added only as an admin. The fingerprint the
 * person reads out is shown in this window only, to compare with theirs; the page is told the request's id, to propose
 * their seat by. Refused before anything is signed when this
 * seat may not invite.
 */

/** What the action reads the company with: the wallet's own chain and builder, and the account's commitments. */
export interface AddSignerByCodeReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** The account's commitments, which make an address's commitment from its coin key and a salt. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex }>;
  /** How a seat's opening is turned into its leaf; the account's own `signerLeaf` unless a test answers. */
  readonly leafOf?: LeafReader;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the action got to, as it tells the page. */
export const ADD_BY_CODE_STATE = { filed: 'filed' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.add-signer-by-code.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

const fieldsRefusal = (fields: Readonly<Record<string, string>>): Words | null => {
  if (['record', 'code', 'personName'].some((k) => (fields[k] ?? '').trim() === '')) return why('not-a-code');
  if (!isSignerRole(fields['role'])) return why('no-role');
  return null;
};

/** The action that files, with this wallet's seat, an invitation and a seat request from a person's own code. */
export function addSignerByCodeAction(reach: AddSignerByCodeReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.add-signer-by-code.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.add-signer-by-code.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.add-signer-by-code.shown.role', values: { role: intent.fields['role'] ?? '' }, from: 'page' },
      { key: 'act.add-signer-by-code.shown.checks', from: 'action' },
      { key: 'act.add-signer-by-code.shown.next', from: 'action' },
      ...upkeepShown(),
      { key: 'act.add-signer-by-code.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.add-signer-by-code.check.seat' },
      { key: 'act.add-signer-by-code.check.code' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => fieldsRefusal(intent.fields),
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.add-signer-by-code.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const add: ActionStep = {
        title: { key: 'act.add-signer-by-code.step.add' },
        run: async (ctx) => {
          const refused = fieldsRefusal(intent.fields);
          if (refused !== null) throw new StepRefused(refused);
          const r = await read.at(ctx);
          const inviting = await invitingSeatOf(ctx, r, (k) => why(k));
          const company: InvitingCompany = withCompanyKeys({
            id: r.accountId, name: (await r.roster()).name, label: r.label, account: r.account, keyEpoch: r.companyKeys.epoch,
          }, r.companyKeys);
          const commitments = await reach.commitments();
          const leafOf = reach.leafOf ?? liveLeafReader;
          const leaves = (openings: readonly SeatOpening[]) => Promise.all(openings.map((o) => leafOf(o).then((l) => l.toLowerCase(), () => {
            /* A leaf not read is no leaf: the code is then refused as not shown to be made for its wallet. */
            return null;
          })));
          const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
          let added: { readonly id: string; readonly fingerprint: string };
          try {
            added = await addSignerFromCodeHere(company, inviting, intent.fields['code']!.trim(), {
              name: intent.fields['personName']!, role: intent.fields['role'] as Role,
            }, send, leaves, (c, salt) => commitments.inviteAddressOf(c, salt));
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof CodeNotTaken) throw new StepRefused(why('not-taken', { says: said(e) }), codeOfError(e));
            if (e instanceof SeatMayNotInvite || e instanceof InvitationNotMade) throw new StepRefused(why('not-made', { says: said(e) }), codeOfError(e));
            if (e instanceof InvitationRefused) throw new StepRefused(why('refused', { says: said(e) }), codeOfError(e));
            throw new StepRefused(why('not-made', { says: said(e) }), codeOfError(e));
          }
          read.renew();
          ctx.tell({ state: ADD_BY_CODE_STATE.filed, signer: added.id });
          ctx.show({ key: 'act.add-signer-by-code.over.fingerprint', values: { name: intent.fields['personName']!, fingerprint: added.fingerprint } });
        },
      };
      return [upkeep.first, seat, add, upkeep.last];
    },
  } satisfies ActionDefinition);
}
