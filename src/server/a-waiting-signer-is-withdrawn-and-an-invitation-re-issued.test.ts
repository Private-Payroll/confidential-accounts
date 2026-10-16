/**
 * **A PERSON WAITING FOR A SEAT IS WITHDRAWN, AND A PERSON WHOSE INVITER LEFT
 * IS GIVEN THEIR INVITATION AGAIN.** The invitation routes are mounted in a
 * throwaway app behind a stand-in for the sign-in and the member gate; the
 * devices are the page's own functions (`invitation-on-device.ts`), talking to
 * it over real HTTP.
 *
 *   · **withdrawn**: a seat request is let go only on a withdrawal signed by a
 *     seat the chain holds now, for that request and the invitation it
 *     answered; the same person can then accept a new invitation. The signing
 *     device refuses first when its own seat may not withdraw anybody, or when
 *     the request could still be seated.
 *   · **re-issued**: a seat that holds one now signs the invitation behind a
 *     seat the chain already holds again, for the same person and leaf; the
 *     person's own device keeps it with that seat as their inviter, so their
 *     wallet keeps the company's account and their own entry is filed again.
 */
import { describe, it, expect } from 'vitest';
import { newSigningKeypair, type Hex } from '../core/crypto.js';
import { SimulatedCommitments } from '../core/ledger.js';
import { openSeatProof, seatOpeningRefusal } from '../core/seat-opening.js';
import {
  alreadyOnTheCompany, invitationIdOf, InvitationNotOpened, newInvitationToken, openOffer, sealOffer, signOffer, signSeatInvitation, signWithdrawal,
  type Inviter, type SignedSeatInvitation,
} from '../core/invitation.js';
import { sealGovernanceProposal, signProposalFiling } from '../core/proposal-filing.js';
import { openFromInbox } from '../core/sealed-records.js';
import { NO_ASSET } from '../core/assets.js';
import type { PendingSignerPayload, SealedProposal } from '../core/types.js';
import { whyTheInvitationDoesNotNameIt } from 'midnight-identity/profile/records-key';
import {
  acceptAsSignerHere, inviteSignerHere, openInvitationHere, reissueInvitationHere, SeatMayNotInvite, takeTheReissueHere,
  withdrawWaitingSignerHere, type InvitationSend,
} from 'vaults-web-shared/invitation-on-device.js';
import { fileTheOwedDirectoryEntry, type OwedDirectoryEntry } from 'vaults-web-shared/vault-page-doors.js';
import { newSeatKeys } from 'vaults-web-shared/accept-seat.js';
import { leafOfTheContract } from '../testing/directory-seats.js';
import {
  aCompanyOfTwoSeats, ACME, ADA, ADDRESS, BO, chains, CO, fromAda, KEY, LABEL, ORIGIN, OTHER, seatOf, sendAs, store, wire, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

/** The key a joiner's wallet gives for the company, the key their seat's leaf commits to. */
const WALLET_KEY = { tag: 'schnorr', value: '5d'.repeat(32) };
/** Every seat the company's account holds now, as the test's chain holds it. */
const onTheChain = (): readonly string[] => chains.get(CO)!.seats.seats;
const asInviter = (s: Seat): Inviter => ({ committeeKey: s.committeeKey, statement: s.statement, opening: s.opening });

/** `person` invited from Ada's device, accepting on their own: their seat request, and the invitation it answered. */
const waitingFor = async (person: string) => {
  const made = await inviteSignerHere(ACME, ADA, { name: person, role: 'approver', person }, ORIGIN, fromAda);
  const opened = await openInvitationHere(made.link, sendAs(null));
  const seat = await acceptAsSignerHere(opened, SimulatedCommitments, {
    newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
  }, sendAs(person), person, async () => WALLET_KEY);
  return { signerId: seat.signerId!, invitation: made.id, link: made.link };
};
const isWaiting = (signerId: string): boolean => store.getAccount(CO)!.pendingSigners.some((p) => p.id === signerId);
/** The leaf a waiting request is for, as the company's key opens it. */
const leafOf = (signerId: string): Hex => openFromInbox<PendingSignerPayload>(
  store.getAccount(CO)!.pendingSigners.find((p) => p.id === signerId)!.sealed, CO, KEY).leafCommitment.toLowerCase() as Hex;
/**
 * A proposal to add a seat, as a seat's device seals and files it: `body` its sealed change, signed over its id on
 * the chain by `filer` (none: a record nobody signed).
 */
const anAddSigner = (body: { signerId: string; invited?: SignedSeatInvitation }, chainId: Hex, filer: Hex | null = ADA.signingSecret): SealedProposal => {
  const sealed = sealGovernanceProposal({
    accountId: CO, viewingKey: KEY, kind: 'add-signer', summary: 'Add a signer', noVault: '00'.repeat(32) as Hex,
    body, change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: '01'.repeat(32) as Hex }, proposedBy: ADA.seat,
  });
  const filing = { id: `prp_${chainId.slice(0, 12)}`, digest: '02'.repeat(32) as Hex, chainId, keyEpoch: 0, createdAt: new Date(0).toISOString(), sealed };
  return { accountId: CO, status: 'open', approvalCount: 0, ...(filer === null ? filing : signProposalFiling(CO, filing, filer)) } as unknown as SealedProposal;
};
const postWithdrawal = (signerId: string, withdrawal: unknown, as: InvitationSend = fromAda, company = CO) =>
  as(`/api/accounts/${company}/signers/${encodeURIComponent(signerId)}/withdraw`, { method: 'POST', body: JSON.stringify({ withdrawal }) });
