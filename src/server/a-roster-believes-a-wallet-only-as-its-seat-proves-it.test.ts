/**
 * **A ROSTER ENTRY'S WALLET IS THE ONE ITS SEAT'S OWN OPENING PROVES, AND A
 * SEAT IS WAITED FOR ONLY ON A REQUEST ITS INVITATION AND OPENING PROVE.**
 *
 * The roster is filed whole by any seat the company's directory believes, so
 * nothing a version carries for a signer is believed on that version's word.
 * A device takes a signer's wallet only from the directory entry of their seat
 * whose opening makes the leaf the chain holds for that wallet: an entry kept
 * beside their keys, signed by some wallet, proves nothing about whose seat it
 * is. One wallet holding one seat is the directory's rule, so an entry no
 * device believes blocks nobody. A seat the chain holds and the roster does
 * not name is excused only by a request the invitation of a seat this device
 * believes and has not seen retired names, whose opening makes that leaf, for
 * a seat the directory holds no entry for yet.
 *
 * Over real HTTP: Ada and Bo are seated and believed. The chain's read is the
 * test's. Bo is retired by the last case, so it runs last.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import { newSigningKeypair, newWrappingKeypair, sign, signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { openAccount, sealAccount } from '../core/account.js';
import { sealToInbox } from '../core/sealed-records.js';
import { newSeatInvitation, proveSeatKeys } from '../core/seat-invite-proof.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';
import { signedFoundingRoster, sealRoster, type RosterSecrets } from '../core/roster-record.js';
import { signVaultKeys, vaultKeyIndexOf } from '../core/vault-keys.js';
import type { Account, PendingSignerPayload, SealedAccount, Signer } from '../core/types.js';
import { signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { directoryChangeMessage, type DirectoryChange } from '../midnight/seat-directory.js';
import {
  admitSignerHere, foldOffersHere, offerVaultKeysHere, rosterBelievedHere, rosterHere, type RosterDoors,
} from 'vaults-web-shared/roster-here.js';
import { seatRequestFingerprint } from 'vaults-web-shared/invitation-on-device.js';
import { anchorServiceFor, anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { signerRoutes } from './signer-routes.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeReads, ADA, ADDRESS, apiAs, BO, chains, CO, KEY, LABEL, seatOf, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';

/** Ada's device anchors every filing not yet anchored, as it does on its way in. */
const adaAnchors = () => anchorTheRecordsHere({
  accountId: CO,
  material: { signingSecret: ADA.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs('ada')),
  tree: treeServiceFor(apiAs('ada')),
  directory: () => acmeDirectoryWithItsFold({}, [ADA]),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  onChain: acmeChain.onChain,
  service: {
    foundingRecords: anchorServiceFor(apiAs('ada')).foundingRecords,
    sealedProposals: async (company) => store.listProposals(company),
    callState: async () => ({ account: ADDRESS }) as never,
    sendProven: async (_company, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
    },
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

aCompanyOfTwoSeats((app, deps) => {
  app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
    const id = String(req.params.id);
    res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
  });
  app.use(signerRoutes({
    signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
    ledger: { status: async () => null, holdsSigner: async (_a, seat) => (chains.get(CO)?.seats.seats ?? []).includes(String(seat)) },
  }));
/* The founding device filed the first roster with the company, and anchored it first: Ada's seat founded it. */
}, { roster: () => signedFoundingRoster(CO, HONEST, KEY, ADA.signingSecret as Hex) });

/** A seat's own vault keys, signed with its own signing key, with its wallet's statement over its records key. */
const keysOf = (s: Seat, signerId: string) => {
  const statement = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat);
  return signVaultKeys(CO, signerId, {
    committeeKey: s.committeeKey as never, recordsKey: statement.recordsKey as Hex,
    recordsKeyStatement: statement.signature as Hex, recordsKeySeat: s.seat as Hex,
  }, s.signingSecret as Hex);
};
/** `s`'s roster entry as an honest filing gives it: at their seat, under the filing key their wallet signed, with their vault keys. */
const entryOf = (s: Seat, id = `sgn_${s.person}`): Signer => ({
  id, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active',
  signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin',
  vaultKeys: keysOf(s, id),
});
const HONEST: RosterSecrets = { name: 'Acme', signers: [entryOf(ADA), entryOf(BO)] };

