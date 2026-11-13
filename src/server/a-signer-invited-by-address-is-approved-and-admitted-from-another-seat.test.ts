/**
 * A signer invited by address, approved and admitted from another seat's device as those seats' wallets do it. Ada's
 * device invites Eve by her private address; Bo's device approves the proposal it opens itself, only when it invites
 * exactly what Bo was shown, and raises nothing; Eve's own wallet takes the seat; Ada's device, whose role may file the roster, admits her with nothing
 * read out, and her roster entry records the coin key of the address she was invited at, which every later version of
 * the roster keeps. A signer opening the company through the page's own read of its signers, while a seat taken by
 * address waits for Finish adding, reads that seat as waited for and as no believed signer; a seat the chain holds that
 * nobody waits for is still refused there, and so is one waited for on an invitation for another company, on one a key
 * that is no seat signed, or on a proposal the chain shows took a seat whose own entry the directory holds. The
 * proposal's id is made under the salt its invitation makes, so another invitation filed under that id is never believed
 * beside it, and a proposal raised under any other salt is refused.
 */
import { describe, it, expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { addressFor, identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { canonical, fromHex, parseCanonical, seal, sign, signingPublicKeyOf, toHex, unseal, utf8, type Hex } from '../core/crypto.js';
import {
  acceptanceProofOf, invitationIdOf, invitationProposalSalt, seatByAddressChangeOf, signSeatInvitation, tokenOfLink, type SeatByAddressChange,
  seatInvitationMessage, seatInvitationRefusal, type SignedSeatInvitation, type SignerOffer,
} from '../core/invitation.js';
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
  approveSeatInvitationOnDevice, governOnDevice, InvitationNotBound, InvitationOutrun, NothingToApprove,
  raiseSeatInvitationOnDevice,
  signerByAddressDoorsOf, type SeatInvitationShown,
} from 'vaults-web-shared/governed-call-on-device.js';
import { addressSeatedOrInvitedRefusal } from 'vaults-web-shared/address-seated-or-invited.js';
import {
  admitSignerHere, fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere, rosterHere, RosterNotBelieved, seatingOf,
  WaitingIdTaken, waitingHere,
} from 'vaults-web-shared/roster-here.js';
import { SeatNotReadOnTheChain } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { companyJudges, openAccountWith } from 'vaults-web-shared/company-judges.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { ReadRanOutOfTime } from 'vaults-web-shared/read-bound.js';
import { PROPOSALS_NOT_READ, SEAT_READ_STOP, SeatingRefusedOnTheChain, TWO_SEATINGS } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { seatingRefusedRead } from 'vaults-web-shared/roster-seating-refused.js';
import { FiledNotEntered } from 'vaults-web-shared/record-entered-here.js';
import { invitedLeafOfTheTestChain } from '../testing/invitation-approved.js';
import { ACME, ORIGIN, acmeReads, fromAda, seatsTakenByInvitation, store } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, ADA, api, BO, chains, CO, committeeKeyOfLeaf, companyNow, CY, deviceOf, events, ID, KEY, LABEL, rosterDoorsOf, sendAs,
  theInviteeTakesTheSeatHere, walletOf as releasedBy, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { scopeOfRole } from '../core/seat-rights.js';

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
const VAL = { name: 'val', fill: 78 };
const WES = { name: 'wes', fill: 79 };
const XAN = { name: 'xan', fill: 80 };
const YUL = { name: 'yul', fill: 81 };
/*
 * The company as a seat's page opens it: the judges every device reads a company with (`companyJudges`), whose
 * `openedHere` hands the roster read its doors. The wallet's chain reads are this test's chain: the account's holders,
 * the indexer the wallet names, and the seat each invitation's proposal took (`invitedSeats`); a proposal's identity is the
 * account's own (`proposalIdentity`). The anchor and the seat
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
    builder: async () => ({
      /*
       * `took` answers for the proposals this file's cases raise; the seats the company was set up with are read as
       * the chain holds them, so a case's stop is the one it names and not the directory's own read.
       */
      invitedSeats: async ({ proposals }: { proposals: readonly string[] }) => {
        const setUp = proposals.filter((x) => invitedLeafOfTheTestChain(x) !== null);
        const asked = proposals.filter((x) => invitedLeafOfTheTestChain(x) === null);
        return { ...await acmeReads.invitedSeats(setUp), ...(asked.length === 0 ? {} : await (o.took ?? acmeReads.invitedSeats)(asked)) };
      },
      proposalIdentity: acmeReads.proposalIdentity,
    }) as never,
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
  theInviteeTakesTheSeatHere(i.offer.invited.terms.proposal!, { coinPublicKey: coinKeyAt(addressOf(who.fill)), addressSalt: i.offer.invited.terms.invite!.salt }, leaf);
  const published = {
    signingPublicKey: signingPublicKeyOf(signingSecret).toLowerCase() as Hex, wrappingPublicKey: toHex(x25519.getPublicKey(keys.wrappingSecret)) as Hex,
    leafCommitment: leaf,
  };
  const waiting = {
    name: who.name, role: 'approver', ...published, person: o.person ?? who.name, invited: i.offer.invited,
    opening: { publicKey: MidnightCommitments.signerPublicKey(signingSecret).toLowerCase(), scope, blinding, walletKey, salt },
    seatProof: proveSeatKeys({ accountId: CO, nonce: i.offer.seat.nonce, secret: i.offer.seat.secret }, published,
      { person: o.person ?? who.name, invitationId: i.offer.invited.terms.invitation }),
    ...(o.sealed ?? {}),
  } as unknown as PendingSignerPayload;
  const token = tokenOfLink(i.made.link)!;
  const asked = await sendAs(o.person ?? who.name)(`/api/invites/${invitationIdOf(token)}/accept-signer`, {
    method: 'POST', body: JSON.stringify({ acceptance: acceptanceProofOf(token), waiting: sealToInbox(waiting, i.opened.signed.offer.inboxPublicKey) }),
  });
  expect(asked.status).toBe(201);
  return (asked.body as { id: string }).id;
};