/** What Ada's device reads to withdraw somebody: the company's inbox, its proposals, and the chain's seats. */
const adasReads = (proposals: readonly SealedProposal[] = [], openOnTheChain: readonly string[] = []) =>
  ({ sealed: store.getAccount(CO)!, proposals, onTheChain: onTheChain(), openOnTheChain });

describe('SOMEBODY WAITING FOR A SEAT IS WITHDRAWN, AND THE SAME PERSON INVITED AGAIN', () => {
  it('the same person accepts a new invitation once their waiting request is withdrawn, and their old link reads as withdrawn', async () => {
    const kit = await waitingFor('kit');
    /* While Kit waits, a new invitation is not Kit's to accept. */
    const again = await inviteSignerHere(ACME, ADA, { name: 'kit', role: 'approver', person: 'kit' }, ORIGIN, fromAda);
    const reopened = await openInvitationHere(again.link, sendAs(null));
    const acceptAgain = () => acceptAsSignerHere(reopened, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {}, promote: async () => {} },
      sendAs('kit'), 'kit', async () => WALLET_KEY);
    await expect(acceptAgain()).rejects.toMatchObject({ refused: 'already-on-this-account' });
    await withdrawWaitingSignerHere({ id: CO, viewingKey: KEY }, ADA, kit.signerId, adasReads(), fromAda);
    /* RED WHEN: a withdrawal is answered and the request is kept, so the person stays locked out. */
    expect(isWaiting(kit.signerId)).toBe(false);
    /* RED WHEN: the link a withdrawn request answered still reads as used rather than withdrawn. */
    await expect(openInvitationHere(kit.link, sendAs(null))).rejects.toMatchObject({ refused: 'withdrawn' });
    /* RED WHEN: a person whose request was withdrawn cannot accept a new invitation. */
    const seat = await acceptAgain();
    expect(isWaiting(seat.signerId!)).toBe(true);
  });

  it('a withdrawal signed by a key whose seat the chain does not hold now withdraws nobody', async () => {
    const lin = await waitingFor('lin');
    const was = chains.get(CO)!;
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [ADA.seat] } });
    try {
      /* RED WHEN: a seat that has left the chain still turns people away. */
      const r = await postWithdrawal(lin.signerId, signWithdrawal({ company: CO, signerId: lin.signerId, invitation: lin.invitation, leaf: leafOf(lin.signerId) }, BO.signingSecret));
      expect([r.status, (r.body as { refused?: string }).refused]).toEqual([403, 'seat-not-seated']);
      /* RED WHEN: a key with no seat in the company's directory turns people away. */
      const stranger = await postWithdrawal(lin.signerId, signWithdrawal({ company: CO, signerId: lin.signerId, invitation: lin.invitation, leaf: leafOf(lin.signerId) }, newSigningKeypair().secret as Hex));
      expect([stranger.status, (stranger.body as { refused?: string }).refused]).toEqual([403, 'no-entry']);
    } finally {
      chains.set(CO, was);
    }
    expect(isWaiting(lin.signerId)).toBe(true);
  });

  it('a withdrawal not signed over this request, this invitation and this company withdraws nobody', async () => {
    const max = await waitingFor('max');
    const pat = await waitingFor('pat');
    const signed = signWithdrawal({ company: CO, signerId: max.signerId, invitation: max.invitation, leaf: leafOf(max.signerId) }, ADA.signingSecret);
    const cases: Array<[string, () => ReturnType<typeof postWithdrawal>, number, string]> = [
      /* RED WHEN: the service believes a withdrawal whose signature does not cover what it names. */
      ['changed after it was signed', () => postWithdrawal(max.signerId, { ...signed, invitation: invitationIdOf(newInvitationToken()) }), 403, 'not-signed'],
      /* RED WHEN: a withdrawal signed for one request lets another go, by its path or by its own field changed. */
      ['for another request', () => postWithdrawal(pat.signerId, signed), 403, 'not-signed'],
      ['with its request changed', () => postWithdrawal(pat.signerId, { ...signed, signerId: pat.signerId }), 403, 'not-signed'],
      /* RED WHEN: the leaf a withdrawal names is not signed, so whoever hands it in names one the chain does not hold. */
      ['with its leaf changed', () => postWithdrawal(max.signerId, { ...signed, leaf: '0c'.repeat(32) }), 403, 'not-signed'],
      /* RED WHEN: a withdrawal a seat signed for another company is handed in for this one. */
      ['signed for another company', () => postWithdrawal(max.signerId, signWithdrawal({ company: OTHER, signerId: max.signerId, invitation: max.invitation, leaf: leafOf(max.signerId) }, ADA.signingSecret)), 403, 'not-signed'],
      /* RED WHEN: a withdrawal signed for one company lets a request of another go. */
      ['for another company', () => postWithdrawal(max.signerId, { ...signed, company: OTHER }), 403, 'not-signed'],
      /* RED WHEN: a withdrawal names an invitation other than the one the request answered, and the service lets it go. */
      ['naming no invitation', () => postWithdrawal(max.signerId, signWithdrawal({ company: CO, signerId: max.signerId, invitation: invitationIdOf(newInvitationToken()), leaf: leafOf(max.signerId) }, ADA.signingSecret)), 409, 'not-its-invitation'],
      ['naming another request\'s invitation', () => postWithdrawal(max.signerId, signWithdrawal({ company: CO, signerId: max.signerId, invitation: pat.invitation, leaf: leafOf(max.signerId) }, ADA.signingSecret)), 409, 'not-its-invitation'],
    ];
    for (const [what, post, status, refused] of cases) {
      const r = await post();
      expect([r.status, (r.body as { refused?: string }).refused], what).toEqual([status, refused]);
    }
    expect([isWaiting(max.signerId), isWaiting(pat.signerId)]).toEqual([true, true]);
    /* RED WHEN: the service lets a request go once its own read of the chain shows that request's leaf seated: nobody could admit them. */
    const was = chains.get(CO)!;
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [...was.seats.seats, leafOf(max.signerId)] } });
    try {
      const r = await postWithdrawal(max.signerId, signed);
      expect([r.status, (r.body as { refused?: string }).refused]).toEqual([409, 'seated-on-the-chain']);
    } finally {
      chains.set(CO, was);
    }
    expect(isWaiting(max.signerId)).toBe(true);
    expect(store.invitationById(pat.invitation)!.revokedAt).toBeUndefined();
  });

  it('a device whose seat may not withdraw anybody, or whose request could still be seated, signs and sends nothing', async () => {
    const ned = await waitingFor('ned');
    const sent = wire.length;
    const withdraw = (seat: Seat, reads = adasReads()) => withdrawWaitingSignerHere({ id: CO, viewingKey: KEY }, seat, ned.signerId, reads, fromAda);
    /* RED WHEN: a viewer's seat, or a retired one, withdraws somebody. */
    await expect(withdraw({ ...ADA, held: { role: 'viewer', retired: false } })).rejects.toThrow(SeatMayNotInvite);
    await expect(withdraw({ ...ADA, held: { role: 'admin', retired: true } })).rejects.toThrow(SeatMayNotInvite);
    /* RED WHEN: a seat the chain no longer holds withdraws somebody. */
    await expect(withdraw(ADA, { ...adasReads(), onTheChain: [BO.seat] })).rejects.toThrow(/not one the company's account holds now/u);
    /* RED WHEN: a person the chain has already seated is withdrawn, leaving a seat nobody can admit. */
    const box = store.getAccount(CO)!.pendingSigners.find((p) => p.id === ned.signerId)!;
    const { openFromInbox } = await import('../core/sealed-records.js');
    const leaf = openFromInbox<{ leafCommitment: string }>(box.sealed, CO, KEY).leafCommitment;
    await expect(withdraw(ADA, { ...adasReads(), onTheChain: [...onTheChain(), leaf] })).rejects.toThrow(/already holds this person's seat/u);
    /* RED WHEN: a person a proposal could still seat is withdrawn while the chain holds that proposal open, approved or not. */
    const chainId = '0f'.repeat(32) as Hex;
    const seating = anAddSigner({ signerId: ned.signerId }, chainId);
    await expect(withdraw(ADA, adasReads([seating], [chainId]))).rejects.toThrow(/proposal to seat this person is still open/u);
    /* RED WHEN: a proposal whose id on the chain no seat signed is taken as closed, so the service's word decides. */
    await expect(withdraw(ADA, adasReads([anAddSigner({ signerId: ned.signerId }, chainId, null)], []))).rejects.toThrow(/proposal to seat this person is still open/u);
    expect(wire.length).toBe(sent);
    expect(isWaiting(ned.signerId)).toBe(true);
    /* A proposal the chain no longer holds open seats nobody, whatever the service says of it: the request is withdrawn. */
    await withdraw(ADA, adasReads([{ ...seating, status: 'open' }], ['1e'.repeat(32)]));
    expect(isWaiting(ned.signerId)).toBe(false);
  });

  it('a seat whose role may not file a proposal invites nobody', async () => {
    const sent = wire.length;
    /* RED WHEN: a viewer's device signs an invitation, which every member's device would refuse anyway. */
    await expect(inviteSignerHere(ACME, { ...ADA, held: { role: 'viewer', retired: false } }, { name: 'oz', role: 'approver', person: 'oz' }, ORIGIN, fromAda))
      .rejects.toThrow(SeatMayNotInvite);
    /* RED WHEN: a device that has not read its own seat's role from the directory invites somebody all the same. */
    const { held: _unread, ...unread } = ADA;
    await expect(inviteSignerHere(ACME, unread, { name: 'oz', role: 'approver', person: 'oz' }, ORIGIN, fromAda)).rejects.toThrow(SeatMayNotInvite);
    expect(wire.length).toBe(sent);
  });

  it('one person waits for one seat: a member, or a person waiting, is already on the company, and nobody once let go', () => {
    const company = { memberUserIds: ['ada'], pendingSigners: [{ userId: 'kit' }, { userId: null }] };
    /* RED WHEN: a person waiting for a seat is taken as not yet on the company, so they could wait twice. */
    expect([alreadyOnTheCompany(company, 'ada'), alreadyOnTheCompany(company, 'kit')]).toEqual([true, true]);
    expect(alreadyOnTheCompany({ ...company, pendingSigners: [] }, 'kit')).toBe(false);
  });
});

