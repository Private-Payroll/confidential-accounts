import type { ActIntent } from 'midnight-identity/profile/request';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { invitationIdOf, offerExpiredRefusal, openOffer } from '../../../../src/core/invitation.js';
import type { Hex, Sealed } from '../../../../src/core/crypto.js';
import { takeTheReissueHere, type InvitationSend } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { withReissuedInvitationKept } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { proposalsAndSeatsOf } from './proposals-and-seats-read.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';

/*
 * TAKING A RE-ISSUED INVITATION, IN THE WALLET OF THE PERSON IT IS FOR. The chain already seats them; a signer whose seat
 * the account holds signed their invitation again because the one who invited them left. This wallet keeps the new
 * invitation and the seat that signed it as who invited them, in place of what it kept, so it keeps the company's account
 * on a seat the account holds and the entry it files carries an invitation that seat signed. It is taken only for the
 * person signed in, for the seat these saved keys hold on that company, and only when it is the very invitation the
 * proposal that seated them carries, signed again with every term unchanged, by a seat the chain holds now. Nothing is
 * sent.
 */

/** What taking a re-issue reads the company with: the wallet's own chain and builder. */
export interface TakeReissueReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where taking the re-issue got to, as the action tells the page. */
export const TAKE_REISSUE_STATE = { kept: 'kept' } as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.take-reissue.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };
const said = (e: unknown): string => String((e as Error)?.message ?? e);

const fieldsRefusal = (fields: Readonly<Record<string, string>>): Words | null => {
  if ((fields['record'] ?? '') === '' || readCompanyLabel(fields['company']) === null || readAccountAddress(fields['account']) === null) return why('not-a-company');
  if (!HEX64.test(fields['token'] ?? '')) return why('not-an-invitation');
  return null;
};

/** The re-issued offer under the link's token, opened here and held to the company the page named and this wallet reads. */
async function reissueOpened(ctx: StepContext, r: CompanyReach): Promise<Parameters<typeof takeTheReissueHere>[0]> {
  const token = ctx.intent.fields['token']! as Hex;
  const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
  const got = await send(`/api/invites/${invitationIdOf(token)}/offer`, { method: 'GET' });
  const sealed = (got.body as { offer?: Sealed } | null)?.offer;
  if (got.status === 410) return refuse('closed');
  if (got.status !== 200 || sealed === undefined) return refuse('no-offer');
  let signed: ReturnType<typeof openOffer>;
  try { signed = openOffer(sealed, token); } catch { return refuse('no-offer'); }
  const o = signed.offer;
  if (offerExpiredRefusal(o, Date.now()) !== null) return refuse('expired');
  if (o.company !== r.accountId || o.label !== r.label || String(o.account).toLowerCase() !== String(r.account).toLowerCase()) return refuse('another-company');
  if (o.for.kind !== 'reissue') return refuse('not-a-reissue');
  return { token, signed, expiresAt: new Date(o.expiresAt).toISOString(), kind: 'signer' };
}

/** The action that keeps, in this wallet, an invitation re-issued for the seat it holds. */
export function takeReissueAction(reach: TakeReissueReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.take-reissue.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.take-reissue.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
      { key: 'act.take-reissue.shown.same', from: 'action' },
      { key: 'act.take-reissue.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.take-reissue.check.person' },
      { key: 'act.take-reissue.check.same' },
    ],
    check: async (intent) => fieldsRefusal(intent.fields),
    steps: () => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.take-reissue.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const take: ActionStep = {
        title: { key: 'act.take-reissue.step.take' },
        run: async (ctx) => {
          const refused = fieldsRefusal(ctx.intent.fields);
          if (refused !== null) throw new StepRefused(refused);
          const keyring = ctx.keyring ?? refuse('no-saved-keys');
          const person = ctx.person ?? refuse('no-person');
          const r = await read.at(ctx);
          const opened = await reissueOpened(ctx, r);
          const { proposals, onTheChain } = await proposalsAndSeatsOf(r, why);
          try {
            await takeTheReissueHere(opened, { accountId: r.accountId, person, seat: r.leaf, companyKeys: r.companyKeys }, proposals, onTheChain,
              async (reissued) => { await keyring.keep((k) => withReissuedInvitationKept(k, r.accountId, reissued)); });
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            throw new StepRefused(why('not-kept', { says: said(e) }), codeOfError(e));
          }
          read.renew();
          ctx.tell({ state: TAKE_REISSUE_STATE.kept });
        },
      };
      return [seat, take];
    },
  } satisfies ActionDefinition);
}
