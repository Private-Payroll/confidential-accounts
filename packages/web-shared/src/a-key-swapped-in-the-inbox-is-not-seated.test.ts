/**
 * **A KEY PUT IN THE COMPANY'S INBOX BY ANYBODY BUT THE INVITED PERSON IS
 * REFUSED BY EVERY SIGNER'S DEVICE, BY NAME, BEFORE ANYTHING IS PROVED.**
 *
 * A person waiting for a seat is read from the company's inbox, and the inbox
 * is sealed to a public key: whoever can write to the store can seal a new
 * entry to it without holding the viewing key. What is written here is exactly
 * that writer: it holds the stored record and nothing else, replaces what the
 * invited person sent, and every reading a device makes of the seat - to raise
 * it, to approve it, to carry it out - is asked what it does with it.
 *
 * The honest entry is read first, through the same doors, so a refusal below is
 * a refusal of the swap and not of every seat.
 */
import { enteredHere } from '../../../src/testing/records-entered.js';
import { describe, it, expect } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from '../../../src/core/ledger.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { FileStore } from '../../../src/core/store-file.js';
import { AccountService, approvalMessage } from '../../../src/core/account.js';
import { newBlinding, newSigningKeypair, newSymmetricKey, newWrappingKeypair, sign, signingPublicKeyOf, unwrapKey, type Hex } from '../../../src/core/crypto.js';
import { answerDigestOf, type SealedAnswer } from '../../../src/core/answer-opened.js';
import type { CompanyKeys } from '../../../src/core/company-key.js';
import { sealGovernanceProposal } from '../../../src/core/proposal-filing.js';
import { openAccount } from '../../../src/core/account.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { inboxPublicKey, sealToInbox } from '../../../src/core/sealed-records.js';
import { storedSignerLeaf } from '../../../src/core/signer-leaf.js';
import { newSeatInvitation, proveSeatKeys, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import { seatBlinding, type SeatOpening } from '../../../src/core/seat-opening.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation, type SeatInvitationTerms } from '../../../src/core/invitation.js';
import type { PendingSignerPayload } from '../../../src/core/types.js';
import { directoryHere } from './vault-page-doors.js';
import { seatRequestFingerprint } from './invitation-on-device.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import type { GovernedCallOrder, OpenedRound } from './governed-call-builder.js';
import {
  approveOnDevice, openTheRoundHere, seatSignerOnDevice, type GovernedCallDoors, type GovernedCallService,
} from './governed-call-on-device.js';
import { refuseASeatNotForTheInvited, rosterBelievedHere, seatingOf, waitingHere, type RosterDoors, type RosterReads } from './roster-here.js';
import type { DirectoryWitness } from '../../../src/core/roster-record.js';
import { aRosterASeatFiled } from '../../../src/testing/a-roster-a-seat-filed.js';

const scope = MidnightCommitments.allVaults();
/** A joiner's keys, their leaf made for a wallet key of their own under a fresh salt, and the opening that shows it. */
const keysOf = (walletKey = { tag: 'schnorr', value: newBlinding() }) => {
  const s = newSigningKeypair();
  const w = newWrappingKeypair();
  const salt = newBlinding();
  const blinding = seatBlinding(walletKey, salt) as Hex;
  const opening: SeatOpening = { publicKey: MidnightCommitments.signerPublicKey(s.secret).toLowerCase(), scope: scope.toLowerCase(), blinding, walletKey, salt };
  return {
    signingPublicKey: s.publicKey, wrappingPublicKey: w.publicKey,
    leafCommitment: storedSignerLeaf({ signingSecret: s.secret, blinding, scope }, MidnightCommitments),
    opening,
  };
};

const ledger = new SimulatedLedger(MidnightCommitments);
const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-swapped-')), 'db.json'));
const accounts = new AccountService(store, ledger, MidnightCommitments);
/* Two signers, so two devices each read the seat for themselves. */
const created = await accounts.create('Swapped', [{ name: 'Ada', role: 'admin', userId: 'ada' }, { name: 'Bo', role: 'approver', userId: 'bo' }], 1, undefined, drawCompanyLabel());
const company = created.account.id;
const viewingKey = created.viewingKey;
const [ada, bo] = created.secrets as [typeof created.secrets[0], typeof created.secrets[0]];

/* Dana is invited, and accepts on her own device with the proof her link let it make. */
const invite = accounts.inviteSigner(company, 'Dana', 'dana@swapped.example', 'approver');
const dana = keysOf();
const danaProof = proveSeatKeys(newSeatInvitation(viewingKey, company, 'Dana', 'approver'), dana);
const waiting = accounts.acceptSignerInvite(invite.token, 'usr_dana', dana.signingPublicKey, dana.wrappingPublicKey,
  dana.leafCommitment, danaProof);
/* Who the seat is for, as Ada's seat signed it when it invited Dana. */
const DANAS_INVITATION: SeatInvitationTerms = {
  company, invitation: invitationIdOf(newInvitationToken()), person: 'usr_dana', name: 'Dana', role: 'approver',
};
/** Dana's seat request as her device seals it: her keys, their proof and opening, her sign-in, and the invitation behind it. */
const danasRequest = (): PendingSignerPayload => ({
  name: 'Dana', role: 'approver', ...dana, seatProof: danaProof, person: 'usr_dana',
  invited: signSeatInvitation(DANAS_INVITATION, ada.signingSecret as Hex),
});
{
  const rec = store.getAccount(company)!;
  store.putAccount({ ...rec, pendingSigners: rec.pendingSigners.map((p) => (p.id === waiting.id ? { ...p, sealed: sealToInbox(danasRequest(), rec.inboxPublicKey) } : p)) });
}
const seatRound = await accounts.seatRound(company, viewingKey, waiting.id, ada.signerId);
/* Ada's and Bo's devices read the signers from a roster record Ada's seat filed, believed by entries their wallets signed. */
const filed = aRosterASeatFiled(store, company, viewingKey as Hex, [
  { signerId: ada.signerId, person: 'ada', signingSecret: ada.signingSecret, n: 1 },
  { signerId: bo.signerId, person: 'bo', signingSecret: bo.signingSecret, n: 2 },
]);
const honestRecord = structuredClone(store.getAccount(company)!);
/** The roster doors of Ada's device, over what the service holds now. */
const adasRoster = (api: RosterDoors['api']): RosterDoors => ({
  api, accountId: company, viewingKey: viewingKey as Hex, signingSecret: ada.signingSecret as Hex,
  label: honestRecord.companyLabel as never, account: honestRecord.contractAddress as never, reads: filed.reads,
  entered: filed.records.enteredBy(ada.signingSecret as Hex),
});

/** A writer with the stored record and nothing else: it seals a new entry to the inbox's public key. */
const swapInTheInbox = (payload: Partial<PendingSignerPayload>) => {
  const rec = structuredClone(honestRecord);
  const box = rec.pendingSigners.find((p) => p.id === waiting.id)!;
  box.sealed = sealToInbox({ name: 'Dana', role: 'approver', ...payload }, rec.inboxPublicKey);
  store.putAccount(rec);
};
const putBack = () => store.putAccount(structuredClone(honestRecord));

/** The company's directory as a member's device believes it, read afresh each time, with the chain as its wallet reads it. */
const recordsHere = {
  directory: (asked?: Parameters<typeof directoryHere>[1]) => directoryHere({
    accountId: company, label: honestRecord.companyLabel as never, viewingKey: viewingKey as Hex, ...filed.reads, attested: async () => [],
  }, asked),
} as unknown as CompanyRecordsHere;
const leaves = filed.reads.leaves;

const service = (built: unknown[] = []): GovernedCallService => ({
  sealedProposals: async (id: string) => store.listProposals(id),
  sealedAccount: async (id: string) => ({ ...store.getAccount(id), roster: filed.roster }),
  /* No approval counted when the approval is asked for, one once it has been built and sent. */
  standing: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: 'open', approvalCount: built.length ? 1 : 0 }),
  callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
  approve: async () => ({ id: seatRound.id, chainId: seatRound.chainId, status: 'open', approvalCount: 1 }),
} as unknown as GovernedCallService);

