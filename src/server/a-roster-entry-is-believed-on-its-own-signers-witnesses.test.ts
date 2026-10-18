/**
 * **ONE SEAT THE SERVICE BELIEVES CANNOT REWRITE ANOTHER SIGNER'S ROSTER
 * ENTRY.** The roster is filed whole, by any seat the company's directory
 * believes, so who filed a version says nothing about whose an entry is. A
 * reading device believes each entry only on its own signer's witnesses: the
 * signing key their own wallet signed into the directory for that seat, vault
 * keys signed by that key, the seat the chain holds, and the rights every seat
 * is seated with. An entry that fails is not shown.
 *
 * Over real HTTP: Ada and Bo are seated, believed and have given their keys;
 * Ada's device files versions with Bo's entry rewritten through the service's
 * own roster route, and every reading device - Ada's, Bo's, and a filing
 * device's own read - refuses the rewrite. The chain's read is the test's.
 */
import { leavesOfTheContract, seatOpenedFor } from '../testing/directory-seats.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import { newSigningKeypair, signingPublicKeyOf, type Hex } from '../core/crypto.js';
import { sealAccount } from '../core/account.js';
import { signedFoundingRoster, sealRoster, type RosterSecrets } from '../core/roster-record.js';
import { signVaultKeys, vaultKeyIndexOf } from '../core/vault-keys.js';
import type { Account, SealedAccount, Signer } from '../core/types.js';
import { signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { rosterBelievedHere, rosterHere, type RosterDoors, type RosterReads } from 'vaults-web-shared/roster-here.js';
import { whyNotWhole } from 'vaults-web-shared/handover-check.js';
import { signerRoutes } from './signer-routes.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeReads, ADA, ADDRESS, apiAs, BO, chains, CO, EVE, KEY, LABEL, OTHER, OTHER_ADDRESS, OTHER_LABEL, seatOf, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';
import { anchoredOver, anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { sign } from '../core/crypto.js';
import { directoryChangeMessage, directoryEntryMade, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import { invitationIdOf, newInvitationToken, signSeatInvitation } from '../core/invitation.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorServiceFor, anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';

const ID: Record<string, string> = { ada: 'sgn_ada', bo: 'sgn_bo' };

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
const keysOf = (s: Seat, signerId: string, signingSecret = s.signingSecret as Hex) => {
  const statement = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat);
  return signVaultKeys(CO, signerId, {
    committeeKey: s.committeeKey as never, recordsKey: statement.recordsKey as Hex,
    recordsKeyStatement: statement.signature as Hex, recordsKeySeat: s.seat as Hex,
  }, signingSecret);
};
const signerOf = (s: Seat): Signer => ({
  id: ID[s.person]!, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active',
  signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin',
  vaultKeys: keysOf(s, ID[s.person]!),
});
const HONEST: RosterSecrets = { name: 'Acme', signers: [signerOf(ADA), signerOf(BO)] };

beforeAll(() => {
  const account = {
    id: CO, name: 'Acme', createdAt: 'now', signers: HONEST.signers, policy: { threshold: 1 }, wrappedKeys: [],
    recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
  } as unknown as Account;
  store.putAccount(sealAccount(account, KEY, [], 0));
});

/** The company as the service serves it now. */
const served = async (): Promise<SealedAccount & { roster: SealedCompanyRecord | null }> => {
  const r = await sendAs('ada')(`/api/accounts/${CO}`, { method: 'GET' });
  return r.body as never;
};
/** One person's device reading the roster: its own key and entry, the directory and its wallet's read of the chain. */
const readOn = async (s: Seat) => rosterBelievedHere(await served(), KEY, {
  accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads,
  own: { signerId: ID[s.person]!, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex) },
});
/** One seat's device, as it reads the roster to change it. */
const doorsOf = (s: Seat): RosterDoors => ({
  api: async (path, init) => {
    const r = await sendAs(s.person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
    if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status });
    return r.body;
  },
  accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS, reads: acmeReads,
  entered: s.entered,
});