/** The chain holds exactly `seats`. */
const onChain = (...seats: Seat[]) => chains.set(CO, {
  seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1, seatBar: 1,
});
/** `s`'s own directory entry filed: what their own device files once it is admitted, its opening sealed inside. */
const claims = (s: Seat) => {
  expect(store.fileDirectory(CO, { company: CO, version: store.directoryFilingsOf(CO).length + 1, change: { kind: 'claim', entry: s.entry } })).toBe(true);
};

/** The company as the service serves it now. */
const served = async (): Promise<SealedAccount & { roster: SealedCompanyRecord | null }> =>
  (await sendAs('ada')(`/api/accounts/${CO}`, { method: 'GET' })).body as never;
/** One person's device reading the roster: its own key and entry, the directory and its wallet's read of the chain. */
const readOn = async (s: Seat) => rosterBelievedHere(await served(), KEY, {
  accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads,
  own: { signerId: `sgn_${s.person}`, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex) },
});
/** One seat's device, as it reads the roster to change it. */
const doorsOf = (s: Seat): RosterDoors => ({
  api: apiAs(s.person), accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads, entered: s.entered,
});
/** Ada's device files the roster's next version as `next` says, through the service's own roster route, and enters it. */
const adaFiles = async (next: RosterSecrets) => {
  const version = ((await served()).roster?.version ?? 0) + 1;
  const rec = signCompanyFiling(sealRoster(CO, next, version, 0, KEY), ADA.signingSecret as Hex);
  const r = await sendAs('ada')(`/api/accounts/${CO}/roster`, {
    method: 'POST',
    body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: next.signers }) }),
  });
  expect(r.status).toBe(201);
  await ADA.entered.enter([companyRecordEntry(rec)]);
};

/** `s`'s seat request as their own device seals it: their keys and the proof their link gave, their sign-in, their opening and invitation. */
const requestOf = (s: Seat, o: { person?: string; invitedBy?: Seat; opening?: boolean; invited?: boolean } = {}) => {
  const person = o.person ?? s.person;
  const keys = { signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: newWrappingKeypair().publicKey, leafCommitment: s.seat as Hex };
  const payload: PendingSignerPayload = {
    name: person, role: 'admin', ...keys, seatProof: proveSeatKeys(newSeatInvitation(KEY, CO, person, 'admin'), keys), person,
    ...(o.opening === false ? {} : { opening: s.opening }),
    ...(o.invited === false ? {} : {
      invited: signSeatInvitation({
        company: CO, invitation: invitationIdOf(newInvitationToken()), person, name: person, role: 'admin', leaf: s.seat as Hex,
      }, (o.invitedBy ?? ADA).signingSecret as Hex),
    }),
  };
  return payload;
};
/** The company's inbox holding exactly `waiting`, each under the sign-in the service keeps it for. */
const inboxHolds = (...waiting: Array<{ id: string; userId: string; payload: PendingSignerPayload }>) => {
  const rec = store.getAccount(CO)!;
  store.putAccount({
    ...rec,
    pendingSigners: waiting.map((w) => ({ id: w.id, userId: w.userId, createdAt: 'now', sealed: sealToInbox(w.payload, rec.inboxPublicKey) })),
  });
};

const DEE = seatOf('dee', 13, LABEL, ADDRESS, CO, ADA);
const CY = seatOf('cy', 12, LABEL, ADDRESS, CO, ADA);
const FAY = seatOf('fay', 14, LABEL, ADDRESS, CO, ADA);
const GEN = seatOf('gen', 15, LABEL, ADDRESS, CO, ADA);

beforeAll(() => {
  const account = {
    id: CO, name: 'Acme', createdAt: 'now', signers: HONEST.signers, policy: { threshold: 1 }, wrappedKeys: [],
    recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
  } as unknown as Account;
  store.putAccount(sealAccount(account, KEY, [], 0));
});

