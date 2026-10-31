/**
 * A signer invited by address, approved and admitted from another seat's device as those seats' wallets do it. Ada's
 * device invites Eve by her private address; Bo's device approves the proposal it opens itself, only when it invites
 * exactly what Bo was shown, and raises nothing; Eve's own wallet takes the seat; Bo's device admits her with nothing
 * read out, and her roster entry records the coin key of the address she was invited at, which every later version of
 * the roster keeps. A signer opening the company through the page's own read of its signers, while a seat taken by
 * address waits for Finish adding, reads that seat as waited for and as no believed signer; a seat the chain holds that
 * nobody waits for is still refused there, and so is one waited for on an invitation for another company, on one a key
 * that is no seat signed, or on a proposal the chain shows took a seat whose own entry the directory holds.
 */
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { addressFor, identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { canonical, parseCanonical, seal, signingPublicKeyOf, toHex, unseal, type Hex } from '../core/crypto.js';
import { acceptanceProofOf, invitationIdOf, signSeatInvitation, tokenOfLink, type SignerOffer } from '../core/invitation.js';
import { addSignerByAddressIn, signProposalFiling } from '../core/proposal-filing.js';
import { openRecord, sealRecord, sealToInbox } from '../core/sealed-records.js';
import { newSeatInvitation, proveSeatKeys, SeatKeyNotFromTheInvitee } from '../core/seat-invite-proof.js';
import { keyOf, sealingWith } from '../core/company-key.js';
import { seatBlinding } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import type { PendingSignerPayload, SealedProposal } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { theNetwork } from '../midnight/network.js';
import { inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { sealRoster } from '../core/roster-record.js';
import { vaultKeyIndexOf } from '../core/vault-keys.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry, proposalEntry } from '../midnight/record-manifest.js';
import {
  addressSeatedOrInvitedRefusal, approveSeatInvitationOnDevice, governOnDevice, InvitationNotBound, NothingToApprove, raiseSeatInvitationOnDevice,
  signerByAddressDoorsOf, type SeatInvitationShown,
} from 'vaults-web-shared/governed-call-on-device.js';
import {
  admitSignerHere, fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere, rosterHere, RosterNotBelieved, SeatNotReadOnTheChain, seatingOf,
  WaitingIdTaken, waitingHere,
} from 'vaults-web-shared/roster-here.js';
import { companyJudges, openAccountWith } from 'vaults-web-shared/company-judges.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { FiledNotEntered } from 'vaults-web-shared/record-entered-here.js';
import { ACME, ORIGIN, acmeReads, fromAda, seatsTakenByInvitation, store } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, api, BO, chains, CO, committeeKeyOfLeaf, companyNow, CY, deviceOf, events, ID, KEY, LABEL, rosterDoorsOf, sendAs,
  theInviteeTakesTheSeatHere, walletOf as releasedBy, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

const NETWORK = theNetwork();
const walletOf = (fill: number) => identityFromSecret(new Uint8Array(32).fill(fill));
const addressOf = (fill: number): string => addressFor(walletOf(fill).moneyAt(0).zswap, NETWORK as never).bech32;
const coinKeyAt = (address: string): Hex => String(checkShieldedAddress(address, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
const inviteAddressOf = (c: Hex, salt: Hex): Hex => MidnightCommitments.inviteAddressOf(c, salt);
const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });
const withCommitments = (s: Seat) => ({ ...rosterDoorsOf(s), commitments: MidnightCommitments });
const EVE = { name: 'eve', fill: 61 };
const FAY = { name: 'fay', fill: 62 };
const GUS = { name: 'gus', fill: 64 };
const HAL = { name: 'hal', fill: 66 };
const IVY = { name: 'ivy', fill: 70 };
const JO = { name: 'jo', fill: 71 };
const KIT = { name: 'kit', fill: 72 };
const PAT = { name: 'pat', fill: 73 };
const ROY = { name: 'roy', fill: 74 };
const SAM = { name: 'sam', fill: 75 };
const TOM = { name: 'tom', fill: 76 };
/*
 * The company as a seat's page opens it: the judges every device reads a company with (`companyJudges`), whose
 * `openedHere` hands the roster read its doors. The wallet's chain reads are this test's chain: the account's holders,
 * the indexer the wallet names, and the seat each invitation's proposal took (`invitedSeats`). The anchor and the seat
 * leaves are read as every other device in this file reads them, and the company's key is the one served to the seat.
 * `noIndexer` is a wallet that names no indexer, so the page cannot read which seat an invitation's proposal took;
 * `served` changes what the service answers at a path; `took` changes which seat the chain shows a proposal took.
 */
const openedOnThePage = (s: Seat, o: {
  noIndexer?: boolean; served?: (path: string, body: any) => unknown; took?: (proposals: readonly string[]) => Promise<Readonly<Record<string, string | null>>>;
} = {}) => {
  const shown = { signerId: ID[s.person]!, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex).toLowerCase() };
  const served = async (path: string, init?: RequestInit) => {
    const body = await api(s.person)(path, init);
    return o.served === undefined ? body : o.served(path, body);
  };
  const doors = { api: served as ReturnType<typeof api>, keysFor: (id: string) => (id === CO ? shown : null), servedKeyFor: () => KEY as Hex };
  const judges = companyJudges({
    ...doors,
    holders: async () => acmeReads.holders() as never,
    indexer: async () => (o.noIndexer === true ? null : { indexerUri: 'http://indexer.test', indexerWsUri: 'ws://indexer.test' }),
    builder: async () => ({ invitedSeats: async ({ proposals }: { proposals: readonly string[] }) => (o.took ?? acmeReads.invitedSeats)(proposals) }) as never,
    released: () => null, askReleased: async () => null, treeKept: () => treeKeptInMemory() as never,
    openAccount: (rec, holders, _anchored, _leaves, _keys, ...rest) =>
      openAccountWith(doors, rec, holders, () => acmeReads.anchored, () => acmeReads.leaves, undefined, ...rest),
    seatsAdmittedFor: async () => { throw new Error('this test reads no admitted seats'); },
    noAccount: () => { throw new Error('the test company has an account on the chain'); },
  });
  return async () => judges.openedHere(await served(`/api/accounts/${CO}`));
};

/** The record of an invitation's add-signer proposal as the service would serve it with another invitation inside, signed by `signer`. */
const servedWithInvitation = async (i: Awaited<ReturnType<typeof invited>>, terms: Record<string, unknown>, signer: Hex) => {
  const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === i.proposal.id)!;
  const key = keyOf(KEY as never, rec.keyEpoch);
  const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
  const body = parseCanonical<{ invited: { terms: Record<string, unknown> } }>(unseal(env.sealedPayload as never, key));
  const other = signSeatInvitation({ ...body.invited.terms, ...terms } as never, signer);
  return { ...rec, sealed: sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical({ ...body, invited: other }), key) }, key) };
};