/** One signer's device. Whatever it builds - and so proves - is written down. */
const aDevice = (built: Array<{ order: GovernedCallOrder; opened: OpenedRound }>): GovernedCallDoors => ({
  service: service(built),
  builder: { governedCall: async ({ order, opened }) => { built.push({ order, opened }); return { tx: 'TX' }; } },
  material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
  accountId: company, sleep: async () => {}, waitMs: 2, everyMs: 1, records: recordsHere, leaves,
});
const shown = { id: seatRound.id, chainId: seatRound.chainId, status: 'open', summary: seatRound.summary };

/** Every reading of the seat a device makes: to raise it, to approve it, to carry it out. */
const everyReading = async (_signerId: string) => {
  const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
  const outcomes = await Promise.allSettled([
    openTheRoundHere(service(), company, seatRound.id, viewingKey, true, recordsHere, leaves),
    openTheRoundHere(service(), company, seatRound.id, viewingKey, false, recordsHere, leaves),
    approveOnDevice(aDevice(built), { round: shown, viewingKey }),
  ]);
  return { outcomes, built };
};

describe('A KEY THAT DID NOT COME FROM THE INVITED PERSON IS NOT SEATED', () => {
  it('the honest entry is read by every device, and its leaf is the one Dana sent', async () => {
    putBack();
    for (const signer of [ada, bo]) {
      const { outcomes, built } = await everyReading(signer.signerId);
      /* RED WHEN: the check refuses an honest invitation - nobody could then be seated at all. */
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      expect((outcomes[0] as PromiseFulfilledResult<OpenedRound>).value.governance)
        .toEqual({ kind: 'add-signer', leaf: dana.leafCommitment });
      /* The plain approval reads the honest entry and then leaves the seat to be approved where it is made. */
      expect(String((outcomes[2] as PromiseRejectedResult).reason?.message)).toMatch(/approved where it is made/u);
      expect(built).toEqual([]);
    }
  });

  it.each([
    ['keys of the writer\'s own, with no proof', () => ({ ...keysOf() })],
    ['keys of the writer\'s own, beside the proof Dana made', () => ({ ...keysOf(), seatProof: danaProof })],
    ['Dana\'s signing key and leaf, with the writer\'s own wrapping key', () => ({
      ...dana, wrappingPublicKey: newWrappingKeypair().publicKey, seatProof: danaProof })],
    ['Dana\'s own keys and proof, with her role raised to admin', () => ({ ...dana, role: 'admin' as const, seatProof: danaProof })],
    ['Dana\'s signing key, wrapping key and proof, with the writer\'s own leaf', () => ({
      ...dana, leafCommitment: keysOf().leafCommitment, seatProof: danaProof })],
    ['the writer\'s own signing key beside Dana\'s wrapping key, leaf and proof', () => ({
      ...dana, signingPublicKey: keysOf().signingPublicKey, seatProof: danaProof })],
    ['Dana\'s own keys and proof, under another name', () => ({ ...dana, name: 'Mallory', seatProof: danaProof })],
    ['Dana\'s own keys and proof, with the nonce of another invitation', () => ({
      ...dana, seatProof: { nonce: newSeatInvitation(viewingKey, company, 'Dana', 'approver').nonce, proof: danaProof.proof } })],
    ['keys with a proof made under a key the writer chose', () => {
      const k = keysOf();
      return { ...k, seatProof: proveSeatKeys(newSeatInvitation('ab'.repeat(32), company, 'Dana', 'approver'), k) };
    }],
  ] as Array<[string, () => Partial<PendingSignerPayload>]>)('%s: refused on every device, by name, and nothing is proved', async (_what, swapped) => {
    swapInTheInbox(swapped());
    try {
      for (const signer of [ada, bo]) {
        const { outcomes, built } = await everyReading(signer.signerId);
        /* RED WHEN: any reading of the seat takes a key the invited person's link did not prove. */
        for (const o of outcomes) {
          expect(o.status).toBe('rejected');
          expect((o as PromiseRejectedResult).reason).toBeInstanceOf(SeatKeyNotFromTheInvitee);
          expect((o as PromiseRejectedResult).reason.name).toBe('SeatKeyNotFromTheInvitee');
        }
        /* RED WHEN: the refusal comes after a call was built - the swapped key would then have been proved. */
        expect(built).toEqual([]);
      }
    } finally {
      putBack();
    }
  });

  it('a device that seats the person refuses the swapped key before it raises, approves, carries out or admits anything', async () => {
    const swapped = keysOf();
    swapInTheInbox(swapped);
    try {
      const asked: string[] = [];
      const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
      const doors = aDevice(built);
      const roster = adasRoster(async (path: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === `/api/accounts/${company}`) return { ...store.getAccount(company), roster: filed.roster };
        throw new Error(`this device asked the service for ${path}`);
      });
      const out = seatSignerOnDevice({
        ...doors, roster, filing: { seat: '41'.repeat(32), keyEpoch: 0, salt: () => '66'.repeat(32), newId: () => 'prp_swappedseat1', entered: enteredHere() },
        approvers: async () => { throw new Error('the vault check was reached'); }, vaultName: (v) => v,
      }, { viewingKey, signerId: waiting.id, readOut: 'read out by Dana' });
      /* RED WHEN: the device raises, approves, carries out or admits a seat before it has checked the key in the inbox. */
      await expect(out).rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
      expect(built).toEqual([]);
      expect(asked).toEqual([`GET /api/accounts/${company}`]);
    } finally {
      putBack();
    }
  });

  it('a copy of an honest entry beside it is refused: one person\'s keys are not two seats', async () => {
    const rec = structuredClone(honestRecord);
    const original = rec.pendingSigners.find((p) => p.id === waiting.id)!;
    rec.pendingSigners.push({ ...original, id: 'sgn_copy', userId: 'usr_copy' });
    store.putAccount(rec);
    try {
      /* RED WHEN: the same keys waiting twice are each read as a person to seat. */
      await expect(openTheRoundHere(service(), company, seatRound.id, viewingKey, true, recordsHere, leaves))
        .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
      /* RED WHEN: the device that seats a person takes the copy's keys as a second person's, before anything is built. */
      const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
      const roster = adasRoster(async (path: string) => {
        if (path === `/api/accounts/${company}`) return { ...store.getAccount(company), roster: filed.roster };
        throw new Error(path);
      });
      await expect(seatSignerOnDevice({
        ...aDevice(built), roster, filing: { seat: '41'.repeat(32), keyEpoch: 0, salt: () => '66'.repeat(32), newId: () => 'prp_copiedseat01', entered: enteredHere() },
        approvers: async () => { throw new Error('the vault check was reached'); }, vaultName: (v) => v,
      }, { viewingKey, signerId: 'sgn_copy', readOut: 'read out by Dana' })).rejects.toThrow(/already belong to another signer/u);
      expect(built).toEqual([]);
    } finally {
      putBack();
    }
  });
});