describe('A ROSTER ENTRY\'S WALLET IS THE ONE ITS SEAT\'S OWN OPENING PROVES', () => {
  it('A KEPT ENTRY ITS WALLET SIGNED IS NOT BELIEVED UNTIL THE DIRECTORY HOLDS THE SEAT\'S OWN ENTRY, AND A WALLET SWAPPED INTO IT IS NEVER BELIEVED', async () => {
    onChain(ADA, BO, DEE);
    const dees: Signer = { ...entryOf(DEE), directoryEntry: { committeeKey: DEE.committeeKey as never, statement: DEE.statement } };
    /* Ada's seat swaps in a wallet of its own and a filing key it holds, each signed over Dee's seat as an honest entry would be. */
    const adas = identityFromSecret(new Uint8Array(32).fill(77));
    const held = newSigningKeypair();
    const adasKey = committeeKeyFor(adas, LABEL) as { tag: string; value: string };
    const adasStatement = signRecordsKey(adas, LABEL, ADDRESS, new Uint8Array(32).fill(177), DEE.seat);
    const swapped: Signer = {
      ...dees, signingPublicKey: held.publicKey,
      directoryEntry: { committeeKey: adasKey as never, statement: signDirectoryEntry(adas, LABEL, ADDRESS, new Uint8Array(32).fill(177), held.publicKey, DEE.seat) },
      vaultKeys: signVaultKeys(CO, 'sgn_dee', {
        committeeKey: adasKey as never, recordsKey: adasStatement.recordsKey as Hex, recordsKeyStatement: adasStatement.signature as Hex, recordsKeySeat: DEE.seat as Hex,
      }, held.secret),
    };
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, dees] });
    /* RED WHEN: a kept entry's wallet is believed on its own signature, before the seat's own opening proves that wallet. */
    expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_dee', name: 'dee', why: 'no-entry-of-their-own' }]);
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, swapped] });
    /* RED WHEN: a believed seat's swap of a new signer's wallet and filing key is believed on every device. */
    expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_dee', name: 'dee', why: 'no-entry-of-their-own' }]);
    /* Dee is admitted, and her own device files her entry: her opening shows her wallet makes her seat's leaf. */
    claims(DEE);
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, dees] });
    expect((await readOn(BO)).refused).toEqual([]);
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, swapped] });
    expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_dee', name: 'dee', why: 'not-their-signing-key' }]);
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, dees] });
  });

  it('AN ENTRY NO DEVICE BELIEVES, AT A WAITING SIGNER\'S LEAF AND UNDER THEIR KEY, DOES NOT STOP THEIR ADMISSION', async () => {
    const theirs = requestOf(CY);
    inboxHolds({ id: 'sgn_cy', userId: 'cy', payload: theirs });
    onChain(ADA, BO, DEE, CY);
    /* Ada's seat files an entry at Cy's leaf, under the filing key he will be seated with, before he is admitted: no device believes it. */
    const junk: Signer = { ...entryOf(CY, 'sgn_junk'), name: 'junk', userId: 'junk', vaultKeys: null };
    const before = (await served()).roster!.version;
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, entryOf(DEE), junk] });
    expect((await readOn(BO)).refused.map((r) => r.why)).toEqual(['no-entry-of-their-own']);
    /* RED WHEN: an entry this device does not believe holds the keys of the person waiting, so they can never be admitted. */
    await admitSignerHere(doorsOf(ADA), { signerId: 'sgn_cy', readOut: seatRequestFingerprint(theirs) });
    const filed = store.newestRoster(CO)!;
    expect(filed.version).toBe(before + 2);
    const admitted = openAccount({ ...store.getAccount(CO)!, roster: filed } as never, KEY, filed);
    expect(admitted.signers.find((x) => x.id === 'sgn_cy')).toMatchObject({ status: 'active', leafCommitment: CY.seat });
    /* RED WHEN: an admission files the seat it admits beside another entry at the same leaf, which can never be given vault keys. */
    expect(admitted.signers.filter((x) => x.status === 'active' && x.leafCommitment === CY.seat).map((x) => x.id)).toEqual(['sgn_cy']);
    expect(store.getAccount(CO)!.pendingSigners).toEqual([]);
    /* Cy's own device files his seat's entry: the version as admitted is read whole, with nothing filed by hand. */
    claims(CY);
    expect((await readOn(BO)).refused).toEqual([]);
  });

  it('A SECOND ENTRY FOR A SEAT ALREADY NAMED IS REFUSED, WHICHEVER COMES FIRST, AND THE NEXT FILING DROPS IT', async () => {
    onChain(ADA, BO, DEE, CY);
    /* Ada's seat files a second entry at Dee's leaf, under her filing key, ahead of hers: on its own it passes every check an entry has. */
    const twin: Signer = { ...entryOf(DEE, 'sgn_twin'), name: 'twin', userId: 'twin', vaultKeys: null };
    await adaFiles({ name: 'Acme', signers: [entryOf(ADA), entryOf(BO), twin, entryOf(DEE), entryOf(CY)] });
    const read = await readOn(BO);
    /* RED WHEN: one seat is believed under two entries, or the one its own directory entry names is the one refused. */
    expect(read.refused).toEqual([{ signerId: 'sgn_twin', name: 'twin', why: 'seat-named-twice' }]);
    expect(read.account.signers.filter((x) => x.leafCommitment === DEE.seat).map((x) => x.id)).toEqual(['sgn_dee']);
    /* Bo gives his vault keys again, and Ada's device folds them in: the one filing a fold makes. */
    await offerVaultKeysHere(apiAs('bo'), CO, {
      signerId: 'sgn_bo', signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, viewingKey: KEY as Hex,
      companyKey: toHex(new Uint8Array(32).fill(BO.n + 100)) as Hex, entry: BO.statement,
      recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(BO.n)), LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), BO.seat),
    });
    expect((await foldOffersHere(doorsOf(ADA))).folded).toEqual([BO.seat]);
    const filed = store.newestRoster(CO)!;
    const ids = openAccount({ ...store.getAccount(CO)!, roster: filed } as never, KEY, filed).signers.map((x) => x.id);
    /* RED WHEN: a filing carries the second entry for a seat on, so every honest filing keeps it for good. */
    expect(ids).not.toContain('sgn_twin');
    expect(ids).toContain('sgn_dee');
  });
});