describe('A PERSON WHOSE INVITER LEFT IS GIVEN THEIR INVITATION AGAIN', () => {
  /* Lee was invited by Bo and the chain seated Lee's leaf; Bo has left, so the account holds Ada and Lee. */
  const LEE = seatOf('lee', 7, LABEL, ADDRESS, CO, BO);
  const original: SignedSeatInvitation = signSeatInvitation({
    company: CO, invitation: invitationIdOf(newInvitationToken()), person: 'lee', name: 'lee', role: 'approver', leaf: LEE.seat as Hex,
  }, BO.signingSecret);
  const leesChain = [ADA.seat, LEE.seat];
  /** The company's proposals: the one that seated Lee carries the invitation the signers approved for his leaf. */
  const seatedLee = [anAddSigner({ signerId: 'sgn_lee', invited: original }, '0e'.repeat(32) as Hex)];
  const replacing = { invitation: original.terms.invitation, signedBy: original.signedBy, signature: original.signature };
  /** Lee's device taking a re-issue, with the company's proposals it reads. */
  const leeTakes = (opened: Parameters<typeof takeTheReissueHere>[0], kept: unknown[], proposals: readonly SealedProposal[] = seatedLee,
    mine: { accountId: string; person: string; seat: string } = { accountId: CO, person: 'lee', seat: LEE.seat }) =>
    takeTheReissueHere(opened, { ...mine, viewingKey: KEY }, proposals, async (x) => { kept.push(x); });
  /** Lee's wallet, judging the inviter it is handed against the account as it reads it. */
  const leesWallet = (invitedBy: Inviter) => whyTheInvitationDoesNotNameIt(
    { kind: 'records-key', company: LABEL, account: ADDRESS, seat: LEE.seat, invitedBy } as never,
    { committee: [], threshold: 1, seats: leesChain }, leafOfTheContract,
  );

  it('re-issued by a seat that holds one now, it is kept on the person\'s device with that seat as their inviter, and their wallet keeps the account', async () => {
    /* RED WHEN: an inviter who has left is accepted by the person's wallet: it would keep an account on a seat nobody holds. */
    expect(leesWallet(asInviter(BO))).toBe('inviter-not-on-account');
    const made = await reissueInvitationHere(ACME, ADA, { leaf: LEE.seat as Hex, proposals: seatedLee, onTheChain: leesChain }, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs('lee'));
    const kept: Array<{ inviter: Inviter; invited: SignedSeatInvitation }> = [];
    await leeTakes(opened, kept);
    /* RED WHEN: the device keeps the new invitation without the seat that signed it, or the other way round. */
    expect(kept).toHaveLength(1);
    expect(kept[0]!.inviter).toEqual(asInviter(ADA));
    expect(kept[0]!.invited.signedBy).toBe(ADA.statement.signingKey);
    /* RED WHEN: a re-issue changes who the seat is for, their name, their role or their leaf. */
    expect(kept[0]!.invited.terms).toEqual({ ...original.terms, invitation: made.id, replaces: replacing });
    /* RED WHEN: the person's wallet still refuses after the re-issue, so they stay locked out. */
    expect(leesWallet(kept[0]!.inviter)).toBeNull();
    /* A re-issue offers no new seat: the link makes no seat request. */
    await expect(acceptAsSignerHere(opened, SimulatedCommitments, { newKeys: newSeatKeys, seal: async () => {}, promote: async () => {} },
      sendAs('lee'), 'lee', async () => WALLET_KEY)).rejects.toThrow(/offers pay, not a seat|not accepted as a signer/u);
  });

  it('a re-issue is refused for a seat that may not invite, a seat the chain does not hold, or an invitation for no seat, and nothing is sent', async () => {
    const sent = wire.length;
    const reissue = (seat: Seat, inv: SignedSeatInvitation = original, chain: readonly string[] = leesChain, also: readonly SealedProposal[] = []) =>
      reissueInvitationHere(ACME, seat, { leaf: LEE.seat as Hex, proposals: [anAddSigner({ signerId: 'sgn_lee', invited: inv }, '0e'.repeat(32) as Hex), ...also], onTheChain: chain }, ORIGIN, fromAda);
    /* RED WHEN: a viewer's seat or a retired one re-issues an invitation. */
    await expect(reissue({ ...ADA, held: { role: 'viewer', retired: false } })).rejects.toThrow(SeatMayNotInvite);
    await expect(reissue({ ...ADA, held: { role: 'admin', retired: true } })).rejects.toThrow(SeatMayNotInvite);
    /* RED WHEN: an invitation is re-issued for a leaf the chain does not hold: somebody waiting is withdrawn and invited again instead. */
    await expect(reissue(ADA, original, [ADA.seat])).rejects.toThrow(/not one the company's account holds now/u);
    /* RED WHEN: an invitation naming no seat, or another company's, is re-issued, so it could seat whoever holds the link. */
    const { leaf: _none, ...noLeaf } = original.terms;
    await expect(reissue(ADA, signSeatInvitation(noLeaf, BO.signingSecret))).rejects.toThrow(SeatMayNotInvite);
    await expect(reissue(ADA, signSeatInvitation({ ...original.terms, company: OTHER }, BO.signingSecret))).rejects.toThrow(SeatMayNotInvite);
    /*
     * RED WHEN: the invitation re-issued is whichever the service lists first, when the proposals carry two for the leaf:
     * a record anybody holding the company's key seals could then name the role.
     */
    const asAdmin = signSeatInvitation({ ...original.terms, role: 'admin' }, BO.signingSecret);
    await expect(reissue(ADA, asAdmin, leesChain, [anAddSigner({ signerId: 'sgn_lee', invited: original }, '0d'.repeat(32) as Hex)])).rejects.toThrow(/No one invitation/u);
    expect(wire.length).toBe(sent);
  });

  it('a re-issue is kept only for the person signed in and the seat this device holds, and only under its own link', async () => {
    const made = await reissueInvitationHere(ACME, ADA, { leaf: LEE.seat as Hex, proposals: seatedLee, onTheChain: leesChain }, ORIGIN, fromAda);
    const opened = await openInvitationHere(made.link, sendAs('lee'));
    const kept: unknown[] = [];
    const take = (mine: { accountId: string; person: string; seat: string }) => leeTakes(opened, kept, seatedLee, mine);
    /* RED WHEN: a re-issue is kept by somebody else signed in, for another seat, or for another company. */
    await expect(take({ accountId: CO, person: 'mallory', seat: LEE.seat })).rejects.toThrow(/for somebody else/u);
    await expect(take({ accountId: CO, person: 'lee', seat: ADA.seat })).rejects.toThrow(/another seat/u);
    await expect(take({ accountId: OTHER, person: 'lee', seat: LEE.seat })).rejects.toThrow(/for somebody else, or another company/u);
    expect(kept).toEqual([]);
    /* RED WHEN: a re-issue signed for one link is opened under another, or one naming no seat opens at all. */
    const token = newInvitationToken();
    const offerOf = (invited: SignedSeatInvitation) => sealOffer(signOffer({
      company: CO, companyName: 'Acme', label: LABEL, account: ADDRESS, inboxPublicKey: ACME.inboxPublicKey,
      for: { kind: 'reissue', name: invited.terms.name, role: invited.terms.role, invited }, inviter: asInviter(ADA),
    }, ADA.signingSecret), token);
    expect(() => openOffer(offerOf(signSeatInvitation({ ...original.terms, invitation: invitationIdOf(newInvitationToken()) }, ADA.signingSecret)), token)).toThrow(InvitationNotOpened);
    const { leaf: _none, ...noLeaf } = original.terms;
    expect(() => openOffer(offerOf(signSeatInvitation({ ...noLeaf, invitation: invitationIdOf(token) }, ADA.signingSecret)), token)).toThrow(InvitationNotOpened);
    expect(openOffer(offerOf(signSeatInvitation({ ...original.terms, invitation: invitationIdOf(token) }, ADA.signingSecret)), token).offer.for.kind).toBe('reissue');
    /* RED WHEN: Lee's device keeps a re-issue that gives his seat another role, or replaces no invitation, than the one his seat was proposed under. */
    const openedAs = (terms: Parameters<typeof signSeatInvitation>[0]) =>
      ({ token, signed: openOffer(offerOf(signSeatInvitation({ ...terms, invitation: invitationIdOf(token) }, ADA.signingSecret)), token), expiresAt: '' });
    await expect(leeTakes(openedAs({ ...original.terms, role: 'admin', replaces: replacing }), kept)).rejects.toThrow(/not the one your seat was proposed under/u);
    await expect(leeTakes(openedAs({ ...original.terms }), kept)).rejects.toThrow(/not the one your seat was proposed under/u);
    /* RED WHEN: Lee's device holds a re-issue to whichever invitation the service lists first, where two name his seat. */
    const twice = [...seatedLee, anAddSigner({ signerId: 'sgn_lee', invited: signSeatInvitation({ ...original.terms, role: 'admin' }, BO.signingSecret) }, '0d'.repeat(32) as Hex)];
    await expect(leeTakes(openedAs({ ...original.terms, replaces: replacing }), kept, twice)).rejects.toThrow(/not the one your seat was proposed under/u);
    expect(kept).toEqual([]);
    await leeTakes(openedAs({ ...original.terms, replaces: replacing }), kept);
    expect(kept).toHaveLength(1);
  });

  it('the person\'s own entry, filed under the invitation of an inviter who left, is filed again under the re-issued one', async () => {
    const reissued = signSeatInvitation({ ...original.terms, invitation: invitationIdOf(newInvitationToken()) }, ADA.signingSecret);
    const filedBefore = { company: CO, version: 1, change: { kind: 'claim' as const, entry: LEE.entry } };
    const put: Array<{ version: number; change: { entry: { proof: unknown } } }> = [];
    const api = async (path: string, init?: RequestInit): Promise<unknown> => {
      if (init?.method === 'PUT') { put.push(JSON.parse(String(init.body))); return {}; }
      if (path.endsWith('/directory')) return { filings: [filedBefore] };
      throw new Error(`this device asked the service for ${path}`);
    };
    expect(seatOpeningRefusal(LEE.opening)).toBeNull();
    const owedWith = (invited: SignedSeatInvitation): OwedDirectoryEntry => ({
      person: 'lee', company: LABEL, signed: { committeeKey: LEE.committeeKey, entry: LEE.statement }, opening: LEE.opening, invited,
    });
    const fileWith = (invited: SignedSeatInvitation) => {
      let owed: OwedDirectoryEntry | null = owedWith(invited);
      return fileTheOwedDirectoryEntry(api, CO, { read: () => owed, settle: async () => { owed = null; } },
        async () => ({ signingSecret: LEE.signingSecret, viewingKey: KEY }), async () => ADA.seat);
    };
    /* The entry already filed, carrying the invitation it was filed with, is left alone. */
    const filedWith = openSeatProof(CO, LEE.entry.proof, KEY)!.invited!;
    expect(await fileWith(filedWith)).toBe('already-there');
    expect(put).toEqual([]);
    /* RED WHEN: an entry already filed under another invitation is taken as filed, so it is never believed under the re-issued one. */
    expect(await fileWith(reissued)).toBe('filed');
    expect(put.map((f) => f.version)).toEqual([2]);
    expect(openSeatProof(CO, put[0]!.change.entry.proof as never, KEY)!.invited).toEqual(reissued);
  });
});