/* ── A SEAT GOES TO THE PERSON INVITED, AND ITS LEAF TO THEIR WALLET ── */

/** Dana's box holding `request` under the sign-in `userId`, with any other requests beside it. */
const inTheInbox = (request: PendingSignerPayload, userId = 'usr_dana', others: ReadonlyArray<{ id: string; userId: string; request: PendingSignerPayload }> = []) => {
  const rec = structuredClone(honestRecord);
  const box = rec.pendingSigners.find((p) => p.id === waiting.id)!;
  box.sealed = sealToInbox(request, rec.inboxPublicKey);
  box.userId = userId;
  for (const o of others) rec.pendingSigners.push({ id: o.id, userId: o.userId, createdAt: box.createdAt, sealed: sealToInbox(o.request, rec.inboxPublicKey) });
  store.putAccount(rec);
};

/**
 * The device that seats Dana, with the read-out she gives: everything it checks
 * runs before it reads the company's records, so a records read that throws
 * says every check passed.
 */
const seatingDevice = (request: PendingSignerPayload) => {
  const built: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
  const roster = adasRoster(async (path: string) => {
    if (path === `/api/accounts/${company}`) return { ...store.getAccount(company), roster: filed.roster };
    throw new Error(`this device asked the service for ${path}`);
  });
  const out = seatSignerOnDevice({
    ...aDevice(built), records: { directory: async () => { throw new Error('every check passed'); } } as unknown as CompanyRecordsHere,
    roster, filing: { seat: '41'.repeat(32), keyEpoch: 0, salt: () => '66'.repeat(32), newId: () => 'prp_invitedseat1', entered: enteredHere() },
    approvers: async () => { throw new Error('the vault check was reached'); }, vaultName: (v) => v,
  }, { viewingKey, signerId: waiting.id, readOut: seatRequestFingerprint(request) });
  return { out, built };
};