describe('A SEAT THE CHAIN HOLDS THAT THE ROSTER DOES NOT NAME IS WAITED FOR ONLY ON A REQUEST ITS INVITATION AND OPENING PROVE', () => {
  const honestNow = () => ({ name: 'Acme', signers: [...HONEST.signers, entryOf(DEE), entryOf(CY)] });
  const leftOut = /has no entry for 1 seat\(s\) the company's account holds on the chain/u;

  it('IS READ WHILE THE PERSON INVITED WAITS, AND REFUSED ON A REQUEST ONLY THE VIEWING KEY PROVES', async () => {
    onChain(ADA, BO, DEE, CY, FAY);
    await adaFiles(honestNow());
    inboxHolds({ id: 'sgn_fay', userId: 'fay', payload: requestOf(FAY) });
    const read = await readOn(BO);
    expect(read.account.notBelieved).toEqual([FAY.seat]);
    /* A request any holder of the viewing key can make: keys at Fay's leaf and the proof that key works out, no invitation, no opening. */
    inboxHolds({ id: 'sgn_fay', userId: 'fay', payload: requestOf(FAY, { opening: false, invited: false }) });
    /* RED WHEN: a seat is taken as waited for on a request whose only proof is one the viewing key makes. */
    await expect(readOn(BO)).rejects.toThrow(leftOut);
    inboxHolds();
  });

  it('IS REFUSED ON A REQUEST FOR A SEAT WHOSE OWN ENTRY THE DIRECTORY ALREADY HOLDS, THOUGH A BELIEVED SEAT INVITED IT', async () => {
    onChain(ADA, BO, DEE, CY);
    /* Dee's seat left out, and a request at her seat with her opening, which every member opens, invited by Ada's seat for another sign-in. */
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, entryOf(CY)] });
    inboxHolds({ id: 'sgn_mal', userId: 'mal', payload: requestOf(DEE, { person: 'mal' }) });
    try {
      /* RED WHEN: a seat already entered in the directory, so admitted, is taken as still waited for. */
      await expect(readOn(BO)).rejects.toThrow(leftOut);
    } finally {
      inboxHolds();
      await adaFiles(honestNow());
    }
  });

  it('IS READ ON A REQUEST INVITED BY A SEAT RETIRED AFTER THE CHAIN HELD ITS LEAF, AND REFUSED ON ONE NO SEAT INVITED', async () => {
    onChain(ADA, BO, DEE, CY, GEN);
    await adaFiles(honestNow());
    inboxHolds({ id: 'sgn_gen', userId: 'gen', payload: requestOf(GEN, { invitedBy: BO }) });
    /* While Bo's seat is not retired, his invitation holds the seat for Gen. */
    expect((await readOn(ADA)).account.notBelieved).toEqual([GEN.seat]);
    /* A quorum retires Bo's seat: Ada signs it, at the chain's approvals. */
    const statement = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(BO.n)), LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), BO.seat);
    const version = store.directoryFilingsOf(CO).length + 1;
    const unsigned = {
      kind: 'retire', seat: BO.seat, filedUpTo: {}, threshold: 1,
      statement: { recordsKey: statement.recordsKey, seat: statement.seat, signature: statement.signature }, signatures: [],
    } as unknown as DirectoryChange;
    const change = { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature: sign(directoryChangeMessage(CO, version, unsigned), ADA.signingSecret as Hex) }] } as DirectoryChange;
    expect(store.fileDirectory(CO, { company: CO, version, change })).toBe(true);
    /*
     * RED WHEN: a person the chain already seated, whose inviter's seat was retired before they were admitted, is no
     * longer waited for, so the roster is refused and nobody could ever admit them.
     */
    const filedNotAnchored = await readOn(ADA);
    expect(filedNotAnchored.account.notBelieved).toEqual([GEN.seat]);
    /* RED WHEN: a retirement filed and not yet anchored drops the seat's roster entry, which a lost retirement would then leave dropped. */
    expect(filedNotAnchored.refused.filter((x) => x.why === 'seat-retired')).toEqual([]);
    await adaAnchors();
    const afterBoLeft = await readOn(ADA);
    expect(afterBoLeft.account.notBelieved).toEqual([GEN.seat]);
    /* RED WHEN: a seat an anchored retirement retired keeps its roster entry while the chain still holds its leaf, or is counted as a signer left out. */
    expect(afterBoLeft.refused.filter((x) => x.why === 'seat-retired')).toHaveLength(1);
    /* RED WHEN: the next version a device files from here still carries the retired seat's entry. */
    const isBos = (x: Signer) => x.leafCommitment?.toLowerCase() === BO.seat.toLowerCase();
    expect((await rosterHere(doorsOf(ADA))).carried.signers.some(isBos)).toBe(false);
    /* RED WHEN: the roster's next version, which drops the retired seat's entry, is refused as leaving a signer out. */
    const now = honestNow();
    await adaFiles({ ...now, signers: now.signers.filter((x) => !isBos(x)) });
    expect((await readOn(ADA)).account.notBelieved).toEqual([GEN.seat]);
    expect(afterBoLeft.account.signers.some((x) => x.status === 'active' && x.leafCommitment?.toLowerCase() === BO.seat.toLowerCase())).toBe(false);
    /* RED WHEN: an invitation signed by a key that holds no seat in the directory holds a seat open. */
    inboxHolds({ id: 'sgn_gen', userId: 'gen', payload: requestOf(GEN, { invitedBy: { signingSecret: newSigningKeypair().secret } as Seat }) });
    await expect(readOn(ADA)).rejects.toThrow(leftOut);
    inboxHolds();
  });
});