const coinOf = (name: string) => companyNow().signers.find((x) => x.name === name && x.status === 'active')?.coinPublicKey;

/** Ada's device invites a person by their private address, and the offer the link opens; `unchecked` skips the check for a wallet seated or invited. */
const invited = async (who: { name: string; fill: number }, o: { unchecked?: boolean } = {}) => {
  const doors = signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async () => {});
  const made = await inviteHere(ACME, ADA, 'signer', { name: who.name, role: 'approver', person: 'unused', address: addressOf(who.fill) }, ORIGIN, fromAda,
    o.unchecked === true ? { ...doors, held: async () => null } : doors);
  const opened = await openInvitationHere(made.link, sendAs(null));
  const offer = opened.signed.offer.for as SignerOffer;
  const proposal = (await store.listProposals(CO) as SealedProposal[])
    .find((p) => String(p.chainId).toLowerCase() === offer.invited.terms.proposal!.toLowerCase())!;
  const shown: SeatInvitationShown = {
    proposal: proposal.id, name: who.name, role: offer.invited.terms.role, address: offer.invited.terms.invite!.address, scope: offer.invited.terms.invite!.scope,
    coinPublicKey: coinKeyAt(addressOf(who.fill)),
  };
  return { made, opened, offer, proposal, shown };
};

