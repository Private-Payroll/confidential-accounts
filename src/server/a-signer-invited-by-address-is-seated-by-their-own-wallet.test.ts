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
import { acceptanceProofOf, invitationIdOf, invitationLink, newInvitationToken, signSeatInvitation, tokenOfLink, type SignerOffer } from '../core/invitation.js';
import { addressesInvitedIn } from '../core/proposal-filing.js';
import { sealToInbox } from '../core/sealed-records.js';
import { proveSeatKeys } from '../core/seat-invite-proof.js';
import { seatBlinding } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import type { PendingSignerPayload } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { theNetwork } from '../midnight/network.js';
import { firstAskRefusal, InvitationNotMade, InvitationRaisedNotFiled, inviteHere, openInvitationHere, type KeptSeatInvitation } from 'vaults-web-shared/invitation-on-device.js';
import {
  addressSeatedOrInvitedRefusal, governOnDevice, raiseSeatInvitationOnDevice, signerByAddressDoorsOf, type SeatInvitationToRaise,
} from 'vaults-web-shared/governed-call-on-device.js';
import { fileTheOwedDirectoryEntry, type OwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { admitSignerHere, rosterHere } from 'vaults-web-shared/roster-here.js';
import { ACME, ORIGIN, acmeReads, fromAda, seatsTakenByInvitation, store } from './a-company-of-two-seats.test-support.js';
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
const DEES_COIN_KEY = String(checkShieldedAddress(DEES_ADDRESS, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const addressOfWallet = (fill: number): string => addressFor(identityFromSecret(new Uint8Array(32).fill(fill)).moneyAt(0).zswap, NETWORK as never).bech32;
const coinKeyAt = (address: string): Hex => String(checkShieldedAddress(address, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const inviteAddressOf = (c: Hex, salt: Hex): Hex => MidnightCommitments.inviteAddressOf(c, salt);
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
    /* RED WHEN: Dee's wallet, whose answer never came back, asks again and is refused, so the id its kept seat needs is
     * lost; or the service files her request twice; or it gives her id to somebody else holding the link; or an expiry
     * since the first answer refuses the repeat. */
    const askAgain = (who: string) => sendAs(who)(`/api/invites/${invitationIdOf(token)}/accept-signer`, {
      method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox(waiting(), opened.signed.offer.inboxPublicKey) }),
    });
    const waitingBefore = store.getAccount(CO)!.pendingSigners.length;
    expect(await askAgain('dee')).toMatchObject({ status: 201, body: { id: signerId } });
    expect(store.getAccount(CO)!.pendingSigners.length).toBe(waitingBefore);
    expect((await askAgain('mallory')).body).not.toMatchObject({ id: signerId });
    const invitation = store.invitationById(invitationIdOf(token))!;
    store.putInvite({ ...invitation, expiresAt: new Date(Date.now() - 1000).toISOString() });
    try {
      expect(await askAgain('dee')).toMatchObject({ status: 201, body: { id: signerId } });
    } finally {
      store.putInvite(invitation);
    }
    /* RED WHEN: a device admits a request whose seat is not the one the history shows this invitation's proposal took. */
    const proposalId = terms.proposal!.toLowerCase();
    seatsTakenByInvitation.set(proposalId, '5a'.repeat(32));
    await expect(admitSignerHere({ ...rosterDoorsOf(BO), commitments: MidnightCommitments }, { signerId, readOut: '' })).rejects.toThrow();
    seatsTakenByInvitation.set(proposalId, dee.leaf);
    await admitSignerHere({ ...rosterDoorsOf(BO), commitments: MidnightCommitments }, { signerId, readOut: '' });
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

  it('the proposal to seat an address carries the coin key of the wallet it invites, bound to the address it commits to', async () => {
    const invited = addressesInvitedIn(await store.listProposals(CO), CO, KEY, inviteAddressOf);
    /* RED WHEN: a raise by address seals no coin key, so no device can tell a wallet invited twice from a new person. */
    expect(invited.map((x) => x.coinPublicKey)).toContain(DEES_COIN_KEY);
    /* RED WHEN: a coin key that does not make the commitment the invitation names is believed. */
    expect(addressesInvitedIn(await store.listProposals(CO), CO, KEY, () => '00'.repeat(32) as Hex)).toEqual([]);
  });

  it('RED WHEN: a wallet already seated on the company is invited to a second seat, and would approve twice', async () => {
    const kept: KeptSeatInvitation[] = [];
    const before = events.length;
    await expect(inviteHere(ACME, ADA, 'signer', { name: 'dee again', role: 'approver', person: 'unused', address: DEES_ADDRESS }, ORIGIN, fromAda,
      signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); })))
      .rejects.toThrow(/already holds a seat on this company/u);
    expect(kept).toEqual([]);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: the service leaves out the proposal that seated a wallet, and that wallet is invited to a second seat', async () => {
    const seatedBy = new Set(addressesInvitedIn(await store.listProposals(CO), CO, KEY, inviteAddressOf)
      .filter((x) => x.coinPublicKey === DEES_COIN_KEY).map((x) => x.chainId));
    const device = seatingDevice(ADA);
    const hiding = {
      ...device,
      records: { ...device.records!, proposals: async () => (await device.records!.proposals!()).filter((p) => !seatedBy.has(String(p.chainId).toLowerCase())) },
    };
    const kept: KeptSeatInvitation[] = [];
    const before = events.length;
    await expect(inviteHere(ACME, ADA, 'signer', { name: 'dee again', role: 'approver', person: 'unused', address: DEES_ADDRESS }, ORIGIN, fromAda,
      signerByAddressDoorsOf(hiding as never, KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); })))
      .rejects.toThrow(/withhold|did not give it/u);
    expect(kept).toEqual([]);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: a wallet invited by a proposal still open is invited again, and taken up again it raises a second proposal', async () => {
    const gus = addressOfWallet(51);
    const token = newInvitationToken();
    const kept: KeptSeatInvitation[] = [];
    const down: typeof fromAda = async (path, init) => (path.endsWith('/invites') && init?.method === 'POST'
      ? { status: 503, body: { error: 'the service is down' } } : fromAda(path, init));
    const doors = () => signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); });
    const failed = await inviteHere(ACME, ADA, 'signer', { name: 'gus', role: 'approver', person: 'unused', address: gus }, ORIGIN, down, doors(), { token })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(InvitationRaisedNotFiled);
    /* RED WHEN: the link is not the one the token given makes, so the page that made the token cannot make it again. */
    expect(kept[0]!.link).toBe(invitationLink(ORIGIN, token));
    const proposes = events.filter((e) => e === 'chain propose').length;
    await expect(inviteHere(ACME, ADA, 'signer', { name: 'gus', role: 'approver', person: 'unused', address: gus }, ORIGIN, fromAda, doors()))
      .rejects.toThrow(/already invited to a seat on this company by a proposal still open/u);
    expect(kept).toHaveLength(1);
    /* RED WHEN: an invitation kept past its expiry is raised again, for an offer nobody can open any more. */
    const stale = { ...kept[0]!, offer: { ...kept[0]!.offer, offer: { ...kept[0]!.offer.offer, expiresAt: Date.now() - 1 } } };
    await expect(inviteHere(ACME, ADA, 'signer', { name: 'gus', role: 'approver', person: 'unused', address: gus }, ORIGIN, fromAda, doors(),
      { token, resume: stale })).rejects.toThrow(/has expired, so its proposal is not raised again/u);
    expect(events.filter((e) => e === 'chain propose').length).toBe(proposes);
    const made = await inviteHere(ACME, ADA, 'signer', { name: 'gus', role: 'approver', person: 'unused', address: gus }, ORIGIN, fromAda, doors(),
      { token, resume: kept[0]! });
    expect(made.link).toBe(kept[0]!.link);
    expect(events.filter((e) => e === 'chain propose').length).toBe(proposes);
    expect(kept).toHaveLength(1);
    expect((await openInvitationHere(made.link, sendAs(null))).signed).toEqual(kept[0]!.offer);
    /* RED WHEN: an invitation kept for another address is taken up again for this one. */
    await expect(inviteHere(ACME, ADA, 'signer', { name: 'hal', role: 'approver', person: 'unused', address: addressOfWallet(52) }, ORIGIN, fromAda, doors(),
      { resume: kept[0]! })).rejects.toThrow(/not a seat offered at this address/u);
  });

  it('RED WHEN: a seat kept on the device is taken up again for another name, role or rights than it was kept with, and raised as the kept one', async () => {
    const ivy = addressOfWallet(54);
    const token = newInvitationToken();
    const kept: KeptSeatInvitation[] = [];
    const down: typeof fromAda = async (path, init) => (path.endsWith('/invites') && init?.method === 'POST'
      ? { status: 503, body: { error: 'the service is down' } } : fromAda(path, init));
    const doors = () => signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async (k) => { kept.push(k); });
    const asked = { name: 'ivy', role: 'approver' as const, person: 'unused', address: ivy };
    expect(await inviteHere(ACME, ADA, 'signer', asked, ORIGIN, down, doors(), { token }).catch((e: unknown) => e)).toBeInstanceOf(InvitationRaisedNotFiled);
    const before = events.length;
    for (const other of [{ role: 'admin' as const }, { name: 'ivy two' }, { scope: '09'.repeat(32) as Hex }]) {
      const refused = await inviteHere(ACME, ADA, 'signer', { ...asked, ...other }, ORIGIN, fromAda, doors(), { token, resume: kept[0]! }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(InvitationNotMade);
      expect((refused as Error).message).toMatch(/press again with the same details as the first time, or start a new invitation/u);
    }
    /* Nothing reached the chain or the service for the presses that differed. */
    expect(events.slice(before)).toEqual([]);
    expect(kept).toHaveLength(1);
    /* The same details take it up again, at the rights it was kept with. */
    const made = await inviteHere(ACME, ADA, 'signer', { ...asked, scope: MidnightCommitments.allVaults() }, ORIGIN, fromAda, doors(), { token, resume: kept[0]! });
    expect(made.link).toBe(kept[0]!.link);
  });

  it('RED WHEN: the chain cannot be read for the seats invitations took, and a wallet is invited anyway', async () => {
    const ada = seatingDevice(ADA);
    const { invitedSeats: _none, ...blind } = acmeReads;
    await expect(addressSeatedOrInvitedRefusal({ ...ada.records, holders: blind.holders }, CO, KEY, inviteAddressOf, DEES_COIN_KEY))
      .resolves.toMatch(/cannot read which wallets/u);
  });

  it('RED WHEN: a proposal to seat an address is raised without its coin key, or with a coin key the address does not commit to', async () => {
    const ada = seatingDevice(ADA);
    const ivy = coinKeyAt(addressOfWallet(53));
    const salt = '7a'.repeat(32) as Hex;
    const proposalSalt = '7b'.repeat(32);
    const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
    const at = MidnightCommitments.inviteAddressOf(ivy, salt).toLowerCase() as Hex;
    const { chainId } = await ada.builder.proposalIdentity!({ kind: 'add-signer', address: at, scope }, proposalSalt);
    const invited = signSeatInvitation({
      company: CO, invitation: '7c'.repeat(32) as Hex, person: 'adr_00000000000000000002', name: 'ivy', role: 'approver',
      invite: { address: at, salt, scope }, proposal: String(chainId).toLowerCase() as Hex,
    }, ADA.signingSecret as Hex);
    const before = events.length;
    await expect(raiseSeatInvitationOnDevice(ada, { viewingKey: KEY, invited, proposalSalt, name: 'ivy' }, inviteAddressOf))
      .rejects.toThrow(/without the coin key/u);
    await expect(raiseSeatInvitationOnDevice(ada, { viewingKey: KEY, invited, proposalSalt, name: 'ivy', coinPublicKey: DEES_COIN_KEY }, inviteAddressOf))
      .rejects.toThrow(/not the one the invitation's address commits to/u);
    expect(events.slice(before)).toEqual([]);
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


  it('RED WHEN: a press again is matched to the first by fewer than every field the first carried, or by another kind', () => {
    const SECRET = '21'.repeat(32) as Hex;
    const ALL = MidnightCommitments.allVaults().toLowerCase() as Hex;
    const id = invitationIdOf(newInvitationToken());
    const seat = (o: { name?: string; role?: 'approver' | 'admin'; scope?: Hex; address?: string } = {}): SignerOffer => {
      const name = o.name ?? 'ivy';
      const role = o.role ?? 'approver';
      return {
        kind: 'signer', name, role, seat: { nonce: '0d'.repeat(32) as Hex, secret: '0e'.repeat(32) as Hex },
        invited: signSeatInvitation({
          company: CO, invitation: id, person: 'adr_00000000000000000000', name, role,
          invite: { address: '0a'.repeat(32) as Hex, salt: '0b'.repeat(32) as Hex, scope: o.scope ?? ALL }, proposal: '0c'.repeat(32) as Hex,
        }, SECRET),
        byAddress: { address: o.address ?? DEES_ADDRESS, proposalSalt: '0f'.repeat(32) as Hex },
      };
    };
    const signer = { name: 'ivy', role: 'approver' as const, person: 'unused', address: DEES_ADDRESS };
    expect(firstAskRefusal(seat(), 'signer', signer, ALL)).toBeNull();
    expect(firstAskRefusal(seat(), 'signer', { ...signer, address: DEES_ADDRESS.toUpperCase(), scope: ALL.toUpperCase() as Hex }, ALL)).toBeNull();
    expect(firstAskRefusal(seat(), 'signer', { ...signer, role: 'admin' }, ALL)).toMatch(/another role/u);
    expect(firstAskRefusal(seat(), 'signer', { ...signer, name: 'ivy two' }, ALL)).toMatch(/another name/u);
    expect(firstAskRefusal(seat(), 'signer', { ...signer, scope: '09'.repeat(32) as Hex }, ALL)).toMatch(/other rights/u);
    expect(firstAskRefusal(seat({ scope: '09'.repeat(32) as Hex }), 'signer', signer, ALL)).toMatch(/other rights/u);
    expect(firstAskRefusal(seat(), 'signer', { ...signer, address: addressOfWallet(55) }, ALL)).toMatch(/another address/u);
    /* The name and role are judged both on the offer and on the invitation it signs, which is what the proposal raises. */
    expect(firstAskRefusal({ ...seat(), role: 'admin' }, 'signer', signer, ALL)).toMatch(/another role/u);
    expect(firstAskRefusal({ ...seat({ role: 'admin' }), role: 'approver' }, 'signer', signer, ALL)).toMatch(/another role/u);
    expect(firstAskRefusal({ ...seat(), name: 'ivy two' }, 'signer', signer, ALL)).toMatch(/another name/u);
    expect(firstAskRefusal({ ...seat({ name: 'ivy two' }), name: 'ivy' }, 'signer', signer, ALL)).toMatch(/another name/u);
    const { address: _a, ...byLink } = signer;
    expect(firstAskRefusal(seat(), 'signer', byLink, ALL)).toMatch(/another address/u);
    const employee = {
      kind: 'employee', person: 'emp_00000000000000000000', name: 'ada', title: 'Engineer', email: null, asset: 'ab'.repeat(32),
      baseAmount: 5000n, startDate: '2026-11-01', classification: 'full-time',
    } as const;
    const asEmployee = { name: 'ada', title: 'Engineer', email: null, asset: 'ab'.repeat(32), baseAmount: 5000n, startDate: '2026-11-01', classification: 'full-time' } as never;
    expect(firstAskRefusal(employee as never, 'employee', asEmployee, ALL)).toBeNull();
    for (const [k, v, said] of [['baseAmount', 5001n, /another pay/u], ['asset', 'cd'.repeat(32), /another currency/u], ['email', 'a@b.c', /another email/u],
      ['startDate', '2026-12-01', /another start date/u], ['endDate', '2027-01-01', /another end date/u], ['classification', 'part-time', /another classification/u],
      ['address', DEES_ADDRESS, /another address/u], ['title', 'Boss', /another title/u], ['name', 'bo', /another name/u]] as const) {
      expect(firstAskRefusal(employee as never, 'employee', { ...(asEmployee as object), [k]: v } as never, ALL), k).toMatch(said);
    }
    const vendor = { kind: 'vendor', person: 'ven_00000000000000000000', name: 'acme', email: null, startDate: '2026-11-01' } as const;
    const asVendor = { name: 'acme', email: null, startDate: '2026-11-01', terms: { kind: 'one-off' }, network: NETWORK } as never;
    expect(firstAskRefusal(vendor as never, 'vendor', asVendor, ALL)).toBeNull();
    for (const [k, v, said] of [['name', 'acme two', /another name/u], ['email', 'a@b.c', /another email/u], ['startDate', '2026-12-01', /another start date/u],
      ['endDate', '2027-01-01', /another end date/u], ['address', DEES_ADDRESS, /another address/u]] as const) {
      expect(firstAskRefusal(vendor as never, 'vendor', { ...(asVendor as object), [k]: v } as never, ALL), k).toMatch(said);
    }
    /* Another kind is never the same ask, whatever its fields. */
    expect(firstAskRefusal(seat(), 'employee', asEmployee, ALL)).toMatch(/a signer, not an employee/u);
    expect(firstAskRefusal(employee as never, 'vendor', asVendor, ALL)).toMatch(/an employee, not a vendor/u);
    expect(firstAskRefusal({ kind: 'reissue', name: 'ivy', role: 'approver', invited: seat().invited } as never, 'signer', signer, ALL)).toMatch(/re-issued/u);
  });
});
