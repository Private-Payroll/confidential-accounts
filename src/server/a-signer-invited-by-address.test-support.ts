/**
 * What the cases that invite a signer by address, approve and admit the seat from other seats' devices share: the company as a
 * seat's page opens it, an invitation made and its seat taken by the person's own wallet, a seat seated whole, and a second
 * record filed under an invitation's id.
 */
import { expect } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { addressFor, identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import { canonical, fromHex, parseCanonical, seal, signingPublicKeyOf, toHex, unseal, utf8, type Hex } from '../core/crypto.js';
import { acceptanceProofOf, invitationIdOf, invitationProposalSalt, signSeatInvitation, tokenOfLink, type SignedSeatInvitation, type SignerOffer } from '../core/invitation.js';
import { signProposalFiling } from '../core/proposal-filing.js';
import { openRecord, sealRecord, sealToInbox } from '../core/sealed-records.js';
import { proveSeatKeys } from '../core/seat-invite-proof.js';
import { keyOf } from '../core/company-key.js';
import { seatBlinding } from '../core/seat-opening.js';
import { storedSignerLeaf } from '../core/signer-leaf.js';
import type { PendingSignerPayload, SealedProposal } from '../core/types.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { theNetwork } from '../midnight/network.js';
import { inviteHere } from 'vaults-web-shared/invitation-on-device.js';
import { openInvitationHere } from 'vaults-web-shared/invitation-taken-on-device.js';
import { approveSeatInvitationOnDevice, signerByAddressDoorsOf, type SeatInvitationShown } from 'vaults-web-shared/seat-invited-on-device.js';
import { admitSignerHere } from 'vaults-web-shared/roster-filed-here.js';
import { companyJudges, openAccountWith } from 'vaults-web-shared/company-judges.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { companyViewFor } from 'vaults-web-shared/company-view.js';
import { serviceSource, type ServiceCall } from 'vaults-web-shared/records-source.js';
import { invitedLeafOfTheTestChain } from '../testing/invitation-approved.js';
import { ACME, ORIGIN, acmeReads, fromAda, store } from './a-company-of-two-seats.test-support.js';
import { writesOver } from '../testing/writes-over-a-send.js';
import { ADA, api, BO, CO, committeeKeyOfLeaf, companyNow, deviceOf, ID, KEY, LABEL, rosterDoorsOf, sendAs, theInviteeTakesTheSeatHere, type Seat } from './a-company-whose-signers-change-on-the-chain.test-support.js';

/** A fresh view of the company over `call` for each read the judges make, so every read asks the service as it stands. */
export const freshViews = (call: ServiceCall) => () => companyViewFor(serviceSource(call, CO), {
  holders: async () => acmeReads.holders() as never,
  onChain: async () => { throw new Error('this file reads no anchors on the chain'); },
  builder: { anchorHeads: async () => { throw new Error('this file reads no anchor heads'); } },
}, async () => { throw new Error('this file reads nothing held through a view'); });


export const NETWORK = theNetwork();
export const walletOf = (fill: number) => identityFromSecret(new Uint8Array(32).fill(fill));
export const addressOf = (fill: number): string => addressFor(walletOf(fill).moneyAt(0).zswap, NETWORK as never).bech32;
export const coinKeyAt = (address: string): Hex => String(checkShieldedAddress(address, NETWORK as never).coinPublicKey).toLowerCase() as Hex;
export const inviteAddressOf = (c: Hex, salt: Hex): Hex => MidnightCommitments.inviteAddressOf(c, salt);
export const seatingDevice = (s: Seat) => ({ ...deviceOf(s), roster: rosterDoorsOf(s) });
export const withCommitments = (s: Seat) => ({ ...rosterDoorsOf(s), commitments: MidnightCommitments });
export const EVE = { name: 'eve', fill: 61 };
export const FAY = { name: 'fay', fill: 62 };
export const GUS = { name: 'gus', fill: 64 };
export const HAL = { name: 'hal', fill: 66 };
export const IVY = { name: 'ivy', fill: 70 };
export const JO = { name: 'jo', fill: 71 };
export const KIT = { name: 'kit', fill: 72 };
export const PAT = { name: 'pat', fill: 73 };
export const ROY = { name: 'roy', fill: 74 };
export const SAM = { name: 'sam', fill: 75 };
export const TOM = { name: 'tom', fill: 76 };
export const VAL = { name: 'val', fill: 78 };
export const WES = { name: 'wes', fill: 79 };
export const XAN = { name: 'xan', fill: 80 };
export const YUL = { name: 'yul', fill: 81 };
/*
 * The company as a seat's page opens it: the judges every device reads a company with (`companyJudges`), whose
 * `openedHere` hands the roster read its doors. The wallet's chain reads are this test's chain: the account's holders,
 * the indexer the wallet names, and the seat each invitation's proposal took (`invitedSeats`); a proposal's identity is the
 * account's own (`proposalIdentity`). The anchor and the seat
 * leaves are read as every other device in this file reads them, and the company's key is the one served to the seat.
 * `noIndexer` is a wallet that names no indexer, so the page cannot read which seat an invitation's proposal took;
 * `served` changes what the service answers at a path; `took` changes which seat the chain shows a proposal took.
 */
export const openedOnThePage = (s: Seat, o: {
  noIndexer?: boolean; served?: (path: string, body: any) => unknown; took?: (proposals: readonly string[]) => Promise<Readonly<Record<string, string | null>>>;
} = {}) => {
  const shown = { signerId: ID[s.person]!, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex).toLowerCase() };
  const served = async (path: string, init?: RequestInit) => {
    const body = await api(s.person)(path, init);
    return o.served === undefined ? body : o.served(path, body);
  };
  const doors = { view: freshViews(served), keysFor: (id: string) => (id === CO ? shown : null), servedKeyFor: () => KEY as Hex };
  const judges = companyJudges({
    ...doors,
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
export const servedWithInvitation = async (i: Awaited<ReturnType<typeof invited>>, terms: Record<string, unknown>, signer: Hex) => {
  const rec = (await store.listProposals(CO) as SealedProposal[]).find((p) => p.id === i.proposal.id)!;
  const key = keyOf(KEY as never, rec.keyEpoch);
  const env = openRecord<{ sealedPayload: string }>('proposals', CO, rec.sealed, key);
  const body = parseCanonical<{ invited: { terms: Record<string, unknown> } }>(unseal(env.sealedPayload as never, key));
  const other = signSeatInvitation({ ...body.invited.terms, ...terms } as never, signer);
  return { ...rec, sealed: sealRecord('proposals', CO, { ...env, sealedPayload: seal(canonical({ ...body, invited: other }), key) }, key) };
};

export const coinOf = (name: string) => companyNow().signers.find((x) => x.name === name && x.status === 'active')?.coinPublicKey;

/** Ada's device invites a person by their private address, and the offer the link opens; `unchecked` skips the check for a wallet seated or invited. */
export const invited = async (who: { name: string; fill: number }, o: { unchecked?: boolean } = {}) => {
  const doors = signerByAddressDoorsOf(seatingDevice(ADA), KEY, NETWORK, MidnightCommitments, async () => {});
  const made = await inviteHere(ACME, ADA, 'signer', { name: who.name, role: 'approver', person: 'unused', address: addressOf(who.fill) }, ORIGIN, writesOver(fromAda),
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
export const seatTaken = async (
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
export const signedAgain = (i: SignedSeatInvitation, secret: Hex): SignedSeatInvitation => {
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
export const secondRecordFor = async (i: Awaited<ReturnType<typeof invited>>, name: string, signer: Hex, id: string, o: { signedAgain?: boolean } = {}) => {
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

/** A person invited by address, approved from Bo's device, and seated and admitted from Ada's: the company with that seat in it. */
export const seated = async (who: { name: string; fill: number }) => {
  const made = await invited(who);
  await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: made.shown }, inviteAddressOf);
  const signerId = await seatTaken(who, made);
  await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: who.name });
  return made;
};