/** The person's own wallet takes seat `n` of its seats as the proposal names, and asks to be admitted; their request's id. */
const seatTaken = async (
  who: { name: string; fill: number }, i: Awaited<ReturnType<typeof invited>>, o: { n?: number; person?: string; sealed?: Record<string, unknown> } = {},
): Promise<string> => {
  const wallet = walletOf(who.fill);
  const key = committeeKeyFor(wallet, LABEL) as { tag: string; value: string };
  const scope = i.offer.invited.terms.invite!.scope as Hex;
  const keys = seatKeysFor(wallet, LABEL, o.n ?? 0);
  const signingSecret = toHex(keys.signingSecret) as Hex;
  const salt = toHex(keys.salt) as Hex;
  const walletKey = { tag: 'schnorr' as const, value: key.value.toLowerCase() };
  const blinding = seatBlinding(walletKey, salt) as Hex;
  const leaf = storedSignerLeaf({ signingSecret, blinding, scope }, MidnightCommitments).toLowerCase() as Hex;
  committeeKeyOfLeaf.set(leaf, key as never);
  theInviteeTakesTheSeatHere(i.offer.invited.terms.proposal!, i.offer.invited.terms.invite!.address, leaf);
  const published = {
    signingPublicKey: signingPublicKeyOf(signingSecret).toLowerCase() as Hex, wrappingPublicKey: toHex(x25519.getPublicKey(keys.wrappingSecret)) as Hex,
    leafCommitment: leaf,
  };
  const waiting = {
    name: who.name, role: 'approver', ...published, person: o.person ?? who.name, invited: i.offer.invited,
    opening: { publicKey: MidnightCommitments.signerPublicKey(signingSecret).toLowerCase(), scope, blinding, walletKey, salt },
    seatProof: proveSeatKeys({ accountId: CO, nonce: i.offer.seat.nonce, secret: i.offer.seat.secret }, published),
    ...(o.sealed ?? {}),
  } as unknown as PendingSignerPayload;
  const token = tokenOfLink(i.made.link)!;
  const asked = await sendAs(o.person ?? who.name)(`/api/invites/${invitationIdOf(token)}/accept-signer`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox(waiting, i.opened.signed.offer.inboxPublicKey) }),
  });
  expect(asked.status).toBe(201);
  return (asked.body as { id: string }).id;
};

/** A second record under `i`'s id on the network, its invitation naming `role`, its filing and invitation signed by `signer`. */
const secondRecordFor = async (i: Awaited<ReturnType<typeof invited>>, role: string, signer: Hex, id: string) => {
  const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === i.proposal.id)!;
  const key = keyOf(KEY as never, rec.keyEpoch);
  const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
  const body = parseCanonical<{ invited: { terms: Record<string, unknown> } }>(unseal(env.sealedPayload as never, key));
  const other = signSeatInvitation({ ...body.invited.terms, role } as never, signer);
  const sealed = sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical({ ...body, invited: other }), key) }, key);
  const filing = signProposalFiling(CO, { id, digest: rec.digest, chainId: rec.chainId, keyEpoch: rec.keyEpoch, createdAt: rec.createdAt, sealed } as never, signer);
  return { rec, filing };
};

