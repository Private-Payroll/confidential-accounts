import type { ActIntent } from 'midnight-identity/profile/request';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { NETWORK } from 'midnight-identity/network';
import { assets as theAssets, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { fromHex, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import { EMPLOYEE_CLASSIFICATIONS, invitationIdOf, type EmployeeClassification } from '../../../../src/core/invitation.js';
import type { Role } from '../../../../src/core/types.js';
import type { VendorTerms } from '../../../../src/core/vendor-record.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import {
  filedRecordEnteredHere, firstAskRefusal, INVITATION_UNDER_THIS_LINK_CLOSED, InvitationNotMade, InvitationRaisedNotFiled, InvitationRefused, inviteHere, SeatMayNotInvite,
  openTheFiledOffer, type InvitationSend, type InviteOptions, type InviteSpecs, type InvitingCompany, type InvitingSeat, type KeptSeatInvitation,
} from '../../../../packages/web-shared/src/invitation-on-device.js';
import { InvitationNotBound, nothingWasSentBy, signerByAddressDoorsOf, withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { withSeatInvitationKept } from '../../../../packages/web-shared/src/keyring-blob.js';
import { FiledNotEntered, manifestServiceFor } from '../../../../packages/web-shared/src/record-entered-here.js';
import { seatHereIn } from '../../../../packages/web-shared/src/vault-operation.js';
import { readVendorsWithKeys } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { signedClaimRefusal } from '../../../../packages/web-shared/src/signed-claim-refusal.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import type { Identity } from 'midnight-identity/keys/derivation';
import { addressFor } from 'midnight-identity';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';
import { companyReachFor, enteredFor, governanceDoorsFor, keptReach, type CompanyChain, type CompanyReach, type Handed } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * INVITING SOMEBODY TO THE COMPANY, IN THE WALLET. The page names the company, the kind of invitation, the person's
 * details in its own words and the token for the link it will send; the wallet reads the company and its own seat
 * from its own reach, seals and signs the invitation, the offer and the first record with that seat, and files them.
 * A signer is invited only by a private address: the wallet refuses an address it holds itself, a wallet already
 * seated or invited here, and rights wider than its own seat's, keeps the invitation in the saved keys, and only then
 * raises the proposal to seat the address with this seat's approval. A press again under a token already used goes on
 * only with the kind and details of the first press under it, kept or filed, and is otherwise refused before anything
 * is signed; a record the first press filed and did not enter is entered then, signed by this seat. Nothing secret comes back to the page: it makes the link from its own token.
 */

/** What the invite action reads the company with: the wallet's own chain and builder, its clock and its waits. */
export interface InviteReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly now: () => number;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's commitments, which make an address's commitment and the rights of every vault. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex; allVaults(): Hex }>;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  readonly network?: NetworkName;
  readonly assets?: AssetRegistry;
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** Where the invitation got to, as the action tells the page. */
export const INVITE_STATE = { kept: 'kept', filed: 'filed', alreadyFiled: 'already-filed', raisedNotFiled: 'raised-not-filed' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.invite.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const HEX64 = /^[0-9a-f]{64}$/u;
const ROLES: readonly Role[] = ['admin', 'approver', 'initiator', 'viewer'];

type Asked =
  | { readonly kind: 'employee'; readonly spec: InviteSpecs['employee'] }
  | { readonly kind: 'vendor'; readonly spec: InviteSpecs['vendor'] }
  | { readonly kind: 'signer'; readonly spec: InviteSpecs['signer'] & { readonly address: string } };

/**
 * The invitation the page asked for, read field by field, or why it is not one: a kind this wallet invites, and the
 * fields that kind needs. A signer is invited only by a private address, so one without an address is refused. The
 * dates, the address and the terms are checked again where the invitation is made.
 */
function askedOf(intent: ActIntent, network: NetworkName, registry: AssetRegistry): Asked | Words {
  const f = intent.fields;
  const name = f['personName'] ?? '';
  if (name.trim() === '') return why('no-name');
  const opt = (k: string): string | undefined => (f[k] === undefined || f[k] === '' ? undefined : f[k]);
  const email = opt('email') ?? null;
  switch (f['kind']) {
    case 'employee': {
      const asset = f['asset'];
      if (asset === undefined || !HEX64.test(asset) || registry.find(asset as AssetId) === null) return why('not-an-asset');
      if (f['amount'] === undefined || BigInt(f['amount']) <= 0n) return why('no-pay');
      const classification = f['classification'] as EmployeeClassification | undefined;
      if (classification === undefined || !EMPLOYEE_CLASSIFICATIONS.includes(classification)) return why('no-classification');
      if (opt('startDate') === undefined) return why('no-start');
      return {
        kind: 'employee',
        spec: {
          name, email, title: f['title'] ?? '', asset: asset as AssetId, baseAmount: BigInt(f['amount']), startDate: f['startDate']!, classification,
          ...(opt('endDate') === undefined ? {} : { endDate: opt('endDate')! }), ...(opt('address') === undefined ? {} : { address: opt('address')! }),
        },
      };
    }
    case 'vendor': {
      let terms: VendorTerms;
      if (f['terms'] === 'one-off') terms = { kind: 'one-off' };
      else if (f['terms'] === 'monthly') {
        const asset = f['termsAsset'];
        if (asset === undefined || !HEX64.test(asset) || registry.find(asset as AssetId) === null) return why('not-an-asset');
        if (f['termsAmount'] === undefined || BigInt(f['termsAmount']) <= 0n) return why('no-pay');
        terms = { kind: 'monthly', asset: asset as AssetId, amount: BigInt(f['termsAmount']) };
      } else return why('no-terms');
      if (opt('startDate') === undefined) return why('no-start');
      return {
        kind: 'vendor',
        spec: {
          name, email, startDate: f['startDate']!, terms, network,
          ...(opt('endDate') === undefined ? {} : { endDate: opt('endDate')! }), ...(opt('address') === undefined ? {} : { address: opt('address')! }),
        },
      };
    }
    case 'signer': {
      const role = f['role'] as Role | undefined;
      if (role === undefined || !ROLES.includes(role)) return why('no-role');
      const address = opt('address');
      if (address === undefined) return why('signer-by-address');
      return {
        kind: 'signer',
        spec: { name, role, person: 'by-address', address: address.trim(), ...(opt('scope') === undefined ? {} : { scope: f['scope']!.toLowerCase() as Hex }) },
      };
    }
    case 'super-admin': return why('super-admin');
    default: return why('not-a-kind');
  }
}

/**
 * This wallet's seat as the invitation is made with it: its signing key, the records it files entered under that key,
 * its role and whether it is retired as the company's directory shows them here, and the inviter record the
 * invitee's wallet checks the seat by (this wallet's committee key, an entry it signs now for the seat it holds, and
 * the seat's opening). Refuses a seat whose saved keys keep no opening: its inviter record could not be checked.
 */
async function invitingSeatOf(ctx: StepContext, r: CompanyReach): Promise<InvitingSeat> {
  if (r.seat.opening === undefined) throw new StepRefused(why('no-opening'));
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const held = await seatHereIn(directory, r.seat.signingSecret);
  const signingKey = signingPublicKeyOf(r.seat.signingSecret).toLowerCase();
  return {
    signingSecret: r.seat.signingSecret,
    entered: enteredFor(r),
    ...(held === null ? {} : { held: { role: held.role, retired: held.retired !== null && held.retired !== undefined } }),
    committeeKey: committeeKeyFor(ctx.held.identity, r.label) as { tag: string; value: string },
    statement: signDirectoryEntry(ctx.held.identity, r.label, r.account, fromHex(r.companyKey), signingKey, r.leaf),
    opening: r.seat.opening,
  };
}

/** The action that invites an employee, a vendor or a signer from this wallet's seat on the company. */
export function inviteAction(reach: InviteReach): ActionDefinition {
  const network = reach.network ?? (NETWORK as NetworkName);
  const registry = reach.assets ?? theAssets;
  return Object.freeze({
    headline: 'act.invite.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const f = intent.fields;
      const page = (key: string, values: Readonly<Record<string, string>>): ShownLine => ({ key: `act.invite.shown.${key}`, values, from: 'page' });
      const kind = f['kind'] ?? '';
      const details: ShownLine[] = [
        page('kind', { kind }),
        page('name', { name: f['personName'] ?? '' }),
        ...(['email', 'title', 'startDate', 'endDate', 'classification', 'address', 'role', 'terms'] as const)
          .filter((k) => f[k] !== undefined && f[k] !== '')
          .map((k) => page(k, { [k]: f[k]! })),
        ...(f['amount'] === undefined ? [] : [page('amount', { amount: f['amount'], asset: f['asset'] ?? '' })]),
        ...(f['termsAmount'] === undefined ? [] : [page('terms-amount', { amount: f['termsAmount'], asset: f['termsAsset'] ?? '' })]),
      ];
      const signer: ShownLine[] = kind !== 'signer' ? [] : [
        f['scope'] === undefined ? { key: 'act.invite.shown.every-vault', from: 'action' } : page('scope', { scope: f['scope'] }),
        { key: 'act.invite.shown.signer-checks', from: 'action' },
        { key: 'act.invite.shown.kept', from: 'action' },
        { key: 'act.invite.shown.raise', from: 'action' },
      ];
      return [
        ...details,
        ...signer,
        { key: 'act.invite.shown.sealed', from: 'action' },
        ...upkeepShown(),
        { key: 'act.invite.shown.nothing-else', from: 'action' },
      ];
    },
    checks: [
      { key: 'act.invite.check.seat' },
      { key: 'act.invite.check.sealed' },
      { key: 'act.invite.check.signer' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      if (!HEX64.test(intent.fields['token'] ?? '')) return why('not-a-token');
      const asked = askedOf(intent, network, registry);
      return 'key' in asked ? asked : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.invite.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const invite: ActionStep = {
        title: { key: 'act.invite.step.invite' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const asked = askedOf(intent, network, registry);
          if ('key' in asked) throw new StepRefused(asked);
          if (ctx.keyring === null) throw new StepRefused(why('no-saved-keys'));
          const token = intent.fields['token']!.toLowerCase() as Hex;
          const id = invitationIdOf(token);
          const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
          const vendors = () => readVendorsWithKeys({ id: r.accountId, label: r.label }, r.companyKeys, {
            send: r.send, directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster), network, claimRefusal: signedClaimRefusal,
          });
          /*
           * A press again under a token already used goes on only with the first press's ask, judged before anything
           * is signed: against the seat offer kept in the saved keys for its id, and against the offer filed under it,
           * whose employee's or vendor's record is entered before the press is told done.
           */
          const all = (await reach.commitments()).allVaults().toLowerCase() as Hex;
          const notTheFirstAsk = (no: string): StepRefused => new StepRefused(why('not-made', { says: said(new InvitationNotMade(no)) }));
          const notEntered = (e: FiledNotEntered): StepRefused => new StepRefused(why('filed-not-entered', { says: e.why }));
          const kept = ctx.keyring.open().read().seatInvitationsKept?.[id];
          if (kept !== undefined) {
            const no = firstAskRefusal(kept.offer.offer.for, asked.kind, asked.spec as never, all);
            if (no !== null) throw notTheFirstAsk(no);
          }
          const filedAlready = await send(`/api/invites/${id}/offer`, { method: 'GET' });
          if (filedAlready.status === 200) {
            const opened = openTheFiledOffer((filedAlready.body as { offer?: unknown } | null)?.offer, token, r.accountId, asked.kind, asked.spec as never, all,
              kept === undefined ? {} : { kept });
            if ('refused' in opened) throw notTheFirstAsk(opened.refused);
            /* An employee's or a vendor's record filed with it is entered now if the first press did not keep its entry. */
            if (asked.kind !== 'signer') {
              let no: string | null;
              try {
                no = await filedRecordEnteredHere(withCompanyKeys({ id: r.accountId }, r.companyKeys), asked.kind, opened.filed, asked.spec as never,
                  { signingSecret: r.seat.signingSecret, entered: enteredFor(r) },
                  { send, newest: (names) => manifestServiceFor(r.api).newest(r.accountId, names) });
              } catch (e) {
                if (e instanceof FiledNotEntered) throw notEntered(e);
                throw e;
              }
              if (no !== null) throw notTheFirstAsk(no);
            }
            ctx.tell({ state: INVITE_STATE.alreadyFiled });
            return;
          }
          if (filedAlready.status === 410) throw notTheFirstAsk(INVITATION_UNDER_THIS_LINK_CLOSED);
          if (filedAlready.status !== 404) throw new StepRefused(why('offer-not-read', { status: filedAlready.status }));
          const company: InvitingCompany = withCompanyKeys({
            id: r.accountId, name: (await r.roster()).name, label: r.label, account: r.account, keyEpoch: r.companyKeys.epoch,
          }, r.companyKeys);
          const inviting = await invitingSeatOf(ctx, r);
          const handed: Handed = { over: false };
          try {
            if (asked.kind === 'employee') {
              await inviteHere(company, inviting, 'employee', asked.spec, ctx.asker.origin, send, undefined, { token });
            } else if (asked.kind === 'vendor') {
              await inviteHere(company, inviting, 'vendor', asked.spec, ctx.asker.origin, send, { vendors }, { token });
            } else {
              await inviteASigner(ctx, r, reach, company, inviting, asked.spec, token, send, handed);
            }
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof FiledNotEntered) throw notEntered(e);
            if (e instanceof InvitationRaisedNotFiled) {
              ctx.tell({ state: INVITE_STATE.raisedNotFiled });
              throw new StepRefused(why('raised-not-filed', { says: said(e) }));
            }
            if (e instanceof InvitationNotMade || e instanceof SeatMayNotInvite || e instanceof InvitationNotBound) {
              throw new StepRefused(why(handed.over ? 'may-be-sent' : 'not-made', { says: said(e) }));
            }
            if (e instanceof InvitationRefused) throw new StepRefused(why('not-filed', { says: said(e) }));
            throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-made' : 'may-be-sent', { says: said(e) }));
          }
          ctx.tell({ state: INVITE_STATE.filed });
        },
      };
      return [upkeep.first, seat, invite, upkeep.last];
    },
  } satisfies ActionDefinition);
}

