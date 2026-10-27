/**
 * A signer invited by address, followed from the inviting device to the chain, the roster and the directory. Ada's
 * device types Dee's private address and raises the proposal to seat it before anybody accepts; the invitation it
 * signs names the commitment to the address, the seat's rights and the proposal. Bo's device approves it from the
 * offer alone. Dee's own wallet takes the seat on the chain with a seat of its own, proving the address there, and
 * asks to be admitted with nothing read out; Bo's device admits her, checking the seat is the one the account's
 * history shows that proposal took. Her own entry is then believed by every device at the invitation's role, and an
 * entry naming another seat under the same invitation is believed by none.
 */
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { addressFor, identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { acceptanceProofOf, invitationIdOf, signSeatInvitation, tokenOfLink, type SignerOffer } from '../core/invitation.js';
import { sealToInbox } from '../core/sealed-records.js';
import { proveSeatKeys } from '../core/seat-invite-proof.js';
import { seatBlinding } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import type { PendingSignerPayload } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { theNetwork } from '../midnight/network.js';
import { InvitationRaisedNotFiled, inviteHere, openInvitationHere, type KeptSeatInvitation } from 'vaults-web-shared/invitation-on-device.js';
import { governOnDevice, raiseSeatInvitationOnDevice, signerByAddressDoorsOf, type SeatInvitationToRaise } from 'vaults-web-shared/governed-call-on-device.js';
import { fileTheOwedDirectoryEntry, type OwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { admitSignerHere, rosterHere } from 'vaults-web-shared/roster-here.js';
import { ACME, ORIGIN, fromAda, seatsTakenByInvitation } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, ADDRESS, api, BO, CO, committeeKeyOfLeaf, companyNow, deviceOf, directoryOf, events, KEY, LABEL,
  rosterDoorsOf, seatsOnTheChain, sendAs, theInviteeTakesTheSeatHere, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

const NETWORK = theNetwork();
const DEES_WALLET = identityFromSecret(new Uint8Array(32).fill(4));
const DEES_KEY = committeeKeyFor(DEES_WALLET, LABEL) as { tag: string; value: string };
const DEES_ADDRESS = addressFor(DEES_WALLET.moneyAt(0).zswap, NETWORK as never).bech32;
const DEES_COMPANY_KEY = new Uint8Array(32).fill(104);
const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });
const activeIn = async (s: Seat): Promise<string[]> =>
  (await rosterHere(rosterDoorsOf(s))).account.signers.filter((x) => x.status === 'active').map((x) => x.name);

/** Dee's wallet's own seat for the company: seat `n` of its seats, with the rights the invitation gives. */
const deesSeat = (n: number, scope: Hex) => {
  const keys = seatKeysFor(DEES_WALLET, LABEL, n);
  const signingSecret = toHex(keys.signingSecret) as Hex;
  const salt = toHex(keys.salt) as Hex;
  const walletKey = { tag: 'schnorr' as const, value: DEES_KEY.value.toLowerCase() };
  const blinding = seatBlinding(walletKey, salt) as Hex;
  const leaf = storedSignerLeaf({ signingSecret, blinding, scope }, MidnightCommitments).toLowerCase();
  return {
    signingSecret, leaf, wrappingPublicKey: toHex(x25519.getPublicKey(keys.wrappingSecret)) as Hex,
    signingPublicKey: signingPublicKeyOf(signingSecret).toLowerCase() as Hex,
    opening: { publicKey: MidnightCommitments.signerPublicKey(signingSecret).toLowerCase(), scope, blinding, walletKey, salt },
  };
};