/** Every reading of Dana's seat refuses, each opening of the proposal saying `says`, and nothing is built. */
const refusedOnEveryReading = async (request: PendingSignerPayload, says: RegExp, seatSays: RegExp = says) => {
  const { outcomes, built } = await everyReading(waiting.id);
  for (const o of outcomes) {
    expect(o.status).toBe('rejected');
    expect((o as PromiseRejectedResult).reason).toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(String((o as PromiseRejectedResult).reason.message)).toMatch(says);
  }
  expect(built).toEqual([]);
  const seat = seatingDevice(request);
  await expect(seat.out).rejects.toThrow(seatSays);
  expect(seat.built).toEqual([]);
};

describe('A SEAT GOES TO THE PERSON INVITED, AND ITS LEAF TO THE WALLET IT IS MADE FOR', () => {
  it('the honest request, and one whose invitation names its own leaf, pass every check a device makes before it approves the leaf', async () => {
    try {
      for (const request of [danasRequest(), { ...danasRequest(), invited: signSeatInvitation({ ...DANAS_INVITATION, leaf: dana.leafCommitment }, ada.signingSecret as Hex) }]) {
        inTheInbox(request);
        const { outcomes } = await everyReading(waiting.id);
        /* RED WHEN: a request held fast to its invitation is refused - nobody could then be seated at all. */
        expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
        expect(String((outcomes[2] as PromiseRejectedResult).reason?.message)).toMatch(/approved where it is made/u);
        await expect(seatingDevice(request).out).rejects.toThrow(/every check passed/u);
      }
    } finally {
      putBack();
    }
  });

  it('a leaf is not approved without its opening', async () => {
    const { opening: _none, ...request } = danasRequest();
    inTheInbox(request);
    try {
      /* RED WHEN: a device approves a leaf whose seat request does not show which wallet it was made for. */
      await refusedOnEveryReading(request, /does not show which wallet its keys were made for/u);
    } finally {
      putBack();
    }
  });

  it('a leaf is not approved on an opening made for another wallet', async () => {
    const elsewhere = keysOf();
    try {
      for (const opening of [elsewhere.opening, { ...dana.opening, walletKey: elsewhere.opening.walletKey }]) {
        const request = { ...danasRequest(), opening };
        inTheInbox(request);
        /* RED WHEN: a device approves a leaf on an opening that makes another leaf, or names a wallet the leaf is not made for. */
        await refusedOnEveryReading(request, /not made for the wallet it names/u);
      }
    } finally {
      putBack();
    }
  });

  it('a seat is not approved on an invitation no seat this device believes signed', async () => {
    const stranger = newSigningKeypair();
    const signed = signSeatInvitation(DANAS_INVITATION, ada.signingSecret as Hex);
    try {
      /* RED WHEN: an invitation signed by a key that holds no seat the device believes seats anybody. */
      const byAStranger = { ...danasRequest(), invited: signSeatInvitation(DANAS_INVITATION, stranger.secret as Hex) };
      inTheInbox(byAStranger);
      await refusedOnEveryReading(byAStranger, /not one this device believes is seated/u);
      /* RED WHEN: an invitation changed after its seat signed it, or none at all, seats anybody. */
      for (const request of [{ ...danasRequest(), invited: { ...signed, terms: { ...signed.terms, person: 'usr_mallory' } } }, { ...danasRequest(), invited: undefined }]) {
        inTheInbox(request);
        await refusedOnEveryReading(request, /does not carry who the seat is for/u);
      }
      /* RED WHEN: a request asks for another role than the invitation its seat signed gives. */
      const promoted = { ...danasRequest(), invited: signSeatInvitation({ ...DANAS_INVITATION, role: 'admin' }, ada.signingSecret as Hex) };
      inTheInbox(promoted);
      await refusedOnEveryReading(promoted, /another company, name or role/u);
    } finally {
      putBack();
    }
  });

  it('a seat is not approved for a person or a sign-in the invitation does not name', async () => {
    try {
      /* RED WHEN: somebody holding Dana's link seats themselves: their request and their sign-in are theirs, the invitation is Dana's. */
      const theirs = { ...danasRequest(), person: 'usr_mallory' };
      inTheInbox(theirs, 'usr_mallory');
      await refusedOnEveryReading(theirs, /not for the person the invitation names/u);
      /* RED WHEN: the service files Dana's own request under another sign-in, which the seat would make a member. */
      inTheInbox(danasRequest(), 'usr_mallory');
      await refusedOnEveryReading(danasRequest(), /not for the person the invitation names/u, /not sealed for the sign-in it would make a member/u);
    } finally {
      putBack();
    }
  });

  it('a second request answering the same invitation leaves both unseated', async () => {
    const eve = keysOf();
    const evesRequest: PendingSignerPayload = {
      name: 'Dana', role: 'approver', ...eve, seatProof: proveSeatKeys(newSeatInvitation(viewingKey, company, 'Dana', 'approver'), eve),
      person: 'usr_dana', invited: signSeatInvitation(DANAS_INVITATION, ada.signingSecret as Hex),
    };
    inTheInbox(danasRequest(), 'usr_dana', [{ id: 'sgn_second', userId: 'usr_eve', request: evesRequest }]);
    try {
      /* RED WHEN: two wallets answer one invitation and the device seats either. */
      await refusedOnEveryReading(danasRequest(), /Another seat request answers the same invitation/u);
    } finally {
      putBack();
    }
  });

  it('a decoy request on the same invitation, signed by no seat this device believes, does not stop the seating', async () => {
    const decoy = keysOf();
    const decoysRequest: PendingSignerPayload = {
      name: 'Dana', role: 'approver', ...decoy, seatProof: proveSeatKeys(newSeatInvitation(viewingKey, company, 'Dana', 'approver'), decoy),
      person: 'usr_dana', invited: signSeatInvitation(DANAS_INVITATION, newSigningKeypair().secret as Hex),
    };
    inTheInbox(danasRequest(), 'usr_dana', [{ id: 'sgn_decoy', userId: 'usr_decoy', request: decoysRequest }]);
    try {
      /* RED WHEN: a request anybody can seal to the inbox, under an invitation no seat signed, stops the person invited from being seated. */
      const { outcomes } = await everyReading(waiting.id);
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
      await expect(seatingDevice(danasRequest()).out).rejects.toThrow(/every check passed/u);
    } finally {
      putBack();
    }
  });

  it('a seat added from a code is approved only at the leaf the code carried', async () => {
    const request = { ...danasRequest(), invited: signSeatInvitation({ ...DANAS_INVITATION, leaf: keysOf().leafCommitment }, ada.signingSecret as Hex) };
    inTheInbox(request);
    try {
      /* RED WHEN: the keys of a code's seat request are swapped for others after the inviting seat signed the code's leaf. */
      await refusedOnEveryReading(request, /not the ones the code its invitation was made for carried/u);
    } finally {
      putBack();
    }
  });
});

