/*
 * JOINING A COMPANY AS A PAYEE BY LINK, OR BY THE PRIVATE ADDRESS THE INVITER TYPED, FROM THE PERSON'S OWN WALLET.
 * Everything is read from the offer the inviter signed, which the wallet opens itself with the link's token: the
 * record, the company's inbox key and any address typed. The wallet is paid at a typed address only when it holds it,
 * and otherwise at a private address of its own; it signs its payee's code for that address and its payslip key for
 * the company, lists the company among those that pay the person and keeps the join in the saved keys before anything
 * is handed over, and hands the company only the code, sealed to the inbox key the offer names. Nothing here checks
 * the inviter holds a seat on the company: the person who invited them checks the code by its fingerprint. It refuses an invitation made by a
 * public address, which is claimed with that address's own signature instead. The fingerprint the inviter checks the
 * code by is shown in this wallet's window and is never sent to the page.
 */
import { addressFor } from 'midnight-identity';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { signJoinCode, type JoinCode, type PayeeParts } from 'midnight-identity/profile/join-code';
import { payeeCodeFingerprint } from 'midnight-identity/profile/fingerprint';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import type { JoinCodeRequest } from 'midnight-identity/profile/request';
import { acceptanceProofOf, invitationIdOf, offerExpiredRefusal, openOffer } from '../../../../src/core/invitation.js';
import type { Hex, Sealed } from '../../../../src/core/crypto.js';
import { payeeHandoverOf } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { withPaidBy, withPayeeJoinKept, type PayeeJoinKept } from '../../../../packages/web-shared/src/keyring-blob.js';
import { WALLET_ACCOUNTS } from '../accounts/subwallets.js';
import { payslipKeyOfThisWallet } from '../screens/join-code-payslip-key.js';
import { heldAt } from './claim-by-address.js';
import { StepRefused, type ActionDefinition, type ShownLine, type StepContext, type Words } from './definition.js';

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.join-by-code.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };

/** What the wallet needs beyond the offer: the network its addresses are on. */
export interface JoinReach {
  readonly network: string;
}

const fieldsRefusal = (fields: Readonly<Record<string, string>>): Words | null => {
  if (readCompanyLabel(fields['company']) === null || readAccountAddress(fields['account']) === null) return why('not-a-company');
  if (!/^[0-9a-f]{64}$/u.test(fields['token'] ?? '')) return why('not-an-invitation');
  return null;
};

/** The offer as the inviter signed it, for the company and record the page named: whom it pays, and any address typed. */
interface Opened {
  readonly person: string;
  readonly typed: string | null;
  readonly inbox: Hex;
  readonly payee: 'employee' | 'vendor';
  readonly token: Hex;
}

/*
 * Opens the offer with the link's token and believes nothing the page says about it: an offer that does not open with
 * the token, is not signed by the key the offer carries as sealed, has expired, is for another company or record than the page
 * named, or offers no pay is refused. An invitation already accepted comes back as `'used'`, so a join is handed over
 * once.
 */
async function openedOffer(ctx: StepContext): Promise<Opened | 'used'> {
  const f = ctx.intent.fields;
  const label = readCompanyLabel(f['company']);
  const account = readAccountAddress(f['account']);
  const token = (f['token'] ?? '') as Hex;
  if (label === null || account === null || !/^[0-9a-f]{64}$/u.test(token)) return refuse('not-a-company');
  const got = await ctx.call('GET', `/api/invites/${invitationIdOf(token)}/offer`);
  if (got.status === 410 && (got.body as { refused?: unknown } | null)?.refused === 'used') return 'used';
  const sealed = (got.body as { offer?: Sealed } | null)?.offer;
  if (got.status !== 200 || sealed === undefined) return refuse('no-offer');
  let signed: ReturnType<typeof openOffer>;
  try { signed = openOffer(sealed, token); } catch { return refuse('no-offer'); }
  const o = signed.offer;
  if (offerExpiredRefusal(o, Date.now()) !== null) return refuse('expired');
  if (o.company !== f['record'] || o.label !== label || String(o.account).toLowerCase() !== String(account).toLowerCase()) return refuse('another-company');
  if (o.for.kind !== 'employee' && o.for.kind !== 'vendor') return refuse('not-a-payee');
  const typed = (o.for as { address?: unknown }).address;
  if (typed !== undefined && typed !== null && typeof typed !== 'string') return refuse('no-offer');
  return { person: o.for.person, typed: typeof typed === 'string' ? typed : null, inbox: o.inboxPublicKey as Hex, payee: o.for.kind, token };
}

/*
 * Where this wallet is paid: the private address the inviter typed, for an employee and a vendor alike, only when this
 * wallet holds it; a typed public address is refused here, since it is claimed with its own signature; with no address
 * typed, the address kept when this invitation was joined before, so a join taken up again makes the same code, or
 * else the private address of the account chosen in the window, or of this wallet's first account.
 */