describe('A SIGNER INVITED BY ADDRESS IS APPROVED AND ADMITTED FROM ANOTHER SEAT, AS IT WAS SHOWN', () => {
  let eve: Awaited<ReturnType<typeof invited>>;

  it('another seat approves the proposal only as it was shown, and raises nothing', { timeout: 120_000 }, async () => {
    eve = await invited(EVE);
    const bo = seatingDevice(BO);
    const before = events.length;
    for (const changed of [
      { ...eve.shown, name: 'mallory' }, { ...eve.shown, address: '5a'.repeat(32) }, { ...eve.shown, scope: '5b'.repeat(32) },
      { ...eve.shown, coinPublicKey: coinKeyAt(addressOf(63)) }, { ...eve.shown, role: 'admin' as const },
    ]) {
      /* RED WHEN: a proposal that invites another person, role, address, rights or wallet than the window showed is approved. */
      await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: changed }, inviteAddressOf)).rejects.toThrow(InvitationNotBound);
    }
    /* RED WHEN: a coin key that does not make the commitment the proposal's invitation names is approved. */
    await expect(approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: eve.shown }, () => '00'.repeat(32) as Hex))
      .rejects.toThrow(/not the one its invitation's address commits to/u);
    expect(events.slice(before)).toEqual([]);
    const done = await approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: eve.shown }, inviteAddressOf);
    expect(done.state).toBe('waiting-for-the-invitee');
    /* RED WHEN: the approving device sends anything but its one approval, a raise among it. */
    expect(events.slice(before)).toEqual(['chain approve']);
  });

  it('RED WHEN: a device asked only to approve finds no proposal raised for the change, and raises one', async () => {
    const before = events.length;
    await expect(governOnDevice(seatingDevice(BO), {
      viewingKey: KEY, change: { kind: 'threshold', threshold: '2' }, summary: 'Require 2 approvals', body: { newThreshold: 2 }, approveOnly: '5c'.repeat(32),
    })).rejects.toThrow(NothingToApprove);
    await expect(approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: { ...eve.shown, proposal: 'prp_nonexistent0' } }, inviteAddressOf))
      .rejects.toThrow(InvitationNotBound);
    expect(events.slice(before)).toEqual([]);
  });

  it('the seat taken by address is admitted with nothing read out, and its entry records the coin key it was invited at', async () => {
    const signerId = await seatTaken(EVE, eve);
    /* RED WHEN: a seat taken by address is admitted on a device that cannot hold its coin key to the address's commitment. */
    await expect(admitSignerHere(rosterDoorsOf(BO), { signerId, readOut: '' })).rejects.toThrow(/cannot check the address/u);
    /* RED WHEN: a coin key that does not make the commitment the invitation names is recorded for the seat. */
    await expect(admitSignerHere({ ...rosterDoorsOf(BO), commitments: { inviteAddressOf: () => '00'.repeat(32) as Hex } }, { signerId, readOut: '' }))
      .rejects.toThrow(/No proposal of the company's shows which wallet/u);
    /* RED WHEN: a request waiting under another name than the one shown is admitted. */
    await expect(admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: 'mallory' })).rejects.toThrow(/not the one shown/u);
    expect(companyNow().signers.find((x) => x.name === EVE.name)?.status).not.toBe('active');
    await admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: EVE.name });
    /* RED WHEN: the admitted entry does not record the coin key of the address the seat was invited at. */
    expect(companyNow().signers.find((x) => x.name === EVE.name)).toMatchObject({ status: 'active', coinPublicKey: coinKeyAt(addressOf(EVE.fill)) });
    expect(addSignerByAddressIn(eve.proposal, CO, KEY)?.coinPublicKey).toBe(coinKeyAt(addressOf(EVE.fill)));
  });

  it('RED WHEN: a wallet the roster records as seated is invited or approved for a second seat, though the proposals say nothing of it', async () => {
    const ada = seatingDevice(ADA);
    const reads = { ...ada.records, invitedSeats: async () => ({}), holders: acmeReads.holders };
    await expect(addressSeatedOrInvitedRefusal(reads, CO, KEY, inviteAddressOf, coinKeyAt(addressOf(EVE.fill)))).resolves.toBeNull();
    await expect(addressSeatedOrInvitedRefusal({ ...reads, seated: async () => [coinKeyAt(addressOf(EVE.fill))] }, CO, KEY, inviteAddressOf,
      coinKeyAt(addressOf(EVE.fill)))).resolves.toMatch(/already holds a seat on this company/u);
  });

  it('RED WHEN: a proposal that invites a wallet the roster records as seated is approved, though it is the one the window showed', { timeout: 120_000 }, async () => {
    /* Eve is seated, and Ada's device invites her address again without its check: the proposal is as shown, and only the approving device can stop it. */
    const again = await invited(EVE, { unchecked: true });
    const before = events.length;
    const refused = await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: again.shown }, inviteAddressOf).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvitationNotBound);
    expect(String((refused as Error).message)).toMatch(/not approved, and nothing was sent: the wallet at this address already holds a seat on this company/u);
    /* RED WHEN: the approving device sends its approval of a second seat for a wallet already seated. */
    expect(events.slice(before)).toEqual([]);
  });

  it('every later version of the roster keeps the coin key a seat was admitted with', { timeout: 120_000 }, async () => {
    const fay = await invited(FAY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: fay.shown }, inviteAddressOf);
    /* Her request carries a coin key of its own, sealed to the company's inbox as anyone can seal one. */
    const signerId = await seatTaken(FAY, fay, { sealed: { coinPublicKey: 'ee'.repeat(32) } });
    await admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: FAY.name });
    /* RED WHEN: the coin key an admitted entry records is taken from the request, which anyone can seal, and not from the proposal. */
    expect(coinOf(FAY.name)).toBe(coinKeyAt(addressOf(FAY.fill)));
    const read = (await rosterHere(rosterDoorsOf(ADA))).opened.signers;
    /* RED WHEN: a roster filed after a seat's admission drops the coin key that seat was admitted with. */
    expect(read.find((x) => x.name === EVE.name)?.coinPublicKey).toBe(coinKeyAt(addressOf(EVE.fill)));
    expect(read.find((x) => x.name === FAY.name)?.coinPublicKey).toBe(coinKeyAt(addressOf(FAY.fill)));
  });
  it('a fold and a follow of the roster each keep the coin key a seat was admitted with', async () => {
    /* Bo gives his vault keys again, and Ada's device folds them in: the roster is filed again. */
    await offerVaultKeysHere(api(BO.person), CO, {
      signerId: ID[BO.person]!, signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, ...releasedBy(BO), entry: BO.statement, viewingKey: KEY,
    });
    const before = (await rosterHere(rosterDoorsOf(ADA))).version;
    expect((await foldOffersHere(rosterDoorsOf(ADA))).folded).toEqual([BO.seat]);
    expect((await rosterHere(rosterDoorsOf(ADA))).version).toBe(before + 1);
    /* RED WHEN: a fold of the roster drops the coin key an admitted seat records. */
    expect(coinOf(EVE.name)).toBe(coinKeyAt(addressOf(EVE.fill)));
    /* Ada's seat files a version that leaves Cy out: every device refuses it, and Bo's device follows it with a version of its own. */
    const now = await rosterHere(rosterDoorsOf(ADA));
    const next = { name: now.carried.name, signers: now.carried.signers.filter((x) => x.status === 'active' && x.id !== ID[CY.person]) };
    const rec = signCompanyFiling(sealRoster(CO, next, now.version + 1, 0, KEY as Hex), ADA.signingSecret as Hex);
    const filed = await sendAs(ADA.person)(`/api/accounts/${CO}/roster`, {
      method: 'POST', body: JSON.stringify({ roster: { version: now.version + 1, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: next.signers }) }),
    });
    expect(filed.status).toBe(201);
    await ADA.entered.enter([companyRecordEntry(rec)]);
    expect(await fileTheRosterFollowedHere(rosterDoorsOf(BO))).toBe(now.version + 2);
    /* RED WHEN: a roster filed to follow a refused one drops the coin key an admitted seat records. */
    expect(coinOf(EVE.name)).toBe(coinKeyAt(addressOf(EVE.fill)));
    expect(coinOf(FAY.name)).toBe(coinKeyAt(addressOf(FAY.fill)));
    expect(companyNow().signers.some((x) => x.id === ID[CY.person] && x.status === 'active')).toBe(true);
  });

  it('an admission whose entry in the records was lost is entered again by the admitting seat, and every device reads the roster again', { timeout: 120_000 }, async () => {
    const gus = await invited(GUS);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: gus.shown }, inviteAddressOf);
    const signerId = await seatTaken(GUS, gus);
    const lost = { enter: async () => { throw new FiledNotEntered('the connection dropped'); } };
    await expect(admitSignerHere({ ...withCommitments(BO), entered: lost }, { signerId, readOut: '', name: GUS.name })).rejects.toThrow(FiledNotEntered);
    /* The service holds the admission; the records name nothing of it, so no device believes the roster. */
    expect(companyNow().signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    await expect(rosterHere(rosterDoorsOf(ADA))).rejects.toThrow();
    /* RED WHEN: the seat that filed the admission cannot read the roster again, so no act on any device can repair it. */
    const bos = await rosterHere(rosterDoorsOf(BO));
    expect(bos.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    /* RED WHEN: once the admitting seat has read it again, another device still refuses the roster. */
    const adas = await rosterHere(rosterDoorsOf(ADA));
    expect(adas.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    expect(coinOf(GUS.name)).toBe(coinKeyAt(addressOf(GUS.fill)));
  });

  it('RED WHEN: a wallet another entry records as seated is admitted to a second seat', { timeout: 120_000 }, async () => {
    /* Ada's device invites Eve's address again without its check; Bo's device approves from the offer, and Eve's wallet takes a second seat. */
    const again = await invited(EVE, { unchecked: true });
    await raiseSeatInvitationOnDevice(seatingDevice(BO), {
      viewingKey: KEY, invited: again.offer.invited, proposalSalt: again.offer.byAddress!.proposalSalt, name: EVE.name,
    });
    const signerId = await seatTaken(EVE, again, { n: 1, person: 'eve-again' });
    await expect(admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: EVE.name }))
      .rejects.toThrow(/already holds a seat on this company, so nobody is seated from it/u);
    expect(companyNow().signers.filter((x) => x.name === EVE.name && x.status === 'active')).toHaveLength(1);
  });

  it('RED WHEN: a seat taken by address is admitted on an invitation other than the one the approved proposal carries, with a role nobody approved', { timeout: 120_000 }, async () => {
    const hal = await invited(HAL);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: hal.shown }, inviteAddressOf);
    /* Ada's seat signs a second invitation for the same proposal, address and rights, naming another role, with a seat secret made for that role, and Hal's request carries it. */
    const admin = signSeatInvitation({ ...hal.offer.invited.terms, role: 'admin' }, ADA.signingSecret as Hex);
    const seat = newSeatInvitation(sealingWith(KEY, 0).key, CO, HAL.name, 'admin');
    const forged = { ...hal, offer: { ...hal.offer, role: 'admin' as const, invited: admin, seat: { nonce: seat.nonce, secret: seat.secret } } };
    const signerId = await seatTaken(HAL, forged, { sealed: { role: 'admin' } });
    await expect(admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: HAL.name }))
      .rejects.toThrow(/not the invitation the proposal its seat was approved on carries/u);
    expect(companyNow().signers.find((x) => x.name === HAL.name)?.status).not.toBe('active');
  });

  it('RED WHEN: a record under the approved proposal\'s id, filed and signed by a key that is no seat, stops a seat the approvers approved from being admitted', { timeout: 120_000 }, async () => {
    const ivy = await invited(IVY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: ivy.shown }, inviteAddressOf);
    const signerId = await seatTaken(IVY, ivy);
    /* The service serves a second record under the same id on the network, its invitation naming another role, filed and signed by a key of nobody's. */
    const { rec, filing } = await secondRecordFor(ivy, 'viewer', toHex(new Uint8Array(32).fill(9)) as Hex, 'prp_decoydecoyde');
    store.putProposal({ ...rec, ...filing, id: 'prp_decoydecoyde', status: 'executed' } as never);
    await admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: IVY.name });
    expect(companyNow().signers.find((x) => x.name === IVY.name)).toMatchObject({ status: 'active', role: 'approver' });
  });

  it('RED WHEN: a proposal is approved while another the company holds under its id on the network, filed and signed by a seat that may invite, carries another invitation', { timeout: 120_000 }, async () => {
    const jo = await invited(JO);
    const { rec, filing } = await secondRecordFor(jo, 'admin', ADA.signingSecret as Hex, 'prp_secondrecord');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecord' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: jo.shown }, inviteAddressOf))
      .rejects.toThrow(/Another proposal the company holds under the same id on the network carries another invitation/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: a seat is admitted on one of two invitations under its id that seats which may invite filed, and so with a role the approvers may not have approved', { timeout: 120_000 }, async () => {
    const kit = await invited(KIT);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: kit.shown }, inviteAddressOf);
    const signerId = await seatTaken(KIT, kit);
    /* After the network seated Kit, Ada's seat files a second record under the same id, its invitation naming another role. */
    const { rec, filing } = await secondRecordFor(kit, 'admin', ADA.signingSecret as Hex, 'prp_secondrecor2');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecor2', status: 'executed' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    await expect(admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: KIT.name }))
      .rejects.toThrow(/Two proposals this device believes, each filed and signed by a seat that may invite, carry different invitations/u);
    expect(companyNow().signers.find((x) => x.name === KIT.name)?.status).not.toBe('active');
  });

  it('RED WHEN: a request the service names with a seated signer\'s id is filed as that signer at the joiner\'s seat, and every device then refuses the roster', { timeout: 120_000 }, async () => {
    const pat = await invited(PAT);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: pat.shown }, inviteAddressOf);
    const own = await seatTaken(PAT, pat);
    const seated = ID[CY.person]!;
    /* The service answers the request under Cy's id, as only the service chooses the id a person waits under. */
    const named = (from: string, to: string): void => {
      const rec = store.getAccount(CO)!;
      store.putAccount({ ...rec, pendingSigners: rec.pendingSigners.map((p) => (p.id === from ? { ...p, id: to } : p)) });
    };
    named(own, seated);
    const before = (await rosterHere(rosterDoorsOf(ADA))).version;
    const refused = await admitSignerHere(withCommitments(BO), { signerId: seated, readOut: '', name: PAT.name }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WaitingIdTaken);
    /* RED WHEN: a roster is filed under an id another entry carries, so Cy's keys sit at Pat's seat and no device can read the roster again. */
    expect((await rosterHere(rosterDoorsOf(ADA))).version).toBe(before);
    expect(companyNow().signers.filter((x) => x.id === seated && x.status === 'active').map((x) => x.leafCommitment?.toLowerCase())).toEqual([CY.seat.toLowerCase()]);
    /* Under the id the service first gave it, the same request is admitted. */
    named(seated, own);
    await admitSignerHere(withCommitments(BO), { signerId: own, readOut: '', name: PAT.name });
    expect(companyNow().signers.find((x) => x.name === PAT.name)?.status).toBe('active');
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('RED WHEN: a chain that could not be read for the seat an invitation by address took is told as another seat, and the person is refused for good', { timeout: 120_000 }, async () => {
    const roy = await invited(ROY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: roy.shown }, inviteAddressOf);
    const signerId = await seatTaken(ROY, roy);
    const read = await rosterHere(rosterDoorsOf(BO));
    const seating = seatingOf(read, rosterDoorsOf(BO).reads);
    const waitingWith = (invitedSeats: (proposals: readonly string[]) => Promise<Readonly<Record<string, string | null>>>) =>
      waitingHere(read.sealed, read.account, KEY, signerId, '', { ...seating, invitedSeats }).catch((e: unknown) => e);
    for (const unread of [
      async () => { throw new ReadRanOutOfTime('The network (invited-seats)'); },
      async () => { throw new Error('the indexer refused the query'); },
      /* What a device whose wallet names no indexer answers: nothing, for any proposal. */
      async () => ({}),
    ]) {
      const e = await waitingWith(unread);
      expect(e).toBeInstanceOf(SeatNotReadOnTheChain);
      expect(e).not.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    }
    /* RED WHEN: a chain that shows the proposal took another seat is told as a chain not read, and the person is asked to press again for a seat that is not theirs. */
    expect(await waitingWith(async (proposals) => Object.fromEntries(proposals.map((x) => [x, '5d'.repeat(32)])))).toBeInstanceOf(SeatKeyNotFromTheInvitee);
    /* Read again, the same request is admitted. */
    await admitSignerHere(withCommitments(BO), { signerId, readOut: '', name: ROY.name });
    expect(companyNow().signers.find((x) => x.name === ROY.name)?.status).toBe('active');
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('a signer opens the company while a seat taken by address waits for Finish adding, and then admits it', { timeout: 120_000 }, async () => {
    const sam = await invited(SAM);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: sam.shown }, inviteAddressOf);
    const signerId = await seatTaken(SAM, sam);
    const unread = await openedOnThePage(ADA, { noIndexer: true })().catch((e: unknown) => e);
    expect(unread).toBeInstanceOf(RosterNotBelieved);
    /* RED WHEN: a signer's page that cannot read which seat an invitation's proposal took refuses the roster without saying what stopped it. */
    expect((unread as RosterNotBelieved).stoppedBy).toContain('SeatNotReadOnTheChain');
    /* RED WHEN: a signer's page reads a seat the chain holds, taken on an invitation by address whose request waits for Finish adding, as a seat the roster leaves out. */
    const waiting = await openedOnThePage(ADA)();
    expect(waiting?.signers.some((x) => x.name === SAM.name && x.status === 'active')).toBe(false);
    /* RED WHEN: the seat that waits is read as a believed signer, so a committee or a reader list is built from a roster that does not name it. */
    expect(waiting?.notBelieved).toContain(seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase()));
    expect(waiting?.signers.find((x) => x.id === ID[ADA.person])?.status).toBe('active');
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: SAM.name });
    /* RED WHEN: a signer's page refuses the whole roster once Finish adding admits a seat taken by address, before its signer files their own entry. */
    const admitted = await openedOnThePage(ADA)();
    expect(admitted?.refused.find((x) => x.name === SAM.name)?.why).toBe('no-entry-of-their-own');
    expect(admitted?.signers.find((x) => x.id === ID[ADA.person])?.status).toBe('active');
  });

  it('RED WHEN: a signer\'s page believes a roster that leaves out a seat the chain holds and nobody waits for', async () => {
    const was = chains.get(CO)!;
    const stray = '5e'.repeat(32);
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [...was.seats.seats, stray], committee: [...was.seats.committee, was.seats.committee[0]!] } });
    try {
      const refused = await openedOnThePage(ADA)().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect(String((refused as Error).message)).toMatch(/it has no entry for 1 seat\(s\) the company's account holds on the chain/u);
      expect((refused as RosterNotBelieved).check).toBe('seat-unnamed');
    } finally {
      chains.set(CO, was);
    }
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('RED WHEN: a signer\'s page reads a seat taken by address as waited for on an invitation for another company, or one signed by a key that is no seat', { timeout: 120_000 }, async () => {
    const tom = await invited(TOM);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: tom.shown }, inviteAddressOf);
    await seatTaken(TOM, tom);
    const leaf = seatsTakenByInvitation.get(tom.offer.invited.terms.proposal!.toLowerCase());
    /* The request Tom's wallet filed is not served, so his seat is waited for only through the proposal that seated it. */
    const proposalsAre = (list: (all: SealedProposal[]) => unknown[]) => (path: string, body: any) => {
      if (path === `/api/accounts/${CO}`) return { ...body, pendingSigners: [] };
      return path === `/api/accounts/${CO}/proposals` ? list(body as SealedProposal[]) : body;
    };
    const waiting = await openedOnThePage(ADA, { served: proposalsAre((all) => all) })();
    expect(waiting?.notBelieved).toContain(leaf);
    for (const forged of [
      await servedWithInvitation(tom, { company: 'acc_anothercompany' }, ADA.signingSecret as Hex),
      await servedWithInvitation(tom, {}, toHex(new Uint8Array(32).fill(9)) as Hex),
    ]) {
      const refused = await openedOnThePage(ADA, { served: proposalsAre((all) => all.map((p) => (p.id === tom.proposal.id ? forged : p))) })()
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect((refused as RosterNotBelieved).check).toBe('seat-unnamed');
    }
  });

  it('RED WHEN: a signer\'s page reads a seat whose own entry the directory holds as waited for, because the chain shows a proposal by address took it', async () => {
    const was = chains.get(CO)!;
    const stray = '5f'.repeat(32);
    const now = await rosterHere(rosterDoorsOf(ADA));
    const fileRoster = async (signers: typeof now.carried.signers, version: number) => {
      const rec = signCompanyFiling(sealRoster(CO, { name: now.carried.name, signers }, version, 0, KEY as Hex), ADA.signingSecret as Hex);
      const filed = await sendAs(ADA.person)(`/api/accounts/${CO}/roster`, {
        method: 'POST', body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers }) }),
      });
      expect(filed.status).toBe(201);
      await ADA.entered.enter([companyRecordEntry(rec)]);
    };
    const seated = now.carried.signers.filter((x) => x.status === 'active');
    /* Ada files a roster that leaves out Cy, whose own entry the directory holds, and the chain holds a seat nobody waits for. */
    await fileRoster(seated.filter((x) => x.id !== ID[CY.person]), now.version + 1);
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [...was.seats.seats, stray], committee: [...was.seats.committee, was.seats.committee[0]!] } });
    /* A proposal by address whose seat the roster names as an active signer, so only Cy's reading of it changes. */
    const named = new Set(seated.map((x) => String(x.leafCommitment).toLowerCase()));
    const proposal = [...seatsTakenByInvitation].find(([, leaf]) => named.has(leaf.toLowerCase()))![0];
    try {
      /* The chain is shown to have seated Cy from that proposal by address; every other proposal took the seat it did. */
      const took = async (asked: readonly string[]) => ({ ...(await acmeReads.invitedSeats(asked)), ...(asked.includes(proposal) ? { [proposal]: CY.seat.toLowerCase() } : {}) });
      const refused = await openedOnThePage(ADA, { took })().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect(String((refused as Error).message)).toMatch(/it has no entry for 2 seat\(s\) the company's account holds on the chain/u);
    } finally {
      chains.set(CO, was);
      await fileRoster(seated, now.version + 2);
    }
  });
});