/* ── AND THE RECORD: WHAT IS WRITTEN DOWN WHEN THE SEAT IS, AFTER EVERY DEVICE HAS LOOKED ── */

/**
 * A second company, where each test swaps the inbox AFTER the devices would
 * have checked it, just before the service writes the seat down and wraps the
 * viewing key to the wrapping key it finds. The writer is the same one: the
 * stored record and nothing else.
 */
const recorded = async () => {
  const made = await accounts.create('Recorded', [{ name: 'Ada', role: 'admin' }], 1, undefined, drawCompanyLabel());
  const at = made.account.id;
  const adaHere = made.secrets[0]!;
  const adaRef = { signerId: adaHere.signerId, leaf: made.account.signers[0]!.leafCommitment as Hex };
  const accept = (name: string) => {
    const s = newSigningKeypair();
    const w = newWrappingKeypair();
    const keys = {
      signingPublicKey: s.publicKey, wrappingPublicKey: w.publicKey,
      leafCommitment: storedSignerLeaf({ signingSecret: s.secret, blinding: newBlinding(), scope }, MidnightCommitments),
    };
    const inv = accounts.inviteSigner(at, name, `${name}@recorded.example`, 'approver');
    const seat = accounts.acceptSignerInvite(inv.token, `usr_${name}`, keys.signingPublicKey, keys.wrappingPublicKey,
      keys.leafCommitment, proveSeatKeys(newSeatInvitation(made.viewingKey, at, name, 'approver'), keys));
    return { ...keys, wrappingSecret: w.secret, id: seat.id };
  };
  const dana = accept('Dana');
  const eve = accept('Eve');
  const honest = structuredClone(store.getAccount(at)!);
  /** Dana's box, replaced: by a new entry sealed to the public key, or by a copy of Eve's box as it stands. */
  const swap = (payload: Partial<PendingSignerPayload> | 'eve') => {
    const rec = structuredClone(honest);
    const box = rec.pendingSigners.find((p) => p.id === dana.id)!;
    box.sealed = payload === 'eve'
      ? structuredClone(rec.pendingSigners.find((p) => p.id === eve.id)!.sealed)
      : sealToInbox({ name: 'Dana', role: 'approver', ...payload }, rec.inboxPublicKey);
    store.putAccount(rec);
  };
  const restore = () => store.putAccount(structuredClone(honest));
  const wrapped = () => store.getAccount(at)!.wrappedKeys.length;
  return { made, at, adaHere, adaRef, dana, eve, swap, restore, wrapped };
};

const swapsKeepingDanasLeaf = (dana: { leafCommitment: Hex }) => [
  ['the writer\'s own keys with Dana\'s leaf and no proof', {
    ...keysOf(), leafCommitment: dana.leafCommitment }],
  ['the writer\'s own wrapping key beside Dana\'s signing key, leaf and proof', 'keep-proof'],
] as const;