/*
 * Whether the private address typed carries a coin key one of this wallet's own private addresses carries. The seat
 * goes to whoever holds the coin key, whatever encryption key the address is written with, so the coin key is what is
 * compared, never the whole address. An address that is not a private one on this network is refused where the
 * invitation is made.
 */
const holdsTheCoinKeyOf = (identity: Identity, network: NetworkName, address: string): boolean => {
  let typed: string;
  try {
    typed = String(checkShieldedAddress(address.trim(), network as never).coinPublicKey).toLowerCase();
  } catch {
    return false;
  }
  return WALLET_ACCOUNTS.some((account) => {
    try {
      const own = addressFor(identity.moneyAt(account).zswap, network as never).bech32;
      return String(checkShieldedAddress(own, network as never).coinPublicKey).toLowerCase() === typed;
    } catch {
      return false;
    }
  });
};

/**
 * A signer invited by the private address the page typed, from this wallet's seat: refused when the address carries
 * a coin key this wallet holds itself, or when the rights offered are wider than this seat's own (a seat with the rights of every
 * vault may offer any; any other may offer only its own). The invitation is kept in the saved keys before the
 * proposal is raised, and one kept by an earlier attempt for this token is taken up again instead of made anew (the
 * step has already refused one kept for another ask).
 */