/** Ada's device files the roster's next version as `next` says, through the service's own roster route, which takes it from her believed seat. */
const adaFiles = async (next: RosterSecrets) => {
  const version = ((await served()).roster?.version ?? 0) + 1;
  const rec = signCompanyFiling(sealRoster(CO, next, version, 0, KEY), ADA.signingSecret as Hex);
  const r = await sendAs('ada')(`/api/accounts/${CO}/roster`, {
    method: 'POST',
    body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: next.signers }) }),
  });
  /* The service files it: Ada's seat may file the roster, and it cannot open the roster to see what she changed. */
  expect(r.status).toBe(201);
  /* Her device enters it in the company's records, as it enters everything it files. */
  await ADA.entered.enter([companyRecordEntry(rec)]);
};
const withBo = (edit: (bo: Signer) => Signer): RosterSecrets => ({ name: 'Acme', signers: HONEST.signers.map((x) => (x.id === ID.bo ? edit(x) : x)) });
const shown = (a: Account) => a.signers.map((x) => x.id).sort();

describe('EACH ROSTER ENTRY IS BELIEVED ON ITS OWN SIGNER\'S WITNESSES, NOT ON WHO FILED THE ROSTER', () => {
  it('THE HONEST ROSTER IS READ WHOLE ON EVERY DEVICE', async () => {
    for (const s of [ADA, BO]) {
      const read = await readOn(s);
      /* RED WHEN: an honest entry is refused - a company could then never show its signers. */
      expect(read.refused).toEqual([]);
      expect(shown(read.account)).toEqual([ID.ada, ID.bo]);
    }
  });

  it('BO\'S VAULT KEYS, REWRITTEN BY ADA\'S SEAT, ARE REFUSED ON EVERY DEVICE, AND HIS ENTRY IS NOT SHOWN', async () => {
    /* Ada puts her own records key in Bo's entry, under Bo's committee key, signed with her own signing key. */
    const adas = keysOf(ADA, ID.bo!);
    const rewritten = signVaultKeys(CO, ID.bo!, {
      committeeKey: BO.committeeKey as never, recordsKey: adas.recordsKey, recordsKeyStatement: adas.recordsKeyStatement!, recordsKeySeat: BO.seat as Hex,
    }, ADA.signingSecret as Hex);
    await adaFiles(withBo((bo) => ({ ...bo, vaultKeys: rewritten })));
    for (const s of [ADA, BO]) {
      const read = await readOn(s);
      /* RED WHEN: a device believes vault keys in an entry that the entry's own signing key did not sign. */
      expect(read.refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'vault-keys-not-theirs' }]);
      expect(shown(read.account)).toEqual([ID.ada]);
      /* The version is kept as filed, for a filing from this device to carry on unchanged. */
      expect(read.opened.signers.find((x) => x.id === ID.bo)?.vaultKeys?.signature).toBe(rewritten.signature);
    }
    /* The device that reads the roster to change it refuses the rewrite the same way. */
    expect((await rosterHere(doorsOf(ADA))).refused.map((r) => r.why)).toEqual(['vault-keys-not-theirs']);
  });

  it('VAULT KEYS SIGNED BY BO\'S OWN KEY THAT NAME ANOTHER WALLET THAN THE ONE THAT SIGNED HIS ENTRY ARE REFUSED', async () => {
    /* Only Bo's own key could sign these: his signing key over Ada's wallet's committee key. */
    await adaFiles(withBo((bo) => ({ ...bo, vaultKeys: keysOf(ADA, ID.bo!, BO.signingSecret as Hex) })));
    for (const s of [ADA, BO]) {
      /* RED WHEN: a device takes a committee key for a signer other than the wallet that signed that signer's entry. */
      expect((await readOn(s)).refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'vault-keys-not-theirs' }]);
    }
  });

  it('BO\'S SIGNING KEY, REWRITTEN WITH HIS VAULT KEYS SIGNED BY THE NEW ONE, IS REFUSED ON EVERY DEVICE', async () => {
    const lent = newSigningKeypair();
    await adaFiles(withBo((bo) => ({ ...bo, signingPublicKey: lent.publicKey, vaultKeys: keysOf(BO, ID.bo!, lent.secret) })));
    for (const s of [ADA, BO]) {
      const read = await readOn(s);
      /* RED WHEN: a device believes a signing key other than the one the signer's own wallet signed into the directory for that seat. */
      expect(read.refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'not-their-signing-key' }]);
      expect(shown(read.account)).toEqual([ID.ada]);
    }
  });

  it('BO\'S RIGHTS, REWRITTEN BY ADA\'S SEAT, ARE REFUSED ON EVERY DEVICE', async () => {
    await adaFiles(withBo((bo) => ({ ...bo, rights: { mayApprove: false, everyVault: false, onVaults: [] } })));
    for (const s of [ADA, BO]) {
      const read = await readOn(s);
      /* RED WHEN: a device believes rights the chain did not seat the signer with: the vault check would then count them. */
      expect(read.refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'rights-not-the-chains' }]);
      expect(shown(read.account)).toEqual([ID.ada]);
    }
  });

  it('BO\'S ENTRY NAMING ANOTHER PERSON THAN THE ONE THE DIRECTORY HOLDS HIS SEAT FOR IS REFUSED', async () => {
    await adaFiles(withBo((bo) => ({ ...bo, userId: 'ada' })));
    for (const s of [ADA, BO]) {
      const read = await readOn(s);
      /* RED WHEN: a device believes an entry whose sign-in person is not the person the directory holds that seat for. */
      expect(read.refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'not-their-person' }]);
      expect(shown(read.account)).toEqual([ID.ada]);
    }
  });

  it('AN ENTRY WITH NO SIGN-IN PERSON AT ALL IS REFUSED THE SAME WAY', async () => {
    await adaFiles(withBo((bo) => ({ ...bo, userId: null })));
    /* RED WHEN: an entry with no person is believed for a seat the directory holds for a person. */
    expect((await readOn(ADA)).refused).toEqual([{ signerId: ID.bo, name: 'bo', why: 'not-their-person' }]);
  });

  it('A SEAT THE CHAIN DOES NOT HOLD IS NOT SHOWN, AND THE HONEST ROSTER FILED AGAIN IS READ WHOLE AGAIN', async () => {
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, { ...signerOf(BO), id: 'sgn_dee', name: 'dee', userId: 'dee', leafCommitment: '7e'.repeat(32) as Hex }] });
    /* RED WHEN: an entry is believed for a seat the account does not hold. */
    expect((await readOn(BO)).refused.map((r) => r.why)).toEqual(['seat-not-on-the-chain']);
    await adaFiles(HONEST);
    for (const s of [ADA, BO]) expect((await readOn(s)).refused).toEqual([]);
  });

  it('A NEW SIGNER\'S ENTRY, BEFORE THEIR WALLET HAS SIGNED ANY, IS SHOWN ONLY ON THEIR OWN DEVICE', async () => {
    const cy = newSigningKeypair();
    const seat = '0c'.repeat(32);
    const cyEntry: Signer = { ...signerOf(BO), id: 'sgn_cy', name: 'cy', userId: 'cy', leafCommitment: seat as Hex, signingPublicKey: cy.publicKey, vaultKeys: null };
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, cyEntry] });
    chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat, seat] }, approvals: 1, seatBar: 1 });
    try {
      /* RED WHEN: an entry no wallet signed for is believed on any device but the one whose own key it names. */
      expect((await readOn(ADA)).refused).toEqual([{ signerId: 'sgn_cy', name: 'cy', why: 'no-entry-of-their-own' }]);
      const own = await rosterBelievedHere(await served(), KEY, {
        accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads, own: { signerId: 'sgn_cy', signingPublicKey: cy.publicKey },
      });
      expect(own.refused).toEqual([]);
      expect(own.account.signers.map((x) => x.id)).toContain('sgn_cy');
    } finally {
      chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat] }, approvals: 1, seatBar: 1 });
    }
  });

  it('A NEW SIGNER\'S ENTRY IS NOT BELIEVED ON THE ENTRY A WALLET SIGNED, KEPT BESIDE IT, WHOSEVER WALLET IT IS', async () => {
    const cy = newSigningKeypair();
    const seat = '0c'.repeat(32);
    const wallet = identityFromSecret(new Uint8Array(32).fill(12));
    const own = { committeeKey: committeeKeyFor(wallet, LABEL) as never, statement: signDirectoryEntry(wallet, LABEL, ADDRESS, new Uint8Array(32).fill(112), cy.publicKey, seat) };
    /* The same entry, signed by Ada's wallet, which already signed hers. */
    const adas = identityFromSecret(new Uint8Array(32).fill(ADA.n));
    const byAda = { committeeKey: ADA.committeeKey as never, statement: signDirectoryEntry(adas, LABEL, ADDRESS, new Uint8Array(32).fill(112), cy.publicKey, seat) };
    const cyWith = (directoryEntry: Signer['directoryEntry']): Signer => ({
      ...signerOf(BO), id: 'sgn_cy', name: 'cy', userId: 'cy', leafCommitment: seat as Hex, signingPublicKey: cy.publicKey, vaultKeys: null, directoryEntry,
    });
    chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat, seat] }, approvals: 1, seatBar: 1 });
    try {
      await adaFiles({ name: 'Acme', signers: [...HONEST.signers, cyWith(own)] });
      /* RED WHEN: a new signer's entry is believed on a kept entry before the directory holds their seat's own entry, whose opening proves the wallet. */
      expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_cy', name: 'cy', why: 'no-entry-of-their-own' }]);
      await adaFiles({ name: 'Acme', signers: [...HONEST.signers, cyWith(byAda)] });
      /* RED WHEN: a kept entry signed by a wallet that already holds another seat is believed. */
      expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_cy', name: 'cy', why: 'no-entry-of-their-own' }]);
      await adaFiles({ name: 'Acme', signers: [...HONEST.signers, cyWith({ ...own, statement: { ...own.statement, signature: byAda.statement.signature } })] });
      /* RED WHEN: a kept entry is believed without its wallet's signature verifying. */
      expect((await readOn(BO)).refused).toEqual([{ signerId: 'sgn_cy', name: 'cy', why: 'not-their-signing-key' }]);
    } finally {
      chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat] }, approvals: 1, seatBar: 1 });
      await adaFiles(HONEST);
    }
  });

  it('A KEPT ENTRY IS HELD TO ITS OWN SEAT AND SIGNING KEY, AND NEVER SEATS A WALLET ON ITS OWN', async () => {
    const seat = '0c'.repeat(32);
    const seat2 = '0d'.repeat(32);
    const cy = newSigningKeypair();
    const held = newSigningKeypair();
    const wallet = identityFromSecret(new Uint8Array(32).fill(12));
    const committeeKey = committeeKeyFor(wallet, LABEL) as never;
    const entryFor = (signingKey: string, forSeat: string) => ({ committeeKey, statement: signDirectoryEntry(wallet, LABEL, ADDRESS, new Uint8Array(32).fill(112), signingKey, forSeat) });
    const entry = (id: string, at: string, signingKey: string, directoryEntry: Signer['directoryEntry'], vaultKeys: Signer['vaultKeys'] = null): Signer => ({
      ...signerOf(BO), id, name: id, userId: id, leafCommitment: at as Hex, signingPublicKey: signingKey as Hex, vaultKeys, directoryEntry,
    });
    const cases: Array<[string, Signer[], Array<{ signerId: string; why: string }>]> = [
      /* RED WHEN: a kept entry is believed for a signing key other than the one its wallet signed. */
      ['a key the filer holds, beside the entry Cy\'s wallet signed for his own key', [entry('cy', seat, held.publicKey, entryFor(cy.publicKey, seat))], [{ signerId: 'cy', why: 'not-their-signing-key' }]],
      /* RED WHEN: a kept entry signed for one seat is believed for another. */
      ['an entry Cy\'s wallet signed for another seat', [entry('cy', seat, cy.publicKey, entryFor(cy.publicKey, seat2))], [{ signerId: 'cy', why: 'not-their-signing-key' }]],
      /* RED WHEN: one wallet that signed no directory entry is believed for two signers' kept entries. */
      ['one new wallet behind two entries', [entry('cy', seat, cy.publicKey, entryFor(cy.publicKey, seat)), entry('dee', seat2, held.publicKey, entryFor(held.publicKey, seat2))],
        [{ signerId: 'cy', why: 'no-entry-of-their-own' }, { signerId: 'dee', why: 'no-entry-of-their-own' }]],
      /* RED WHEN: a wallet that signed another seat's directory entry is believed for a kept entry, though no roster entry names it. */
      ['an entry signed by the wallet of a seat the directory holds', [entry('cy', seat, cy.publicKey, (() => {
        const other = identityFromSecret(new Uint8Array(32).fill(14));
        return { committeeKey: committeeKeyFor(other, LABEL) as never, statement: signDirectoryEntry(other, LABEL, ADDRESS, new Uint8Array(32).fill(114), cy.publicKey, seat) };
      })())], [{ signerId: 'cy', why: 'no-entry-of-their-own' }]],
      /* RED WHEN: vault keys naming another wallet, beside a kept entry, are believed. */
      ['vault keys under another wallet, signed by Cy\'s own key', [entry('cy', seat, cy.publicKey, entryFor(cy.publicKey, seat), keysOf(ADA, 'cy', cy.secret))], [{ signerId: 'cy', why: 'no-entry-of-their-own' }]],
    ];
    /* A fourth seat's entry in the directory, signed by a wallet no roster entry names. */
    const other = identityFromSecret(new Uint8Array(32).fill(14));
    const { seat: seat3, opening: elisOpening } = seatOpenedFor(committeeKeyFor(other, LABEL) as never, 14);
    const elisFiling = newSigningKeypair();
    expect(store.fileDirectory(CO, { company: CO, version: store.directoryFilingsOf(CO).length + 1, change: { kind: 'claim', entry: directoryEntryMade({
      company: CO, person: 'eli', committeeKey: committeeKeyFor(other, LABEL) as never, opening: elisOpening, signingSecret: elisFiling.secret, viewingKey: KEY,
      signed: signDirectoryEntry(other, LABEL, ADDRESS, new Uint8Array(32).fill(114), elisFiling.publicKey, seat3),
      /* Invited by Ada's seat, as every seat but the founding one is. */
      invited: signSeatInvitation({ company: CO, invitation: invitationIdOf(newInvitationToken()), person: 'eli', name: 'eli', role: 'admin', leaf: seat3 as Hex }, ADA.signingSecret as Hex),
    }) } })).toBe(true);
    try {
      for (const [what, added, refused] of cases) {
        /* The chain holds every seat the roster names, so no seat is left without an entry. */
        chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat, ...added.map((x) => x.leafCommitment!)] }, approvals: 1, seatBar: 1 });
        await adaFiles({ name: 'Acme', signers: [...HONEST.signers, ...added] });
        expect((await readOn(BO)).refused.map((r) => ({ signerId: r.signerId, why: r.why })), what).toEqual(refused);
      }
      /* Cy's own device, with a key that is not his, and with his key under another entry's name. */
      chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat, seat] }, approvals: 1, seatBar: 1 });
      await adaFiles({ name: 'Acme', signers: [...HONEST.signers, entry('cy', seat, cy.publicKey, null)] });
      for (const own of [{ signerId: 'cy', signingPublicKey: held.publicKey }, { signerId: 'sgn_ada', signingPublicKey: cy.publicKey }]) {
        const read = await rosterBelievedHere(await served(), KEY, { accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads, own });
        /* RED WHEN: a device believes an entry with no wallet's witness that is not its own, by its own key and its own entry both. */
        expect(read.refused.map((r) => r.why)).toEqual(['no-entry-of-their-own']);
      }
    } finally {
      chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat] }, approvals: 1, seatBar: 1 });
      await adaFiles(HONEST);
    }
  });

  it('A RECORDS-KEY STATEMENT IN AN ENTRY THE DEVICE REFUSES DECIDES NOTHING ABOUT WHO FILED THE ROSTER', async () => {
    /* An entry for a seat the chain does not hold, carrying a statement Ada's own wallet once signed over another records key. */
    const adas = identityFromSecret(new Uint8Array(32).fill(ADA.n));
    const stale = signRecordsKey(adas, LABEL, ADDRESS, new Uint8Array(32).fill(250), ADA.seat);
    const dee = newSigningKeypair();
    const deesEntry: Signer = {
      ...signerOf(BO), id: 'sgn_dee', name: 'dee', userId: 'dee', leafCommitment: '7e'.repeat(32) as Hex, signingPublicKey: dee.publicKey,
      vaultKeys: signVaultKeys(CO, 'sgn_dee', {
        committeeKey: ADA.committeeKey as never, recordsKey: stale.recordsKey as Hex, recordsKeyStatement: stale.signature as Hex, recordsKeySeat: ADA.seat as Hex,
      }, dee.secret),
    };
    await adaFiles({ name: 'Acme', signers: [...HONEST.signers, deesEntry] });
    try {
      const read = await readOn(BO);
      /* RED WHEN: the directory read takes statements from an entry the device refused, and so refuses every filing of Ada's seat. */
      expect(read.refused.map((r) => r.why)).toEqual(['seat-not-on-the-chain']);
      expect(shown(read.account)).toEqual([ID.ada, ID.bo]);
    } finally {
      await adaFiles(HONEST);
    }
  });

  it('A FIRST ROSTER SERVED AGAIN, NOT SIGNED BY THE FOUNDING SEAT, IS REFUSED WHOLE', async () => {
    const forged = signCompanyFiling(sealRoster(CO, HONEST, 1, 0, KEY), newSigningKeypair().secret);
    /* RED WHEN: a version 1 is believed on anything but the founding seat's key, though the directory holds that seat's entry. */
    await expect(rosterBelievedHere({ ...(await served()), roster: forged }, KEY, { accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads }))
      .rejects.toThrow(/signed by a seat other than the founding signer's/u);
  });

  it('A FIRST ROSTER IS BELIEVED ONLY AS THE COMPANY\'S FIRST ANCHOR HOLDS IT, ON THE FOUNDING SEAT\'S OWN DEVICE TOO, AND ONLY WHILE NOTHING NEWER IS NAMED', async () => {
    const readServed = async (s: Seat, roster: SealedCompanyRecord) => rosterBelievedHere({ ...(await served()), roster }, KEY, {
      accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads,
      own: { signerId: ID[s.person]!, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex) },
    });
    /* Ada's seat signs a first roster again: the same signers, sealed again, so other bytes than the first anchor holds. */
    const again = signCompanyFiling(sealRoster(CO, HONEST, 1, 0, KEY), ADA.signingSecret as Hex);
    for (const s of [ADA, BO]) {
      /* RED WHEN: a first roster the founding seat signed is believed though the company's first anchor holds another - on her own device too. */
      await expect(readServed(s, again), s.person).rejects.toThrow(/not the bytes the company's records anchor on chain/u);
    }
    const first = store.rosterVersions(CO)[0]!;
    if ((await served()).roster!.version === 1) await adaFiles(HONEST);
    for (const s of [ADA, BO]) {
      /* RED WHEN: the first roster is read as the newest while the company's records name a newer one. */
      await expect(readServed(s, first), s.person).rejects.toThrow(/a newer version of it is in the company's records and the service did not give it/u);
    }
  });

  it('ON THE FOUNDING SIGNER\'S OWN DEVICE, BEFORE ANYTHING IS ANCHORED, ITS FIRST ROSTER IS READ ONLY WHILE NO NEWER VERSION IS NAMED', async () => {
    /* Eve's company, kept sealed under the company's key, nothing of it anchored on its chain: what her own device reads of it. */
    store.putAccount({ ...store.getAccount(OTHER)!, ...sealAccount({
      id: OTHER, name: 'Other', createdAt: 'now', signers: [], policy: { threshold: 1 }, wrappedKeys: [],
      recovery: { signerIds: [], threshold: 1 }, contractAddress: OTHER_ADDRESS, companyLabel: OTHER_LABEL,
    } as unknown as Account, KEY, [], 0), memberUserIds: store.getAccount(OTHER)!.memberUserIds });
    const otherReads = {
      anchored: anchoredOver(apiAs('eve'), OTHER),
      filings: async () => store.directoryFilingsOf(OTHER),
      holders: async () => ({ ...chains.get(OTHER)!.seats, approvals: 1, adoptedVaults: [], account: OTHER_ADDRESS, founding: EVE.seat }) as never,
      leaves: leavesOfTheContract,
    };
    const eveFiles = async (version: number) => {
      const eve: Signer = {
        id: 'sgn_eve', leafCommitment: EVE.seat as Hex, userId: 'eve', name: 'eve', status: 'active',
        signingPublicKey: EVE.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin',
      };
      const rec = signCompanyFiling(sealRoster(OTHER, { name: 'Other', signers: [eve] }, version, 0, KEY), EVE.signingSecret as Hex);
      expect(store.fileRoster(rec)).toBeNull();
      await EVE.entered.enter([companyRecordEntry(rec)]);
      return rec;
    };
    const readOnHers = async (roster: SealedCompanyRecord) => {
      const account = (await sendAs('eve')(`/api/accounts/${OTHER}`, { method: 'GET' })).body as SealedAccount;
      return rosterBelievedHere({ ...account, roster } as never, KEY, {
        accountId: OTHER, label: OTHER_LABEL, account: OTHER_ADDRESS, reads: otherReads,
        own: { signerId: 'sgn_eve', signingPublicKey: signingPublicKeyOf(EVE.signingSecret as Hex) },
      });
    };
    const first = await eveFiles(1);
    /* Her device made it, and nothing newer is named: read before anything is anchored. */
    await expect(readOnHers(first)).resolves.toBeDefined();
    await eveFiles(2);
    /* RED WHEN: on the founding signer's own device, before the first anchor, a first roster is read as the newest while the company's records name a newer one. */
    await expect(readOnHers(first)).rejects.toThrow(/a newer version of it is in the company's records and the service did not give it/u);
  });

  it('A VERSION FILED BY A SEAT THE DEVICE DOES NOT BELIEVE IS REFUSED WHOLE', async () => {
    const now = await served();
    const forged = signCompanyFiling(sealRoster(CO, HONEST, now.roster!.version + 1, 0, KEY), newSigningKeypair().secret);
    /* RED WHEN: a roster filed by a key no believed seat holds is read at all. */
    await expect(rosterBelievedHere({ ...now, roster: forged }, KEY, { accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads }))
      .rejects.toThrow(/does not believe the company's roster/u);
  });
});

describe('A ROSTER THAT LEAVES OUT A SIGNER THE CHAIN SEATS IS REFUSED, AND NO COMMITTEE IS BUILT FROM IT', () => {
  /* Cy is seated on the chain, and his own device filed his seat's entry: its opening proves his wallet, whatever the roster keeps. */
  const CYS = seatOf('cy', 12, LABEL, ADDRESS, CO, ADA);
  const cy = { publicKey: CYS.statement.signingKey as Hex, secret: CYS.signingSecret as Hex };
  const CY_SEAT = CYS.seat;
  const cysCommitteeKey = CYS.committeeKey as { tag: string; value: string };
  const cysEntry = { committeeKey: cysCommitteeKey as never, statement: CYS.statement };
  const cysStatement = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(12)), LABEL, ADDRESS, new Uint8Array(32).fill(112), CY_SEAT);
  const CY: Signer = {
    ...signerOf(BO), id: 'sgn_cy', name: 'cy', userId: 'cy', leafCommitment: CY_SEAT as Hex, signingPublicKey: cy.publicKey,
    vaultKeys: signVaultKeys(CO, 'sgn_cy', {
      committeeKey: cysCommitteeKey as never, recordsKey: cysStatement.recordsKey as Hex,
      recordsKeyStatement: cysStatement.signature as Hex, recordsKeySeat: CY_SEAT as Hex,
    }, cy.secret),
    directoryEntry: cysEntry,
  };
  const WITH_CY: RosterSecrets = { name: 'Acme', signers: [...HONEST.signers, CY] };
  /* Each person's device, reading the roster with nothing kept from an earlier read: the anchor on chain is what a later read is held to. */
  const devices = [
    { who: 'ada', own: { signerId: ID.ada!, signingPublicKey: signingPublicKeyOf(ADA.signingSecret as Hex) } },
    { who: 'bo', own: { signerId: ID.bo!, signingPublicKey: signingPublicKeyOf(BO.signingSecret as Hex) } },
    { who: 'cy', own: { signerId: 'sgn_cy', signingPublicKey: cy.publicKey } },
  ];
  const reads: RosterReads = { filings: acmeReads.filings, holders: acmeReads.holders, anchored: acmeReads.anchored, leaves: acmeReads.leaves };
  const readOn = async (d: (typeof devices)[number], rec?: SealedCompanyRecord) =>
    rosterBelievedHere({ ...(await served()), ...(rec === undefined ? {} : { roster: rec }) }, KEY, {
      accountId: CO, label: LABEL, account: ADDRESS, reads, own: d.own,
    });
  let first: SealedCompanyRecord;

  beforeAll(async () => {
    chains.set(CO, { seats: { ...chains.get(CO)!.seats, seats: [ADA.seat, BO.seat, CY_SEAT] }, approvals: 1, seatBar: 1 });
    expect(store.fileDirectory(CO, { company: CO, version: store.directoryFilingsOf(CO).length + 1, change: { kind: 'claim', entry: CYS.entry } })).toBe(true);
    await adaFiles(WITH_CY);
    first = (await served()).roster!;
    for (const d of devices) {
      const read = await readOn(d);
      /* RED WHEN: an honest roster with a signer whose seat's own directory entry proves his wallet is not read whole. */
      expect(read.refused).toEqual([]);
      expect(read.account.notBelieved).toEqual([]);
    }
  });

  it('A VERSION WITHOUT ANOTHER SIGNER\'S ENTRY IS REFUSED ON EVERY DEVICE, ONE THAT READ IT BEFORE OR NOT', async () => {
    await adaFiles({ name: 'Acme', signers: WITH_CY.signers.filter((x) => x.id !== ID.bo) });
    for (const d of devices) {
      /* RED WHEN: a device reads a roster that has no entry for a seat the account holds on the chain. */
      await expect(readOn(d), d.who).rejects.toThrow(/has no entry for 1 seat\(s\) the company's account holds on the chain/u);
    }
    await adaFiles(WITH_CY);
    for (const d of devices) expect((await readOn(d)).refused).toEqual([]);
  });

  it('A VERSION WITH THE ENTRY CY\'S WALLET SIGNED STRIPPED STILL SHOWS HIM ON EVERY DEVICE, ONE THAT READ IT BEFORE OR NOT', async () => {
    await adaFiles({ name: 'Acme', signers: WITH_CY.signers.map((x) => (x.id === 'sgn_cy' ? { ...x, directoryEntry: null } : x)) });
    try {
      for (const d of devices) {
        const read = await readOn(d);
        /* RED WHEN: stripping the entry kept beside a signer's keys hides a signer whose seat's own directory entry proves his wallet. */
        expect(read.refused, d.who).toEqual([]);
        expect(read.account.notBelieved, d.who).toEqual([]);
      }
    } finally {
      await adaFiles(WITH_CY);
    }
  });

  it('AN OLDER VERSION, OR ANOTHER RECORD UNDER A VERSION ALREADY BELIEVED, IS REFUSED ON A DEVICE THAT READ THE NEWER ONE', async () => {
    for (const d of devices) {
      /* RED WHEN: a device reads a version older than the newest the company's records name - the service withholding the newest.
       * The anchor, and nothing a device kept, is what refuses it. */
      await expect(readOn(d, first), d.who).rejects.toThrow(/a newer version of it is in the company's records and the service did not give it/u);
    }
    const now = (await served()).roster!;
    /* Bo's device reads the version now served, and is then served another record under that version. */
    expect((await readOn(devices[1]!)).version).toBe(now.version);
    const twin = signCompanyFiling(sealRoster(CO, WITH_CY, now.version, 0, KEY), ADA.signingSecret as Hex);
    /* RED WHEN: a second record under the version a device believed is read as that version - bytes no entry names. */
    await expect(readOn(devices[1]!, twin)).rejects.toThrow(/no entry in the company's records names it/u);
    /* The committee as the roster names it, with Cy, is not refused for want of a signer. */
    const whole = await readOn(devices[0]!);
    expect(whyNotWhole(whole.account)).toBeNull();
  });
});

describe('A ROSTER SHORT OF A SEAT THE CHAIN HOLDS, WHILE A DIRECTORY VERSION IS PASSED OVER', () => {
  /** Ada's device anchoring the company's records, the service handing it every directory filing but `without`. */
  const anchorAsAda = (without: number) => anchorTheRecordsHere({
    accountId: CO,
    material: { signingSecret: ADA.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
    manifest: manifestServiceFor(apiAs('ada')),
    tree: treeServiceFor(apiAs('ada')),
    directory: () => acmeDirectoryWithItsFold(),
    directoryFilings: async () => store.directoryFilingsOf(CO).filter((f) => f.version !== without),
    onChain: acmeChain.onChain,
    service: {
      callState: async () => ({ account: ADDRESS }) as never,
      sendProven: async (_c, tx) => {
        const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
        acmeChain.move(previous, batch, held, tag);
      },
      sealedProposals: async (c) => store.listProposals(c),
      foundingRecords: anchorServiceFor(apiAs('ada')).foundingRecords,
    },
    builder: { ...anchorFunctions, anchor: anchorSentInATest },
  });
  /** Ada's role set again by her own quorum of one, as the directory's next version. */
  const adaAdmin = async (): Promise<number> => {
    const version = store.directoryFilingsOf(CO).length + 1;
    const unsigned = { kind: 'role', seat: ADA.seat, role: 'admin', threshold: 1, signatures: [] } as unknown as DirectoryChange;
    const signature = sign(directoryChangeMessage(CO, version, unsigned), ADA.signingSecret);
    const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
    expect((await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) })).status).toBe(201);
    return version;
  };

  it('IS REFUSED WHOLE, SAYING THE WAY PAST THE VERSION PASSED OVER RATHER THAN ONLY ASKING A SIGNER TO OPEN IT', async () => {
    const passed = await adaAdmin();
    await adaAdmin();
    await anchorAsAda(passed);
    const seat = 'c3'.repeat(32);
    const was = chains.get(CO)!;
    /* The chain holds a seat nobody invited and the roster has no entry for. */
    chains.set(CO, { seats: { ...was.seats, seats: [...was.seats.seats, seat] }, approvals: was.approvals, seatBar: was.seatBar });
    try {
      /* RED WHEN: the refusal for a roster short of a seat leaves out the way past a directory version passed over. */
      await expect(readOn(ADA)).rejects.toThrow(new RegExp(`it has no entry for 1 seat\\(s\\) .* The way past it: the company's records passed over version ${passed} of its directory`, 'u'));
    } finally {
      chains.set(CO, was);
    }
  });
});