function paidAt(o: Opened, ctx: StepContext, network: string, kept: PayeeJoinKept | undefined): string {
  if (o.typed !== null) {
    if (!typedAddressIsShielded(o.typed)) return refuse('by-public-address');
    if (heldAt(ctx.held.identity, network, o.typed)?.kind !== 'shielded') return refuse('not-held');
    return o.typed;
  }
  if (kept !== undefined && heldAt(ctx.held.identity, network, kept.address)?.kind === 'shielded') return kept.address;
  const account = ctx.held.account ?? WALLET_ACCOUNTS[0]!;
  try {
    return addressFor(ctx.held.identity.moneyAt(account).zswap, network as never).bech32;
  } catch {
    return refuse('no-address');
  }
}

/**
 * **THE JOIN-BY-CODE ACTION**: one step that opens the offer, signs the payee's code, lists the company in the saved
 * keys, hands the sealed code to the invitation and gives the window the fingerprint to read out. It refuses before
 * anything is signed when the page handed no saved keys, since the company could not then be listed, and stops when
 * the company does not take the code, saying the fingerprint in case it took it after all. Taken up again after the
 * code was handed over, the service answers the offer as used, so nothing is handed over twice, the company stays
 * listed, and the fingerprint of the code this wallet kept the join of is shown again to be read out.
 */
export function joinByCodeAction(reach: JoinReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.join-by-code.headline',
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.join-by-code.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
      { key: 'act.join-by-code.shown.address', from: 'action' },
      { key: 'act.join-by-code.shown.code', from: 'action' },
      { key: 'act.join-by-code.shown.fingerprint', from: 'action' },
      { key: 'act.join-by-code.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.join-by-code.check.offer' },
      { key: 'act.join-by-code.check.held' },
      { key: 'act.join-by-code.check.listed' },
    ],
    check: async (intent) => fieldsRefusal(intent.fields),
    steps: () => [{
      title: { key: 'act.join-by-code.step.join' },
      run: async (ctx) => {
        const refused = fieldsRefusal(ctx.intent.fields);
        if (refused !== null) throw new StepRefused(refused);
        const saved = ctx.keyring;
        if (saved === null) return refuse('no-saved-keys');
        const company = readCompanyLabel(ctx.intent.fields['company'])!;
        const invitation = invitationIdOf((ctx.intent.fields['token'] ?? '') as Hex);
        const kept = ((): PayeeJoinKept | undefined => {
          const one = saved.open().read().payeeJoinsKept?.[invitation];
          return one !== undefined && one.company === company ? one : undefined;
        })();
        const payslipKey = (): string => {
          try {
            return payslipKeyOfThisWallet(ctx.held.identity, { company, requester: ctx.asker } as unknown as JoinCodeRequest);
          } catch {
            return refuse('no-payslip-key');
          }
        };
        const o = await openedOffer(ctx);
        if (o === 'used') {
          /* Already accepted: when this wallet kept a join of this invitation, the code it handed over named the kept
           * address, so its fingerprint is worked out again for the person to read out; otherwise none is shown, since
           * the code may not be this wallet's. */
          if (kept === undefined) return refuse('used');
          let again: string;
          try {
            again = payeeCodeFingerprint({ committeeKey: committeeKeyFor(ctx.held.identity, company), parts: { address: kept.address, payslipKey: payslipKey() } });
          } catch {
            return refuse('used');
          }
          return refuse('used-by-this-wallet', { fingerprint: again, address: kept.address });
        }
        const address = paidAt(o, ctx, reach.network, kept);
        const key = payslipKey();
        let code: JoinCode;
        let fingerprint: string;
        try {
          code = signJoinCode(ctx.held.identity, company, o.person, { kind: 'payee', address, payslipKey: key });
          fingerprint = payeeCodeFingerprint(code as JoinCode & { parts: PayeeParts });
        } catch (e) {
          return refuse('not-signed', { says: String((e as Error)?.message ?? e) });
        }
        /* Listed and kept before the hand-over, which an invitation takes once: kept after, a keep that failed would
         * leave the person joined, their wallet not knowing the company pays them, and no fingerprint to show again. */
        const now = saved.open().read();
        if (!(now.paidBy ?? []).includes(company) || now.payeeJoinsKept?.[invitation] === undefined) {
          await saved.keep((k) => withPaidBy(withPayeeJoinKept(k, invitation, { company, address }), company));
        }
        const answer = await ctx.call('POST', `/api/invites/${invitationIdOf(o.token)}/accept-payee`,
          JSON.stringify({ acceptance: acceptanceProofOf(o.token), handover: payeeHandoverOf(code, o.inbox), kind: o.payee }));
        if (answer.status !== 201) {
          const said = (answer.body as { error?: unknown } | null)?.error;
          refuse('not-taken', { says: typeof said === 'string' ? said : `the service answered ${answer.status}`, fingerprint, address });
        }
        ctx.show({ key: 'act.join-by-code.over.fingerprint', values: { fingerprint, address } });
      },
    }],
  } satisfies ActionDefinition);
}