describe('A SIGNER INVITED BY ADDRESS IS SEATED BY THEIR OWN WALLET, AND BELIEVED BY EVERY DEVICE', () => {
  it('Ada raises Dee\'s seat by her address before anybody accepts, Bo approves from the offer, Dee\'s wallet takes it, and every device believes her', async () => {
    const kept: KeptSeatInvitation[] = [];
    const keep = async (k: KeptSeatInvitation) => { expect(events).toEqual([]); kept.push(k); };
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'dee', role: 'approver', person: 'unused', address: DEES_ADDRESS }, ORIGIN, fromAda,
      signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, keep));
    /* RED WHEN: the proposal waits for an acceptance, or is not the one the invitation names, under the salt the offer carries. */
    expect(events).toEqual(['chain propose']);
    /* RED WHEN: what the invitee's wallet takes the seat with exists only at the service: Ada's device keeps the token and
     * the offer it signed, with the address, the salts and the rights, before anything is raised. */
    expect(kept).toHaveLength(1);
    expect(kept[0]!.link).toBe(made.link);
    expect(kept[0]!.token).toBe(tokenOfLink(made.link));
    expect(kept[0]!.offer).toEqual((await openInvitationHere(made.link, sendAs(null))).signed);
    const opened = await openInvitationHere(made.link, sendAs(null));
    const offer = opened.signed.offer.for as SignerOffer;
    const terms = offer.invited.terms;
    expect(offer.byAddress?.address).toBe(DEES_ADDRESS);
    expect(terms.leaf).toBeUndefined();
    const coinKey = String(checkShieldedAddress(DEES_ADDRESS, NETWORK as never).coinPublicKey).toLowerCase();
    expect(terms.invite!.address).toBe(MidnightCommitments.inviteAddressOf(coinKey as Hex, terms.invite!.salt).toLowerCase());
    /* Bo's device approves it from the offer alone, which reaches the seat bar; nobody's device carries it out. */
    const bosRaise: SeatInvitationToRaise = { invited: offer.invited, proposalSalt: offer.byAddress!.proposalSalt, name: 'dee' };
    const bo = await raiseSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, ...bosRaise });
    expect(bo.state).toBe('waiting-for-the-invitee');
    /* RED WHEN: an invitation's proposal salt is not the one the raise was made under. */
    await expect(raiseSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, invited: offer.invited, proposalSalt: '00'.repeat(32), name: 'dee' }))
      .rejects.toThrow(/not the one its address, rights and salt make/u);

    /* Dee's wallet takes the seat: its own seat 0, which the account does not hold. The chain checks the address. */
    const dee = deesSeat(0, terms.invite!.scope as Hex);
    committeeKeyOfLeaf.set(dee.leaf, DEES_KEY as never);
    theInviteeTakesTheSeatHere(terms.proposal!, terms.invite!.address, dee.leaf);
    expect(seatsOnTheChain()).toContain(dee.leaf);
    expect(seatsTakenByInvitation.get(terms.proposal!.toLowerCase())).toBe(dee.leaf);

    /* Dee's wallet asks to be admitted with her seat's public halves: nothing is read out. */
    const token = tokenOfLink(made.link)!;
    const published = { signingPublicKey: dee.signingPublicKey, wrappingPublicKey: dee.wrappingPublicKey, leafCommitment: dee.leaf as Hex };
    const waiting = (leaf: Hex = dee.leaf as Hex): PendingSignerPayload => ({
      name: 'dee', role: 'approver', ...published, leafCommitment: leaf, opening: dee.opening as never, person: 'dee', invited: offer.invited,
      seatProof: proveSeatKeys({ accountId: CO, nonce: offer.seat.nonce, secret: offer.seat.secret }, { ...published, leafCommitment: leaf }),
    } as PendingSignerPayload);
    const asked = await sendAs('dee')(`/api/invites/${invitationIdOf(token)}/accept-signer`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox(waiting(), opened.signed.offer.inboxPublicKey) }),
    });
    expect(asked.status).toBe(201);
    const signerId = (asked.body as { id: string }).id;
    /* RED WHEN: a device admits a request whose seat is not the one the history shows this invitation's proposal took. */
    const proposalId = terms.proposal!.toLowerCase();
    seatsTakenByInvitation.set(proposalId, '5a'.repeat(32));
    await expect(admitSignerHere(rosterDoorsOf(BO), { signerId, readOut: '' })).rejects.toThrow();
    seatsTakenByInvitation.set(proposalId, dee.leaf);
    await admitSignerHere(rosterDoorsOf(BO), { signerId, readOut: '' });
    /* RED WHEN: the person seated by their own wallet is not admitted to the roster with the seat the chain shows. */
    expect(companyNow().signers.find((x) => x.name === 'dee')).toMatchObject({ status: 'active', leafCommitment: dee.leaf });

    const statement = signDirectoryEntry(DEES_WALLET, LABEL, ADDRESS, DEES_COMPANY_KEY, dee.signingPublicKey, dee.leaf);

    /* Dee's own device files her entry with the invitation her wallet kept. */
    let owed: OwedDirectoryEntry | null = { person: 'dee', company: LABEL, signed: { committeeKey: DEES_KEY as never, entry: statement }, opening: dee.opening as never, invited: offer.invited };
    const filed = await fileTheOwedDirectoryEntry(api('dee'), CO, { read: () => owed, settle: async () => { owed = null; } },
      async () => ({ signingSecret: dee.signingSecret, viewingKey: KEY }), async () => ADA.seat);
    expect(filed).toBe('filed');
    for (const s of [ADA, BO]) {
      const here = await directoryOf(s)();
      /* RED WHEN: a seat taken by address is not believed at its invitation's role. */
      expect(here.dir.seats.find((x) => x.seat === dee.leaf), s.person).toMatchObject({ person: 'dee', role: 'approver', retired: null });
    }
    expect(await activeIn(BO)).toContain('dee');
  }, 170_000);

  it('RED WHEN: a device believes a seat taken by address that the history does not show the invitation took, or cannot read', async () => {
    const before = new Map(seatsTakenByInvitation);
    try {
      /* The history shows the invitation's proposal took another seat. */
      for (const k of before.keys()) seatsTakenByInvitation.set(k, '5a'.repeat(32));
      expect((await directoryOf(ADA)()).dir.seats.some((x) => x.person === 'dee')).toBe(false);
      /* The history cannot be read. */
      seatsTakenByInvitation.clear();
      expect((await directoryOf(ADA)()).dir.seats.some((x) => x.person === 'dee')).toBe(false);
    } finally {
      for (const [k, v] of before) seatsTakenByInvitation.set(k, v);
    }
    /* With the history read, she is believed again. */
    expect((await directoryOf(ADA)()).dir.seats.some((x) => x.person === 'dee')).toBe(true);
  });

  it('RED WHEN: an invitation raised and not filed leaves its link only at the service: the raising device keeps it and hands it back', async () => {
    const kept: KeptSeatInvitation[] = [];
    const down: typeof fromAda = async (path, init) => (path.endsWith('/invites') && init?.method === 'POST'
      ? { status: 503, body: { error: 'the service is down' } } : fromAda(path, init));
    const another = addressFor(identityFromSecret(new Uint8Array(32).fill(47)).moneyAt(0).zswap, NETWORK as never).bech32;
    const refused = await inviteHere(ACME, ADA, 'signer', { name: 'fay', role: 'approver', person: 'unused', address: another }, ORIGIN, down,
      signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); })).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvitationRaisedNotFiled);
    expect(kept).toHaveLength(1);
    expect((refused as InvitationRaisedNotFiled).link).toBe(kept[0]!.link);
    expect(tokenOfLink(kept[0]!.link)).toBe(kept[0]!.token);
  });

  it('RED WHEN: a device acts on a seat by address whose invitation names another proposal than the one it opens', async () => {
    const at = MidnightCommitments.inviteAddressOf('6c'.repeat(32) as Hex, '6d'.repeat(32) as Hex).toLowerCase() as Hex;
    const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
    const forged = signSeatInvitation({
      company: CO, invitation: '6e'.repeat(32) as Hex, person: 'adr_00000000000000000001', name: 'eve', role: 'approver',
      invite: { address: at, salt: '6d'.repeat(32) as Hex, scope }, proposal: '00'.repeat(32) as Hex,
    }, ADA.signingSecret as Hex);
    const ada = seatingDevice(ADA);
    await expect(governOnDevice({ ...ada, leaves: ada.roster.reads.leaves }, {
      viewingKey: KEY, change: { kind: 'add-signer', address: at, scope }, summary: 'Add eve as a signer', body: { invite: { address: at, scope }, invited: forged },
    })).rejects.toThrow(/names another proposal than this one/u);
  });

});
