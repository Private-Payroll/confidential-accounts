/* A PERSON OR VENDOR ADDED BY AN UNSHIELDED ADDRESS CLAIMS THEIR RECORD FROM THIS WALLET. The inviter typed an
 * address; the invitation link only lets this wallet's owner find the company. This action opens the offer the
 * inviter signed itself, with the link's token, and takes the company's inbox key, the record and the address from
 * it; checks the address is one this wallet holds; signs a claim of it with that address's own key and its payee's
 * code for the company; seals both to the inbox key the offer names and hands them to the invitation. The keys
 * never leave the wallet: the page is handed the sealed hand-over and nothing else, and every device that admits or
 * pays the person checks the claim's signature itself. A shielded address has no claim, since no device can check
 * a proof of one: a person added by one accepts with their code and the fingerprint read out. */
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import type { Identity } from 'midnight-identity/keys/derivation';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { CLAIMED_HANDOVER_SCHEMA, typedAddressIsShielded, type AddressClaimFor } from 'midnight-identity/profile/address-claim';
import { signUnshieldedClaim } from 'midnight-identity/profile/address-claim-signed';
import type { JoinCodeRequest } from 'midnight-identity/profile/request';
import { acceptanceProofOf, invitationIdOf, offerExpiredRefusal, openOffer } from '../../../../src/core/invitation.js';
import { sealToInbox } from '../../../../src/core/sealed-records.js';
import type { Hex, Sealed } from '../../../../src/core/crypto.js';
import { addressFor } from 'midnight-identity';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';
import { payslipKeyOfThisWallet } from '../screens/join-code-payslip-key.js';
import { StepRefused, type ActionDefinition, type ShownLine, type StepContext, type Words } from './definition.js';

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.claim-by-address.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };

/** Which of this wallet's accounts holds an address, and as which kind, or null when none does. */
export function heldAt(identity: Identity, network: string, address: string): { readonly account: number; readonly kind: 'shielded' | 'unshielded' } | null {
  for (const account of WALLET_ACCOUNTS) {
    try {
      const money = identity.moneyAt(account);
      if (addressFor(money.zswap, network as never).bech32 === address) return { account, kind: 'shielded' };
      const night = signatureVerifyingKey({ tag: 'schnorr', value: Array.from(money.night, (b) => b.toString(16).padStart(2, '0')).join('') });
      if (addressOfVerifyingKey(night.value, network as never) === address) return { account, kind: 'unshielded' };
    } catch { /* an account this wallet cannot read an address of holds nothing to claim with */ }
  }
  return null;
}

/** What the action needs beyond the wallet: the network the addresses are on. */
export interface ClaimReach {
  readonly network: string;
}

const fieldsRefusal = (fields: Readonly<Record<string, string>>): Words | null => {
  if (readCompanyLabel(fields['company']) === null || readAccountAddress(fields['account']) === null) return why('not-a-company');
  if (!/^[0-9a-f]{64}$/u.test(fields['token'] ?? '')) return why('not-an-invitation');
  if (typedAddressIsShielded(fields['address'] ?? '')) return why('private');
  return null;
};

/** The offer as this wallet opened it with the token: the record it is for, the address typed, and where to seal. */
interface Opened {
  readonly person: string;
  readonly address: string;
  readonly inbox: Hex;
  readonly payee: 'employee' | 'vendor';
  readonly token: Hex;
}

/**
 * Opens the inviter-signed offer with the link's token, and believes it only for the company, record and address
 * the page named: a page cannot have the hand-over sealed to a key the offer does not name, or made for a record
 * the offer is not for.
 */