/**
 * The same seat invitation signed again by the same key under another nonce: a second valid signature over the very same
 * terms, which ed25519 allows to whoever holds the key.
 */
const signedAgain = (i: SignedSeatInvitation, secret: Hex): SignedSeatInvitation => {
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(fromHex(secret));
  const order = ed25519.Point.Fn.ORDER;
  const le = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
  const bytes = (n: bigint): Uint8Array => Uint8Array.from({ length: 32 }, (_, k) => Number((n >> BigInt(8 * k)) & 0xffn));
  const r = 0x5eed5eedn;
  const at = ed25519.Point.BASE.multiply(r).toBytes();
  const message = utf8(canonical({ domain: 'confidential-accounts/seat-invitation/v1', terms: i.terms }));
  const k = le(sha512(Uint8Array.from([...at, ...pointBytes, ...message]))) % order;
  return { ...i, signature: toHex(Uint8Array.from([...at, ...bytes((r + k * scalar) % order)])) as Hex };
};

/**
 * A second record under `i`'s id on the network, its invitation naming `role`, its filing and invitation signed by
 * `signer`, and raised under the salt that other invitation makes, as a filer would carry it.
 */
const secondRecordFor = async (i: Awaited<ReturnType<typeof invited>>, name: string, signer: Hex, id: string, o: { signedAgain?: boolean } = {}) => {
  const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === i.proposal.id)!;
  const key = keyOf(KEY as never, rec.keyEpoch);
  const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
  const body = parseCanonical<{ invited: { terms: Record<string, unknown> }; __change?: Record<string, unknown> }>(unseal(env.sealedPayload as never, key));
  const other = o.signedAgain === true ? signedAgain(body.invited as never, signer) : signSeatInvitation({ ...body.invited.terms, name } as never, signer);
  const carried = { ...body, invited: other, __change: { ...body.__change, salt: invitationProposalSalt(other) } };
  const sealed = sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical(carried), key) }, key);
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
    /* RED WHEN: the inviting device raises the proposal under a salt of its own choosing, not the one the invitation makes. */
    expect(eve.offer.byAddress!.proposalSalt).toBe(invitationProposalSalt(eve.offer.invited));
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

  it('RED WHEN: an invitation a removal outran on the chain is approved, though it can never seat anyone', { timeout: 120_000 }, async () => {
    const uma = await invited({ name: 'uma', fill: 77 });
    const bo = seatingDevice(BO);
    const chainId = String(uma.proposal.chainId).toLowerCase();
    const outran = {
      ...bo,
      records: {
        ...bo.records!,
        roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(Object.entries(await bo.records!.roundsOnChain!(ids))
          .map(([id, r]) => [id, id === chainId ? { ...r, outrun: true as const } : r])),
      },
    };
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(outran as never, { viewingKey: KEY, shown: uma.shown }, inviteAddressOf)).rejects.toThrow(InvitationOutrun);
    expect(events.slice(before)).toEqual([]);
  });

  it('the seat taken by address is admitted with nothing read out, and its entry records the coin key it was invited at', async () => {
    const signerId = await seatTaken(EVE, eve);
    /* RED WHEN: a seat taken by address is admitted on a device that cannot hold its coin key to the address's commitment. */
    await expect(admitSignerHere(rosterDoorsOf(ADA), { signerId, readOut: '' })).rejects.toThrow(/cannot check the address/u);
    /* RED WHEN: a coin key that does not make the commitment the invitation names is recorded for the seat. */
    await expect(admitSignerHere({ ...rosterDoorsOf(ADA), commitments: { inviteAddressOf: () => '00'.repeat(32) as Hex } }, { signerId, readOut: '' }))
      .rejects.toThrow(/No proposal of the company's shows which wallet/u);
    /* RED WHEN: a request waiting under another name than the one shown is admitted. */
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: 'mallory' })).rejects.toThrow(/not the one shown/u);
    expect(companyNow().signers.find((x) => x.name === EVE.name)?.status).not.toBe('active');
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: EVE.name });
    /* RED WHEN: the admitted entry does not record the coin key of the address the seat was invited at. */
    expect(companyNow().signers.find((x) => x.name === EVE.name)).toMatchObject({ status: 'active', coinPublicKey: coinKeyAt(addressOf(EVE.fill)) });
    expect(addSignerByAddressIn(eve.proposal, CO, KEY)?.coinPublicKey).toBe(coinKeyAt(addressOf(EVE.fill)));
  });

  it('RED WHEN: a wallet the roster records as seated is invited or approved for a second seat, though the proposals say nothing of it', async () => {
    const ada = seatingDevice(ADA);
    /* The chain shows no seat taken by any proposal asked about. */
    const reads = { ...ada.records, invitedSeats: async (asked: readonly string[]) => Object.fromEntries(asked.map((x) => [x, null])) };
    await expect(addressSeatedOrInvitedRefusal(reads, CO, KEY, inviteAddressOf, coinKeyAt(addressOf(EVE.fill)))).resolves.toBeNull();
    await expect(addressSeatedOrInvitedRefusal({ ...reads, seated: async () => [coinKeyAt(addressOf(EVE.fill))] }, CO, KEY, inviteAddressOf,
      coinKeyAt(addressOf(EVE.fill)))).resolves.toMatch(/that address already has a seat on this company/u);
  });

  it('RED WHEN: a proposal whose invitation gives an approver every right on every vault is approved on another seat\'s device', { timeout: 120_000 }, async () => {
    const yul = await invited(YUL);
    const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === yul.proposal.id)!;
    const key = keyOf(KEY as never, rec.keyEpoch);
    const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
    const body = parseCanonical<{ invited: SignedSeatInvitation; __change?: Record<string, unknown> }>(unseal(env.sealedPayload as never, key));
    /*
     * Ada's seat signs, as it is, an invitation naming the same approver at every right on every vault, which no device
     * of hers would sign, and files it under the proposal its address, those rights and its own salt make.
     */
    const signedBy = signingPublicKeyOf(ADA.signingSecret as Hex);
    const { proposal: _was, ...unbound } = { ...body.invited.terms, invite: { ...body.invited.terms.invite!, scope: MidnightCommitments.allVaults().toLowerCase() as Hex } };
    const salt = invitationProposalSalt({ terms: unbound, signedBy });
    const { chainId } = await seatingDevice(BO).builder.proposalIdentity!(seatByAddressChangeOf(unbound.invite), salt);
    const terms = { ...unbound, proposal: String(chainId).toLowerCase() as Hex };
    const everyRight = { terms, signedBy, signature: sign(seatInvitationMessage(terms), ADA.signingSecret as Hex) };
    const carried = { ...body, invited: everyRight, __change: { ...body.__change, salt } };
    const sealed = sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical(carried), key) }, key);
    const filing = signProposalFiling(CO, { id: 'prp_everyright01', digest: rec.digest, chainId: terms.proposal, keyEpoch: rec.keyEpoch, createdAt: rec.createdAt, sealed } as never,
      ADA.signingSecret as Hex);
    const forged = { ...rec, ...filing, id: 'prp_everyright01' };
    store.putProposal(forged as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    /* RED WHEN: the approving device opens the proposal as one inviting the seat, with rights the approver's role does not give. */
    expect(addSignerByAddressIn(forged as never, CO, KEY)).toBeNull();
    const before = events.length;
    await expect(approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: { ...yul.shown, proposal: 'prp_everyright01', scope: terms.invite.scope } }, inviteAddressOf))
      .rejects.toThrow(/carries an invitation this device does not believe: .*invite the person again at the rights of their role/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: a proposal that invites a wallet the roster records as seated is approved, though it is the one the window showed', { timeout: 120_000 }, async () => {
    /* Eve is seated, and Ada's device invites her address again without its check: the proposal is as shown, and only the approving device can stop it. */
    const again = await invited(EVE, { unchecked: true });
    const before = events.length;
    const refused = await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: again.shown }, inviteAddressOf).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvitationNotBound);
    expect(String((refused as Error).message)).toMatch(/not approved, and nothing was sent: that address already has a seat on this company/u);
    /* RED WHEN: the approving device sends its approval of a second seat for a wallet already seated. */
    expect(events.slice(before)).toEqual([]);
  });

  it('every later version of the roster keeps the coin key a seat was admitted with', { timeout: 120_000 }, async () => {
    const fay = await invited(FAY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: fay.shown }, inviteAddressOf);
    /* Her request carries a coin key of its own, sealed to the company's inbox as anyone can seal one. */
    const signerId = await seatTaken(FAY, fay, { sealed: { coinPublicKey: 'ee'.repeat(32) } });
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: FAY.name });
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

  it('an admission whose entry in the records was lost is entered again from another seat\'s device with the entry its filer signed, and every device reads the roster', { timeout: 120_000 }, async () => {
    const gus = await invited(GUS);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: gus.shown }, inviteAddressOf);
    const signerId = await seatTaken(GUS, gus);
    const lost = { enter: async () => { throw new FiledNotEntered('the connection dropped'); } };
    await expect(admitSignerHere({ ...withCommitments(ADA), entered: lost }, { signerId, readOut: '', name: GUS.name })).rejects.toThrow(FiledNotEntered);
    /* The service holds the admission and the entry Bo's seat signed with it; the records name nothing of it yet. */
    expect(companyNow().signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    /* RED WHEN: only the seat that filed the admission can enter it again, so every other device refuses the roster until that seat acts. */
    const adas = await rosterHere(rosterDoorsOf(ADA));
    expect(adas.followed).toBeNull();
    expect(adas.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    /* RED WHEN: once another device has entered it, the seat that filed the admission refuses the roster. */
    const bos = await rosterHere(rosterDoorsOf(BO));
    expect(bos.opened.signers.find((x) => x.name === GUS.name)?.status).toBe('active');
    expect(coinOf(GUS.name)).toBe(coinKeyAt(addressOf(GUS.fill)));
  });

  it('RED WHEN: a wallet another entry records as seated is admitted to a second seat', { timeout: 120_000 }, async () => {
    /* Ada's device invites Eve's address again without its check; Bo's device approves from the offer, and Eve's wallet takes a second seat. */
    const again = await invited(EVE, { unchecked: true });
    await raiseSeatInvitationOnDevice(seatingDevice(BO), {
      viewingKey: KEY, invited: again.offer.invited, proposalSalt: again.offer.byAddress!.proposalSalt, name: EVE.name,
    });
    const signerId = await seatTaken(EVE, again, { n: 1, person: 'eve-again' });
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: EVE.name }))
      .rejects.toThrow(/already holds a seat on this company, so nobody is seated from it/u);
    expect(companyNow().signers.filter((x) => x.name === EVE.name && x.status === 'active')).toHaveLength(1);
  });

  it('RED WHEN: a seat taken by address is admitted on an invitation other than the one the approved proposal carries, naming a person nobody approved', { timeout: 120_000 }, async () => {
    const hal = await invited(HAL);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: hal.shown }, inviteAddressOf);
    /* Ada's seat signs a second invitation for the same proposal, address, role and rights, naming another person, with a seat secret made for that name, and Hal's request carries it. */
    const renamed = signSeatInvitation({ ...hal.offer.invited.terms, name: 'mallory' }, ADA.signingSecret as Hex);
    const seat = newSeatInvitation(sealingWith(KEY, 0).key, CO, 'mallory', 'approver', renamed.terms.invitation);
    const forged = { ...hal, offer: { ...hal.offer, name: 'mallory', invited: renamed, seat: { nonce: seat.nonce, secret: seat.secret } } };
    const signerId = await seatTaken(HAL, forged, { sealed: { name: 'mallory' } });
    await expect(admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: 'mallory' }))
      .rejects.toThrow(/not the invitation the proposal its seat was approved on carries/u);
    expect(companyNow().signers.find((x) => x.name === 'mallory')?.status).not.toBe('active');
  });

  it('RED WHEN: a record under the approved proposal\'s id, filed and signed by a key that is no seat, stops a seat the approvers approved from being admitted', { timeout: 120_000 }, async () => {
    const ivy = await invited(IVY);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: ivy.shown }, inviteAddressOf);
    const signerId = await seatTaken(IVY, ivy);
    /* The service serves a second record under the same id on the network, its invitation naming another person, filed and signed by a key of nobody's. */
    const { rec, filing } = await secondRecordFor(ivy, 'mallory', toHex(new Uint8Array(32).fill(9)) as Hex, 'prp_decoydecoyde');
    store.putProposal({ ...rec, ...filing, id: 'prp_decoydecoyde', status: 'executed' } as never);
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: IVY.name });
    expect(companyNow().signers.find((x) => x.name === IVY.name)).toMatchObject({ status: 'active' });
  });

  it('a proposal is approved as shown though a seat that may invite files another invitation under its id on the network, which no device believes', { timeout: 120_000 }, async () => {
    const jo = await invited(JO);
    const { rec, filing } = await secondRecordFor(jo, 'mallory', ADA.signingSecret as Hex, 'prp_secondrecord');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecord' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    const bo = seatingDevice(BO);
    /* A device that took every invitation as making the id it names would believe both records. */
    const takesAny = { ...bo, builder: { ...bo.builder, proposalIdentity: async (change: SeatByAddressChange, salt: string) => ({
      ...(await bo.builder.proposalIdentity!(change, salt)), chainId: String(jo.proposal.chainId).toLowerCase() }) } };
    const before = events.length;
    /* RED WHEN: two records the device believes under one id carry different invitations, and the approval is still sent. */
    await expect(approveSeatInvitationOnDevice(takesAny, { viewingKey: KEY, shown: jo.shown }, inviteAddressOf))
      .rejects.toThrow(/Another proposal the company holds under the same id on the network carries another invitation/u);
    expect(events.slice(before)).toEqual([]);
    /* RED WHEN: a record whose invitation does not make the id it is filed under is believed beside the approved one, so the approval is refused for good. */
    const done = await approveSeatInvitationOnDevice(bo, { viewingKey: KEY, shown: jo.shown }, inviteAddressOf);
    expect(done.state).toBe('waiting-for-the-invitee');
    expect(events.slice(before)).toEqual(['chain approve']);
  });

  it('a seat is admitted with the role the approvers approved though, after the network seated it, a seat that may invite files another invitation under its id', { timeout: 120_000 }, async () => {
    const kit = await invited(KIT);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: kit.shown }, inviteAddressOf);
    const signerId = await seatTaken(KIT, kit);
    /* After the network seated Kit, Ada's seat files a second record under the same id, its invitation naming another person. */
    const { rec, filing } = await secondRecordFor(kit, 'mallory', ADA.signingSecret as Hex, 'prp_secondrecor2');
    store.putProposal({ ...rec, ...filing, id: 'prp_secondrecor2', status: 'executed' } as never);
    await ADA.entered.enter([proposalEntry(CO, filing as never)]);
    const doors = withCommitments(ADA);
    const takesAny = { ...doors, reads: { ...doors.reads, proposalIdentity: async (change: SeatByAddressChange, salt: string) => ({
      ...(await acmeReads.proposalIdentity(change, salt)), chainId: String(kit.proposal.chainId).toLowerCase() }) } };
    /* RED WHEN: two invitations believed under the seated id are told apart by a choice, and the person is seated with one of them. */
    await expect(admitSignerHere(takesAny, { signerId, readOut: '', name: KIT.name }))
      .rejects.toThrow(/Two proposals this device believes, each filed and signed by a seat that may invite, carry different invitations/u);
    expect(companyNow().signers.find((x) => x.name === KIT.name)?.status).not.toBe('active');
    /* RED WHEN: a record filed after the seat, whose invitation does not make the seated id, is believed, so the person is never admitted. */
    await admitSignerHere(doors, { signerId, readOut: '', name: KIT.name });
    expect(companyNow().signers.find((x) => x.name === KIT.name)).toMatchObject({ status: 'active' });
  });

  it('RED WHEN: a proposal to seat an address is raised under a salt the inviting seat chose, so its id commits to the address and rights and not to the person and role', { timeout: 120_000 }, async () => {
    const ada = seatingDevice(ADA);
    const { proposal: _id, ...terms } = eve.offer.invited.terms;
    const salt = toHex(new Uint8Array(32).fill(0x5e)) as Hex;
    const { chainId } = await ada.builder.proposalIdentity!(seatByAddressChangeOf(terms.invite!), salt);
    const chosen = signSeatInvitation({ ...terms, invitation: invitationIdOf(toHex(new Uint8Array(32).fill(0x5f)) as Hex), proposal: chainId as Hex }, ADA.signingSecret as Hex);
    /* RED WHEN: the salt leaves out the threshold, the rights or the address, so another invitation naming them differently makes the same proposal. */
    const signedBy = eve.offer.invited.signedBy;
    for (const invite of [{ ...terms.invite!, threshold: '3' }, { ...terms.invite!, scope: '5d'.repeat(32) as Hex }, { ...terms.invite!, address: '5e'.repeat(32) as Hex }]) {
      expect(invitationProposalSalt({ terms: { ...terms, invite }, signedBy })).not.toBe(invitationProposalSalt({ terms, signedBy }));
    }
    /* RED WHEN: the salt leaves out the key that signed the invitation, so any seat that may invite can make the same proposal. */
    expect(invitationProposalSalt({ terms, signedBy: '5f'.repeat(32) as Hex })).not.toBe(invitationProposalSalt({ terms, signedBy }));
    const before = events.length;
    await expect(raiseSeatInvitationOnDevice(ada, {
      viewingKey: KEY, invited: chosen, proposalSalt: salt, name: EVE.name, coinPublicKey: coinKeyAt(addressOf(EVE.fill)),
    }, inviteAddressOf)).rejects.toThrow(/salt this proposal is raised under is not the one its invitation makes/u);
    /* RED WHEN: an invitation raised under its own salt is raised though it names another proposal than its change and that salt make. */
    const misnamed = signSeatInvitation({ ...eve.offer.invited.terms, proposal: 'ab'.repeat(32) as Hex }, ADA.signingSecret as Hex);
    await expect(raiseSeatInvitationOnDevice(ada, {
      viewingKey: KEY, invited: misnamed, proposalSalt: eve.offer.byAddress!.proposalSalt, name: EVE.name, coinPublicKey: coinKeyAt(addressOf(EVE.fill)),
    }, inviteAddressOf)).rejects.toThrow(/not the one its address, rights, threshold and salt make/u);
    expect(events.slice(before)).toEqual([]);
  });

  it('RED WHEN: an invitation by address taken up again raises another seat\'s record for the same address and rights, naming another person, in place of its own', { timeout: 120_000 }, async () => {
    const coin = coinKeyAt(addressOf(VAL.fill));
    const addressSalt = toHex(new Uint8Array(32).fill(0x6a)) as Hex;
    const invite = { address: inviteAddressOf(coin, addressSalt).toLowerCase() as Hex, salt: addressSalt, scope: scopeOfRole('approver') };
    const made = async (s: Seat, name: string, fill: number) => {
      const terms = { company: CO, invitation: invitationIdOf(toHex(new Uint8Array(32).fill(fill)) as Hex), person: `adr_${fill}`, name, role: 'approver' as const, invite };
      const proposalSalt = invitationProposalSalt({ terms, signedBy: signingPublicKeyOf(s.signingSecret as Hex) });
      const { chainId } = await seatingDevice(s).builder.proposalIdentity!(seatByAddressChangeOf(invite), proposalSalt);
      return { invited: signSeatInvitation({ ...terms, proposal: String(chainId).toLowerCase() as Hex }, s.signingSecret as Hex), proposalSalt };
    };
    /* `s`'s device makes its filing, and the connection drops before the service is reached; the filing is handed back. */
    const filedNotRaised = async (s: Seat, x: Awaited<ReturnType<typeof made>>): Promise<{ id: string }> => {
      const device = seatingDevice(s);
      let filed: { id: string } | null = null;
      const dropped = { ...device, service: { ...device.service, file: async (_account: string, body: { proposal: { id: string } }) => {
        filed = body.proposal;
        throw new Error('the connection dropped');
      } } };
      await expect(raiseSeatInvitationOnDevice(dropped as never, { viewingKey: KEY, ...x, name: VAL.name, coinPublicKey: coin }, inviteAddressOf))
        .rejects.toThrow(/connection dropped/u);
      return filed!;
    };
    const adas = await made(ADA, VAL.name, 0x71);
    const first = await filedNotRaised(ADA, adas);
    expect((await fromAda(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify({ proposal: first, salt: adas.proposalSalt }) })).status).toBe(200);
    const held = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === first.id)!;
    /* Another seat's filing of its own invitation for the same address and rights, naming another person, is served beside Ada's, never raised. */
    const bos = await made(BO, 'mallory', 0x72);
    const other = await filedNotRaised(BO, bos);
    store.putProposal({ ...held, ...other, status: 'open' } as never);
    await BO.entered.enter([proposalEntry(CO, other as never)]);
    const done = await raiseSeatInvitationOnDevice(seatingDevice(ADA), { viewingKey: KEY, ...adas, name: VAL.name, coinPublicKey: coin }, inviteAddressOf);
    expect(String(done.round?.chainId).toLowerCase()).toBe(adas.invited.terms.proposal);
  });

  it('a proposal is approved and its seat admitted though the same invitation is filed again under its id with another signature', { timeout: 120_000 }, async () => {
    const wes = await invited(WES);
    const again = await secondRecordFor(wes, WES.name, ADA.signingSecret as Hex, 'prp_signedagain1', { signedAgain: true });
    store.putProposal({ ...again.rec, ...again.filing, id: 'prp_signedagain1' } as never);
    await ADA.entered.enter([proposalEntry(CO, again.filing as never)]);
    const before = events.length;
    /* RED WHEN: two records whose invitations differ only in their signature are told apart, so every approver is refused for good. */
    const done = await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: wes.shown }, inviteAddressOf);
    expect([done.state, events.slice(before)]).toEqual(['waiting-for-the-invitee', ['chain approve']]);
    const signerId = await seatTaken(WES, wes);
    const late = await secondRecordFor(wes, WES.name, ADA.signingSecret as Hex, 'prp_signedagain2', { signedAgain: true });
    store.putProposal({ ...late.rec, ...late.filing, id: 'prp_signedagain2', status: 'executed' } as never);
    await ADA.entered.enter([proposalEntry(CO, late.filing as never)]);
    /* RED WHEN: a copy of the approved invitation signed again, filed after the seat, stops the person from ever being admitted. */
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: WES.name });
    expect(companyNow().signers.find((x) => x.name === WES.name)).toMatchObject({ status: 'active' });
  });

  it('a seat invitation signed again over the same terms is another valid signature', () => {
    const copy = signedAgain(eve.offer.invited, ADA.signingSecret as Hex);
    expect([seatInvitationRefusal(copy), copy.signature === eve.offer.invited.signature]).toEqual([null, false]);
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
    const refused = await admitSignerHere(withCommitments(ADA), { signerId: seated, readOut: '', name: PAT.name }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WaitingIdTaken);
    /* RED WHEN: a roster is filed under an id another entry carries, so Cy's keys sit at Pat's seat and no device can read the roster again. */
    expect((await rosterHere(rosterDoorsOf(ADA))).version).toBe(before);
    expect(companyNow().signers.filter((x) => x.id === seated && x.status === 'active').map((x) => x.leafCommitment?.toLowerCase())).toEqual([CY.seat.toLowerCase()]);
    /* Under the id the service first gave it, the same request is admitted. */
    named(seated, own);
    await admitSignerHere(withCommitments(ADA), { signerId: own, readOut: '', name: PAT.name });
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
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: ROY.name });
    expect(companyNow().signers.find((x) => x.name === ROY.name)?.status).toBe('active');
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('a signer opens the company while a seat taken by address waits for Finish adding, and then admits it', { timeout: 120_000 }, async () => {
    const sam = await invited(SAM);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: sam.shown }, inviteAddressOf);
    const signerId = await seatTaken(SAM, sam);
    const stop = async (o: Parameters<typeof openedOnThePage>[1]) => {
      const e = await openedOnThePage(ADA, o)().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RosterNotBelieved);
      const r = e as RosterNotBelieved;
      return { check: r.check, followable: r.followable, stoppedBy: r.stoppedBy, said: r.message, held: seatingRefusedRead(e) };
    };
    const unread = await stop({ took: async () => { throw new Error('the indexer did not answer'); } });
    /* RED WHEN: a signer's page that cannot read which seat an invitation's proposal took refuses the roster without saying what stopped it. */
    expect(unread.stoppedBy).toContain(SEAT_READ_STOP.notRead);
    /* RED WHEN: a page that could not read the chain refuses the roster as leaving a seat out, sending the signer to ask another device, in place of reading again. */
    expect([unread.check, unread.followable]).toEqual(['chain-unread', null]);
    expect(unread.said).toMatch(/Reload the page to check again/u);
    /* RED WHEN: a wallet that names no indexer is told to read again, which cannot resolve it, in place of what can. */
    const noIndexerRead = await stop({ noIndexer: true });
    /*
     * Every invited seat's leaf is read from the chain, so a wallet that names no indexer stops at the company's own
     * directory, before the roster's seats are counted: the stop says so, and what clears it.
     */
    expect([noIndexerRead.check, noIndexerRead.followable, noIndexerRead.stoppedBy.includes(SEAT_READ_STOP.noIndexer)]).toEqual(['filer-not-checked', null, true]);
    expect([/check its network/u.test(noIndexerRead.said), /to read again|press again/iu.test(noIndexerRead.said)]).toEqual([true, false]);
    /* RED WHEN: two seats taken under one invitation's proposal are told as a read to make again, which never clears it, or the roster is followed past them. */
    const refused = await stop({ took: async () => { throw new SeatingRefusedOnTheChain(TWO_SEATINGS); } });
    expect([refused.check, refused.followable, refused.stoppedBy.includes(SEAT_READ_STOP.refused)]).toEqual(['seating-refused', null, true]);
    expect([/will not change it/u.test(refused.said), /Reload the page/u.test(refused.said)]).toEqual([true, false]);
    /* RED WHEN: the stop drops the seat it could not tell, so the removal that clears it cannot name the seat it may take. */
    const samsSeat = seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase());
    /*
     * The seats it could not tell are every seat the chain holds that no active entry names: Sam's, and any seat an
     * earlier test in this file left taken and never admitted (a second seat for one wallet, a person nobody approved).
     */
    const named = new Set(companyNow().signers.filter((x) => x.status === 'active').map((x) => String(x.leafCommitment).toLowerCase()));
    const leftOut = [...seatsTakenByInvitation.values()].map((leaf) => leaf.toLowerCase()).filter((leaf) => !named.has(leaf));
    expect(leftOut).toContain(samsSeat);
    expect([...(refused.held?.unread ?? [])].sort()).toEqual(leftOut.sort());
    /* RED WHEN: a stop for any other reason carries a read to count a removal from. */
    expect([unread.held, noIndexerRead.held]).toEqual([null, null]);
    /* RED WHEN: a wallet that names no indexer is read as an answer that no invitation's proposal took a seat. */
    const noIndexer = companyJudges({
      api: api(ADA.person), keysFor: () => null, servedKeyFor: () => KEY as Hex, holders: async () => acmeReads.holders() as never, indexer: async () => null,
      builder: async () => ({ invitedSeats: async () => ({}) }) as never, released: () => null, askReleased: async () => null, treeKept: () => treeKeptInMemory() as never,
      openAccount: async () => null, seatsAdmittedFor: async () => new Set(), noAccount: () => { throw new Error('unused'); },
    }).rosterReadsFor(CO, LABEL, '00'.repeat(32) as never).invitedSeats!([sam.offer.invited.terms.proposal!.toLowerCase()]);
    await expect(noIndexer).rejects.toMatchObject({ name: SEAT_READ_STOP.noIndexer });
    /* RED WHEN: a signer's page reads a seat the chain holds, taken on an invitation by address whose request waits for Finish adding, as a seat the roster leaves out. */
    const waiting = await openedOnThePage(ADA)();
    /* RED WHEN: the stop drops the signers it believed, or keeps one a read that does not stop refuses, so the removal that clears it miscounts who approves it. */
    expect(refused.held?.account.signers.filter((x) => x.status === 'active').map((x) => x.name))
      .toEqual(waiting?.signers.filter((x) => x.status === 'active').map((x) => x.name));
    expect(refused.held?.account.signers.length).toBeGreaterThan(0);
    /* RED WHEN: a seat on the chain no believed signer names is not listed as left out by the stop, so a count would go ahead past it. */
    expect(refused.held?.account.notBelieved).toEqual(waiting?.notBelieved);
    expect(waiting?.signers.some((x) => x.name === SAM.name && x.status === 'active')).toBe(false);
    /* RED WHEN: the seat that waits is read as a believed signer, so a committee or a reader list is built from a roster that does not name it. */
    expect(waiting?.notBelieved).toContain(seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase()));
    /* RED WHEN: the company the page opens does not carry the seats its roster read waits for, so the page cannot list them. */
    expect(waiting?.waited).toContain(seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase()));
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

  /* Raises a proposal, approves it and seats a signer through the simulated chain: about 7 s alone, so it has the longest limit this folder uses. */
  it('a signer\'s page whose read of the company\'s proposals, or of the seat an invitation by address took, failed stops in place of reading the seat as left out', { timeout: 120_000 }, async () => {
    const xan = await invited(XAN);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: xan.shown }, inviteAddressOf);
    await seatTaken(XAN, xan);
    const proposal = xan.offer.invited.terms.proposal!.toLowerCase();
    /* The request Xan's wallet filed is not served, so the seat is waited for only through the proposal that seated it. */
    const noRequest = (proposals: (body: unknown) => unknown) => (path: string, body: any) => {
      if (path === `/api/accounts/${CO}`) return { ...body, pendingSigners: [] };
      return path === `/api/accounts/${CO}/proposals` ? proposals(body) : body;
    };
    const stopped = async (o: Parameters<typeof openedOnThePage>[1]) => {
      const e = await openedOnThePage(ADA, o)().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RosterNotBelieved);
      return [(e as RosterNotBelieved).check, (e as RosterNotBelieved).followable, (e as RosterNotBelieved).stoppedBy];
    };
    /* RED WHEN: a read of the company's proposals that failed is taken as no invitation, so the roster is refused as leaving the seat out and followed. */
    expect(await stopped({ served: noRequest(() => { throw new Error('the service answered with an error'); }) })).toEqual(['chain-unread', null, [PROPOSALS_NOT_READ]]);
    /* RED WHEN: a read of the seat the served invitation's proposal took that failed is taken as no seat taken, with no request waiting to say so. */
    const took = async (asked: readonly string[]) => {
      if (asked.includes(proposal)) throw new Error('the indexer did not answer');
      return acmeReads.invitedSeats(asked);
    };
    expect(await stopped({ served: noRequest((body) => body), took })).toEqual(['chain-unread', null, [SEAT_READ_STOP.notRead]]);
    /* Read whole, the seat is waited for. */
    expect((await openedOnThePage(ADA, { served: noRequest((body) => body) })())?.waited).toContain(seatsTakenByInvitation.get(proposal));
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