describe('THE SERVICE WRITES DOWN ONLY THE KEYS THE INVITED PERSON PROVED', () => {
  it('a grant on an approved round refuses a key swapped in after the approvals, and wraps the viewing key to nobody', async () => {
    const r = await recorded();
    const round = await accounts.proposeSigner(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId);
    await accounts.approve(round.id, r.adaHere.signerId, sign(approvalMessage(round), r.adaHere.signingSecret), r.made.viewingKey);
    const before = r.wrapped();
    for (const [what, payload] of swapsKeepingDanasLeaf(r.dana)) {
      r.swap(payload === 'keep-proof'
        ? { signingPublicKey: r.dana.signingPublicKey, wrappingPublicKey: newWrappingKeypair().publicKey,
          leafCommitment: r.dana.leafCommitment,
          seatProof: proveSeatKeys(newSeatInvitation(r.made.viewingKey, r.at, 'Dana', 'approver'), r.dana) }
        : payload);
      /* RED WHEN: the record's half of a seat trusts the inbox - the viewing key is then wrapped to the writer. */
      await expect(accounts.grantAccess(r.at, r.made.viewingKey, r.dana.id), what).rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
      expect(r.wrapped(), what).toBe(before);
    }
    r.restore();
    /* The honest entry is then written down, and its wrapped key opens with Dana's own secret. */
    const done = await accounts.grantAccess(r.at, r.made.viewingKey, r.dana.id);
    const hers = done.wrappedKeys.find((k) => k.signerId === r.dana.id)!;
    /* RED WHEN: the check refuses an honest grant. */
    expect(unwrapKey(hers, r.dana.wrappingSecret)).toBe(r.made.viewingKey);
  });

  /** Dana's seat raised on the record and approved on the simulated chain, as devices would have left it. */
  const approvedOnTheChain = async (r: Awaited<ReturnType<typeof recorded>>) => {
    const p = await accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId);
    const salt = accounts.seatOrderOf(r.at, r.made.viewingKey, r.dana.id).proposalSalt;
    await ledger.propose(r.at, MidnightCommitments.signerAddPayload(r.dana.leafCommitment),
      { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt }, r.adaRef, MidnightCommitments.noVault());
    await ledger.approve(r.at, p.chainId as Hex, r.adaRef);
    return p;
  };

  it('a seat the chain already holds is written down only for the keys proved for it', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    /* The chain seats Dana's leaf; the record has not been written yet. */
    await ledger.addSigner(r.at, r.dana.leafCommitment, p.chainId as Hex, r.adaRef);
    const before = r.wrapped();
    r.swap({ ...keysOf(), leafCommitment: r.dana.leafCommitment });
    /* RED WHEN: a seat the chain holds is written down for keys nobody proved. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
    r.restore();
    /* The proposal was closed when the chain was seen to carry it, so this answers that the seat is now written down. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, r.dana.id, r.adaHere.signerId))
      .rejects.toThrow(/now written on the company's record/u);
    const hers = store.getAccount(r.at)!.wrappedKeys.find((k) => k.signerId === r.dana.id)!;
    /* RED WHEN: the honest seat the chain holds is not written down. */
    expect(unwrapKey(hers, r.dana.wrappingSecret)).toBe(r.made.viewingKey);
  });

  it('a copy of a proved entry beside it, under another id, is not written down as a second seat', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    await ledger.addSigner(r.at, r.dana.leafCommitment, p.chainId as Hex, r.adaRef);
    /* Dana's own entry, copied beside itself under an id and a sign-in the writer chose. */
    const rec = structuredClone(store.getAccount(r.at)!);
    const hersBox = rec.pendingSigners.find((x) => x.id === r.dana.id)!;
    rec.pendingSigners.push({ ...structuredClone(hersBox), id: 'sgn_copy', userId: 'usr_copy' });
    store.putAccount(rec);
    const before = r.wrapped();
    /* RED WHEN: the service writes down the copy, and one person's keys hold two seats on the record. */
    await expect(accounts.seatRound(r.at, r.made.viewingKey, 'sgn_copy', r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
    expect(store.getAccount(r.at)!.memberUserIds).not.toContain('usr_copy');
  });

  it('another person\'s proved keys, swapped in while the seat is on its way, are not written down against Dana\'s leaf', async () => {
    const r = await recorded();
    const p = await approvedOnTheChain(r);
    /* The device's call reaches the chain, which seats Dana's leaf; while it is on its way the inbox is swapped. */
    Object.assign(ledger, {
      submitProvenCall: async (accountId: string, bytes: Uint8Array) => {
        const call = JSON.parse(Buffer.from(bytes).toString('utf8')) as { leaf: Hex; proposal: Hex };
        await ledger.addSigner(accountId, call.leaf, call.proposal, r.adaRef);
        r.swap('eve');
        return { ref: 'tx', at: new Date().toISOString() };
      },
    });
    const before = r.wrapped();
    const tx = new Uint8Array(Buffer.from(JSON.stringify({ leaf: r.dana.leafCommitment, proposal: p.chainId })));
    /* RED WHEN: the record writes down whoever is in the box once the chain answers, rather than the person it seated. */
    await expect(accounts.seatFromDevice(r.at, r.made.viewingKey, r.dana.id, tx, r.adaHere.signerId))
      .rejects.toBeInstanceOf(SeatKeyNotFromTheInvitee);
    expect(r.wrapped()).toBe(before);
  });
});