async function openedOffer(ctx: StepContext): Promise<Opened> {
  const f = ctx.intent.fields;
  const label = readCompanyLabel(f['company']);
  const account = readAccountAddress(f['account']);
  const token = (f['token'] ?? '') as Hex;
  if (label === null || account === null || !/^[0-9a-f]{64}$/u.test(token)) return refuse('not-a-company');
  const got = await ctx.call('GET', `/api/invites/${invitationIdOf(token)}/offer`);
  const sealed = (got.body as { offer?: Sealed } | null)?.offer;
  if (got.status !== 200 || sealed === undefined) return refuse('no-offer');
  let signed: ReturnType<typeof openOffer>;
  try { signed = openOffer(sealed, token); } catch { return refuse('no-offer'); }
  const o = signed.offer;
  if (offerExpiredRefusal(o, Date.now()) !== null) return refuse('expired');
  if (o.company !== f['record'] || o.label !== label || String(o.account).toLowerCase() !== String(account).toLowerCase()) return refuse('another-company');
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') return refuse('not-a-payee');
  const address = (o.for as { address?: unknown }).address;
  if (typeof address !== 'string' || address !== f['address']) return refuse('not-by-address');
  if (typedAddressIsShielded(address)) return refuse('private');
  return { person: o.for.person, address, inbox: o.inboxPublicKey as Hex, payee: o.for.kind, token };
}

/**
 * The claim action. It refuses an address this wallet does not hold, before the passkey and again when it runs, an
 * offer it cannot open or that names another company, record or address than the page did, and a hand-over the
 * invitation does not take; it never signs for an address that is not its own.
 */
export function claimByAddressAction(reach: ClaimReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.claim-by-address.headline',
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.claim-by-address.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
      { key: 'act.claim-by-address.shown.address', values: { address: String(intent.fields['address'] ?? '') }, from: 'page' },
      { key: 'act.claim-by-address.shown.proof', from: 'action' },
      { key: 'act.claim-by-address.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.claim-by-address.check.offer' },
      { key: 'act.claim-by-address.check.held' },
      { key: 'act.claim-by-address.check.signed' },
    ],
    check: async (intent, held) => fieldsRefusal(intent.fields)
      ?? (heldAt(held.identity, reach.network, intent.fields['address'] ?? '')?.kind !== 'unshielded' ? why('not-held') : null),
    steps: () => [{
      title: { key: 'act.claim-by-address.step.claim' },
      run: async (ctx) => {
        const refused = fieldsRefusal(ctx.intent.fields);
        if (refused !== null) throw new StepRefused(refused);
        const o = await openedOffer(ctx);
        const at = heldAt(ctx.held.identity, reach.network, o.address);
        if (at === null || at.kind !== 'unshielded') return refuse('not-held');
        const company = readCompanyLabel(ctx.intent.fields['company'])!;
        let payslipKey: string;
        try {
          payslipKey = payslipKeyOfThisWallet(ctx.held.identity, { company, requester: ctx.asker } as unknown as JoinCodeRequest);
        } catch {
          return refuse('no-payslip-key');
        }
        const claimFor: AddressClaimFor = { company, person: o.person, payslipKey, address: o.address, network: reach.network };
        let code: ReturnType<typeof signJoinCode>;
        let claim: ReturnType<typeof signUnshieldedClaim>;
        try {
          code = signJoinCode(ctx.held.identity, company, o.person, { kind: 'payee', address: o.address, payslipKey });
          claim = signUnshieldedClaim(ctx.held.identity, at.account, claimFor);
        } catch (e) {
          return refuse('not-signed', { says: String((e as Error)?.message ?? e) });
        }
        const handover = sealToInbox({ schema: CLAIMED_HANDOVER_SCHEMA, code, claim }, o.inbox);
        const answer = await ctx.call('POST', `/api/invites/${invitationIdOf(o.token)}/accept-payee`,
          JSON.stringify({ acceptance: acceptanceProofOf(o.token), handover, kind: o.payee }));
        if (answer.status !== 201) {
          const said = (answer.body as { error?: unknown } | null)?.error;
          refuse('not-taken', { says: typeof said === 'string' ? said : `the service answered ${answer.status}` });
        }
      },
    }],
  } satisfies ActionDefinition);
}