async function inviteASigner(
  ctx: StepContext, r: CompanyReach, reach: InviteReach, company: InvitingCompany, inviting: InvitingSeat,
  spec: InviteSpecs['signer'] & { readonly address: string }, token: Hex, send: InvitationSend, handed: Handed,
): Promise<void> {
  const network = reach.network ?? (NETWORK as NetworkName);
  if (holdsTheCoinKeyOf(ctx.held.identity, network, spec.address)) throw new StepRefused(why('own-address'));
  const commitments = await reach.commitments();
  const all = commitments.allVaults().toLowerCase();
  const own = String(r.seat.scope).toLowerCase();
  const offered = (spec.scope ?? all).toLowerCase();
  if (offered !== own && own !== all) throw new StepRefused(why('wider-scope'));
  const keep = async (kept: KeptSeatInvitation): Promise<void> => {
    if (ctx.keyring === null) throw new StepRefused(why('no-saved-keys'));
    await ctx.keyring.keep((k) => withSeatInvitationKept(k, kept, reach.now()));
    ctx.tell({ state: INVITE_STATE.kept });
  };
  const doors = governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  });
  const resume = ctx.keyring?.open().read().seatInvitationsKept?.[invitationIdOf(token)];
  const opts: InviteOptions = { token, ...(resume === undefined ? {} : { resume }) };
  await inviteHere(company, inviting, 'signer', spec, ctx.asker.origin, send, signerByAddressDoorsOf(doors, r.companyKeys, network, commitments, keep), opts);
}