describe('A SEAT THE CHAIN HOLDS BEFORE ITS SIGNER IS ADMITTED', () => {
  /* The chain has seated Dana's leaf; the roster does not name her until she is admitted. */
  const readsWithDanasSeat: RosterReads = {
    filings: filed.reads.filings,
    holders: async () => { const h = await filed.reads.holders(); return { ...h, seats: [...h.seats, dana.leafCommitment] }; },
    anchored: filed.reads.anchored,
    leaves: filed.reads.leaves,
  };
  const readHere = () => rosterBelievedHere({ ...store.getAccount(company)!, roster: filed.roster }, viewingKey as Hex, {
    accountId: company, label: honestRecord.companyLabel as never, account: honestRecord.contractAddress as never,
    reads: readsWithDanasSeat,
  });

  it('is read while the person invited to it waits in the inbox, and nothing for a committee is built from it', async () => {
    putBack();
    const read = await readHere();
    /* RED WHEN: a roster is refused in the window between the chain seating a person and their admission, so nobody could be admitted. */
    expect(read.account.notBelieved).toEqual([dana.leafCommitment.toLowerCase()]);
  });

  it.each([
    ['nobody waits for it', () => { const rec = structuredClone(honestRecord); rec.pendingSigners = []; store.putAccount(rec); }],
    ['the inbox holds the writer\'s own keys at Dana\'s leaf, with no proof', () => swapInTheInbox({ ...keysOf(), leafCommitment: dana.leafCommitment })],
  ])('is refused when %s', async (_what, setUp) => {
    setUp();
    try {
      /* RED WHEN: a seat the chain holds with no roster entry is taken as waited for without a request its invitation proves. */
      await expect(readHere()).rejects.toThrow(/has no entry for 1 seat\(s\) the company's account holds on the chain/u);
    } finally {
      putBack();
    }
  });
});

describe('WHO MAY INVITE, AND ONE PERSON ONE SEAT, ON THE DEVICE THAT APPROVES THE LEAF', () => {
  /** Ada's seat as an approving device believes it: the seat that signed Dana's invitation. */
  const adaSeat = (over: Partial<DirectoryWitness> = {}): DirectoryWitness => ({
    seat: '0a'.repeat(32), signingKey: signingPublicKeyOf(ada.signingSecret as Hex), committeeKey: { tag: 'schnorr', value: '0b'.repeat(32) },
    retired: false, role: 'admin', person: 'usr_ada', ...over,
  });
  /** Dana's request held to `seats` and the chain's seats `onTheChain`, as every approving device holds it. */
  const held = (seats: readonly DirectoryWitness[], onTheChain: readonly string[] = []) => {
    const sealed = store.getAccount(company)!;
    const box = sealed.pendingSigners.find((p) => p.id === waiting.id)!;
    return refuseASeatNotForTheInvited(sealed, viewingKey as Hex, box, danasRequest(), { seats, onTheChain, leaves });
  };
  const anotherRequestForDana = (by: Hex): PendingSignerPayload => {
    const other = keysOf();
    return {
      name: 'Dana', role: 'approver', ...other, seatProof: proveSeatKeys(newSeatInvitation(viewingKey, company, 'Dana', 'approver'), other),
      person: 'usr_dana', invited: signSeatInvitation({ ...DANAS_INVITATION, invitation: invitationIdOf(newInvitationToken()) }, by),
    };
  };

  it('an invitation signed by a seat whose role may not file a proposal seats nobody', async () => {
    inTheInbox(danasRequest());
    try {
      await expect(held([adaSeat()])).resolves.toBeUndefined();
      /* RED WHEN: a viewer's seat invites somebody an approving device then seats. */
      await expect(held([adaSeat({ role: 'viewer' })])).rejects.toThrow(/a role that may not file a proposal/u);
    } finally {
      putBack();
    }
  });

  it('an inviter who has left stops a request until the chain holds its leaf, and never after', async () => {
    inTheInbox(danasRequest());
    try {
      await expect(held([adaSeat({ retired: true })])).rejects.toThrow(/not one this device believes is seated/u);
      /* RED WHEN: a person the chain already seated, whose inviter retired before they were admitted, can never be admitted. */
      await expect(held([adaSeat({ retired: true })], [dana.leafCommitment])).resolves.toBeUndefined();
    } finally {
      putBack();
    }
  });

  it('two requests waiting for one person, under two invitations, seat neither; one under no seat\'s invitation stops nothing', async () => {
    try {
      inTheInbox(danasRequest(), 'usr_dana', [{ id: 'sgn_dana_again', userId: 'usr_dana', request: anotherRequestForDana(ada.signingSecret as Hex) }]);
      /* RED WHEN: one person waits under two invitations and a device seats either: one person, two votes on the chain. */
      await expect(held([adaSeat()])).rejects.toThrow(/waiting for the same person/u);
      inTheInbox(danasRequest(), 'usr_dana', [{ id: 'sgn_decoy', userId: 'usr_dana', request: anotherRequestForDana(newSigningKeypair().secret as Hex) }]);
      await expect(held([adaSeat()])).resolves.toBeUndefined();
    } finally {
      putBack();
    }
  });

  it('a person who already holds a seat not retired is not seated again', async () => {
    inTheInbox(danasRequest());
    const danasSeat = adaSeat({ seat: '0c'.repeat(32), signingKey: newSigningKeypair().publicKey, person: 'usr_dana' });
    try {
      /* RED WHEN: a device seats a person its own read of the directory already believes holds a seat. */
      await expect(held([adaSeat(), danasSeat])).rejects.toThrow(/already holds a seat on this company/u);
      /* A person whose seat was retired is seated again under a new leaf. */
      await expect(held([adaSeat(), { ...danasSeat, retired: true }])).resolves.toBeUndefined();
    } finally {
      putBack();
    }
  });
});


describe('A PERSON WAITING FOR A SEAT, ACROSS A CHANGE OF THE COMPANY\'S KEY', () => {
  /* After a signer left, the company's key changed to epoch 1; Dana's request was sealed to the inbox of epoch 0. */
  const KEY1 = newSymmetricKey() as Hex;
  const keysAfter = (named: readonly SealedAnswer[] = []): CompanyKeys => ({
    epoch: 1, key: KEY1, newest: 1, keyAt: (e) => (e === 0 ? viewingKey as Hex : KEY1), sealing: () => ({ key: KEY1, epoch: 1 }),
    answered: new Map([[0, new Set(named.map(answerDigestOf))]]),
  });
  const danasBox = (): SealedAnswer => store.getAccount(company)!.pendingSigners.find((p) => p.id === waiting.id)!.sealed as SealedAnswer;
  const readsWithDanasSeat: RosterReads = {
    filings: filed.reads.filings,
    holders: async () => { const h = await filed.reads.holders(); return { ...h, seats: [...h.seats, dana.leafCommitment] }; },
    anchored: filed.reads.anchored,
    leaves: filed.reads.leaves,
  };
  /** The proposal that seated Dana's leaf, carrying the invitation Ada's seat signed for it. */
  const seatingProposal = () => ({
    accountId: company, keyEpoch: 0,
    sealed: sealGovernanceProposal({
      accountId: company, viewingKey: viewingKey as Hex, kind: 'add-signer', summary: 'Add Dana', noVault: '00'.repeat(32) as Hex,
      body: { signerId: waiting.id, invited: signSeatInvitation({ ...DANAS_INVITATION, leaf: dana.leafCommitment as Hex }, ada.signingSecret as Hex) },
      change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: newBlinding() as Hex }, proposedBy: ada.signerId,
    }),
  });
  const readAfter = (keys: CompanyKeys, proposals: readonly ReturnType<typeof seatingProposal>[] = []) =>
    rosterBelievedHere({ ...store.getAccount(company)!, roster: filed.roster }, keys, {
      accountId: company, label: honestRecord.companyLabel as never, account: honestRecord.contractAddress as never,
      reads: readsWithDanasSeat, proposals: async () => proposals,
    });

  it('a request the change of key named is still read, its proof checked under the key it was made with', async () => {
    putBack();
    const keys = keysAfter([danasBox()]);
    const read = await readAfter(keys);
    /* RED WHEN: a request sealed to the inbox before the change, and named by it, no longer counts as waiting. */
    expect(read.account.notBelieved).toEqual([dana.leafCommitment.toLowerCase()]);
    /* RED WHEN: the proof is checked under the key in force rather than the key whose inbox opened the request. */
    const got = await waitingHere(store.getAccount(company)!, read.account, keys, waiting.id, seatRequestFingerprint(danasRequest()),
      seatingOf(read, readsWithDanasSeat));
    expect(got.payload.leafCommitment).toBe(dana.leafCommitment);
  });

  it('a request the change did not name seats nobody, and the roster is read through the proposal that seated it', async () => {
    putBack();
    /* RED WHEN: a request sealed to an old inbox and named by no change is believed: the service could hand it in after. */
    await expect(readAfter(keysAfter())).rejects.toThrow(/has no entry for 1 seat\(s\) the company's account holds on the chain/u);
    /* RED WHEN: an answer withheld from the seat that changed the key refuses the whole roster though the chain seated it on the company's approvals. */
    const read = await readAfter(keysAfter(), [seatingProposal()]);
    expect(read.account.notBelieved).toEqual([dana.leafCommitment.toLowerCase()]);
    /* RED WHEN: the person is admitted from an answer the change did not name. */
    await expect(waitingHere(store.getAccount(company)!, read.account, keysAfter(), waiting.id, seatRequestFingerprint(danasRequest()),
      seatingOf(read, readsWithDanasSeat))).rejects.toThrow(/did not find it waiting/u);
  });

  it('an unnamed request does not stop the company being read, and is no pending signer', () => {
    putBack();
    /* RED WHEN: one request sealed to an old inbox makes the whole company unreadable on every device. */
    const opened = openAccount({ ...store.getAccount(company)!, roster: filed.roster }, keysAfter());
    expect(opened.signers.some((x) => x.id === waiting.id)).toBe(false);
    expect(openAccount({ ...store.getAccount(company)!, roster: filed.roster }, keysAfter([danasBox()])).signers
      .find((x) => x.id === waiting.id)?.status).toBe('pending');
  });

  it('an approving device opens the seat\'s proposal only for a request the change named', async () => {
    putBack();
    const named = await openTheRoundHere(service(), company, seatRound.id, keysAfter([danasBox()]), true, recordsHere, leaves);
    /* RED WHEN: an approving device cannot open a seat whose request was sealed before the change and named by it. */
    expect(named.governance).toEqual({ kind: 'add-signer', leaf: dana.leafCommitment });
    /* RED WHEN: an approving device, and the company's own reading of who waits, both believe a request sealed to an old inbox that no change named. */
    await expect(openTheRoundHere(service(), company, seatRound.id, keysAfter(), true, recordsHere, leaves)).rejects.toThrow();
  });

  it('another request for the same person counts against the seat only when this device believes it', async () => {
    const other = { id: 'sgn_dana_again', userId: 'usr_dana', request: {
      ...danasRequest(), ...keysOf(), invited: signSeatInvitation({ ...DANAS_INVITATION, invitation: invitationIdOf(newInvitationToken()) }, ada.signingSecret as Hex),
    } };
    try {
      inTheInbox(danasRequest(), 'usr_dana', [other]);
      const rec = store.getAccount(company)!;
      const box = (id: string) => rec.pendingSigners.find((p) => p.id === id)!;
      const adaSeat: DirectoryWitness = {
        seat: '0a'.repeat(32), signingKey: signingPublicKeyOf(ada.signingSecret as Hex), committeeKey: { tag: 'schnorr', value: '0b'.repeat(32) },
        retired: false, role: 'admin', person: 'usr_ada',
      };
      const held = (keys: CompanyKeys) => refuseASeatNotForTheInvited(rec, keys, box(waiting.id), danasRequest(), { seats: [adaSeat], onTheChain: [], leaves });
      /* RED WHEN: a second request the change of key named, for the same person, is not seen once the key has changed. */
      await expect(held(keysAfter([box(waiting.id).sealed as SealedAnswer, box(other.id).sealed as SealedAnswer]))).rejects.toThrow(/waiting for the same person/u);
      /* RED WHEN: a request no change named, which anybody holding the old key could seal, blocks a seat. */
      await expect(held(keysAfter([box(waiting.id).sealed as SealedAnswer]))).resolves.toBeUndefined();
    } finally {
      putBack();
    }
  });

  it('a proof made with the old key on a request sealed to the new inbox seats nobody', async () => {
    try {
      /* What somebody holding only the old key makes: a proof under it, sealed to the inbox in force. */
      const rec = structuredClone(honestRecord);
      const box = rec.pendingSigners.find((p) => p.id === waiting.id)!;
      box.sealed = sealToInbox(danasRequest(), inboxPublicKey(KEY1, company));
      store.putAccount(rec);
      const read = await readAfter(keysAfter(), [seatingProposal()]);
      /* RED WHEN: a proof is checked under every key this device holds, so a removed signer's old key still makes one that passes. */
      await expect(waitingHere(store.getAccount(company)!, read.account, keysAfter(), waiting.id, seatRequestFingerprint(danasRequest()),
        seatingOf(read, readsWithDanasSeat))).rejects.toThrow(/could not be confirmed as coming from the person you invited/u);
    } finally {
      putBack();
    }
  });
});
