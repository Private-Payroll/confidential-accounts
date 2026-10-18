/**
 * **A ROSTER VERSION EVERY DEVICE REFUSES, FOR WHO FILED IT OR FOR A SIGNER IT
 * LEAVES OUT, IS FOLLOWED BY THE NEXT VERSION FILED ABOVE IT.**
 *
 * A device reads the roster to change it (`rosterHere`) afresh each time and
 * keeps nothing between reads. When the newest version is refused only for its
 * filer or for a seat the chain holds that it leaves out, the next version is
 * built from what this device believes on its own: every entry of the refused
 * version except those refused for good, and for a seat it leaves out the
 * newest entry an older version names, as the company's records hold that
 * version. It is filed above every version served. A version served short of
 * the company's records, or as other bytes, is never followed: that is the
 * service withholding the roster, which a version filed over it would hide.
 *
 * Over real HTTP: Ada, Bo and Cy are seated and believed; Ada's seat is an
 * admin, Bo's an approver, which files no roster. The chain's read is the test's.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
/*
 * The company's one check as the roster's reader uses it, with one stand-in a case may set: the key epoch it holds in
 * force (`inForce`). While set, a roster handed over as sealed at an older epoch is refused, as the check refuses one
 * entered after a change of the key; a reader that hands over no epoch is never refused by it.
 */
const oneCheck = vi.hoisted(() => ({ inForce: null as number | null }));
vi.mock('vaults-web-shared/vault-page-doors.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('vaults-web-shared/vault-page-doors.js')>();
  return {
    ...real,
    judgeIn: (here: Parameters<typeof real.judgeIn>[0]) => {
      const judge = real.judgeIn(here);
      return Object.assign((...args: Parameters<typeof judge>) => {
        const sealedAt = args[5];
        if (oneCheck.inForce !== null && typeof sealedAt === 'number' && sealedAt < oneCheck.inForce) return 'it is sealed under an older key than the one in force';
        return judge(...args);
      }, judge);
    },
  };
});
import { identityFromSecret } from 'midnight-identity';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { openAccount, sealAccount } from '../core/account.js';
import { signedFoundingRoster, sealRoster, type RosterSecrets } from '../core/roster-record.js';
import { signVaultKeys, vaultKeyIndexOf } from '../core/vault-keys.js';
import type { Account, SealedAccount, Signer } from '../core/types.js';
import { signCompanyFiling, toCompanyWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import {
  fileTheRosterFollowedHere, foldOffersHere, offerVaultKeysHere, rosterBelievedHere, rosterHere, type RosterDoors,
} from 'vaults-web-shared/roster-here.js';
import { signerRoutes } from './signer-routes.js';
import {
  aCompanyOfTwoSeats, acmeReads, ADA, ADDRESS, apiAs, BO, chains, CO, KEY, LABEL, seatOf, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats((app, deps) => {
  app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
    const id = String(req.params.id);
    res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
  });
  app.use(signerRoutes({
    signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
    ledger: { status: async () => null, holdsSigner: async (_a, seat) => (chains.get(CO)?.seats.seats ?? []).includes(String(seat)) },
  }));
}, { roster: () => signedFoundingRoster(CO, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO)] }, KEY, ADA.signingSecret as Hex) });

/** A seat's own vault keys, signed with its own signing key, with its wallet's statement over its records key. */
const keysOf = (s: Seat, signerId: string) => {
  const statement = signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat);
  return signVaultKeys(CO, signerId, {
    committeeKey: s.committeeKey as never, recordsKey: statement.recordsKey as Hex,
    recordsKeyStatement: statement.signature as Hex, recordsKeySeat: s.seat as Hex,
  }, s.signingSecret as Hex);
};
/** `s`'s roster entry as an honest filing gives it, with their vault keys unless `keys` is false. */
function entryOf(s: Seat, id = `sgn_${s.person}`, keys = true): Signer {
  return {
    id, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active',
    signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin',
    vaultKeys: keys ? keysOf(s, id) : null,
  };
}

const CY = seatOf('cy', 12, LABEL, ADDRESS, CO, ADA);
const DEE = seatOf('dee', 13, LABEL, ADDRESS, CO, ADA);

const onChain = (...seats: Seat[]) => chains.set(CO, {
  seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals: 1, seatBar: 1,
});
const served = async (): Promise<SealedAccount & { roster: SealedCompanyRecord | null }> =>
  (await sendAs('ada')(`/api/accounts/${CO}`, { method: 'GET' })).body as never;
const readOn = async (s: Seat) => rosterBelievedHere(await served(), KEY, {
  accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads,
  own: { signerId: `sgn_${s.person}`, signingPublicKey: signingPublicKeyOf(s.signingSecret as Hex) },
});
const doorsOf = (s: Seat, api = apiAs(s.person)): RosterDoors => ({
  api, accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads, entered: s.entered,
});
/** `by`'s device files the roster's next version as `next` says, through the service's own roster route, and enters it. */
const files = async (by: Seat, next: RosterSecrets) => {
  const version = ((await served()).roster?.version ?? 0) + 1;
  const rec = signCompanyFiling(sealRoster(CO, next, version, 0, KEY), by.signingSecret as Hex);
  const r = await sendAs(by.person)(`/api/accounts/${CO}/roster`, {
    method: 'POST',
    body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers: next.signers }) }),
  });
  expect(r.status).toBe(201);
  await by.entered.enter([companyRecordEntry(rec)]);
  return version;
};
/** The newest version as the service keeps it, opened. */
const newest = () => {
  const rec = store.newestRoster(CO)!;
  return { version: rec.version, signers: openAccount({ ...store.getAccount(CO)!, roster: rec } as never, KEY, rec).signers };
};
const shown = (a: Account) => a.signers.map((x) => x.id).sort();
const leftOut = /has no entry for 1 seat\(s\) the company's account holds on the chain/u;

beforeAll(() => {
  const account = {
    id: CO, name: 'Acme', createdAt: 'now', signers: [entryOf(ADA), entryOf(BO)], policy: { threshold: 1 }, wrappedKeys: [],
    recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
  } as unknown as Account;
  store.putAccount(sealAccount(account, KEY, [], 0));
  /* Cy was admitted and his own device filed his entry: every device believes him. */
  expect(store.fileDirectory(CO, { company: CO, version: store.directoryFilingsOf(CO).length + 1, change: { kind: 'claim', entry: CY.entry } })).toBe(true);
  onChain(ADA, BO, CY);
});

describe('A VERSION EVERY DEVICE REFUSES IS FOLLOWED', () => {
  it('ONE THAT LEAVES A SIGNER OUT IS FOLLOWED BY A VERSION CARRYING THAT SIGNER AND EVERY ENTRY OF IT THIS DEVICE BELIEVES', async () => {
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY, 'sgn_cy', false)] });
    for (const s of [ADA, BO, CY]) expect((await readOn(s)).refused).toEqual([]);
    /* Ada's seat files Cy's vault keys folded in, and leaves Bo out: every device refuses the version whole. */
    const refused = await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(CY)] });
    for (const s of [ADA, BO, CY]) await expect(readOn(s), s.person).rejects.toThrow(leftOut);
    /* RED WHEN: no version can be filed after a version every device refuses. */
    expect(await fileTheRosterFollowedHere(doorsOf(ADA))).toBe(refused + 1);
    for (const s of [ADA, BO, CY]) {
      const read = await readOn(s);
      /* RED WHEN: the version that follows leaves out the signer the refused one left out, taken from no older version. */
      expect(read.refused, s.person).toEqual([]);
      expect(shown(read.account), s.person).toEqual(['sgn_ada', 'sgn_bo', 'sgn_cy']);
      /* RED WHEN: the version that follows drops an entry of the refused version this device believes on its own. */
      expect(read.account.signers.find((x) => x.id === 'sgn_cy')?.vaultKeys?.signature, s.person).toBe(entryOf(CY).vaultKeys!.signature);
    }
    /* Nothing is refused now, so nothing is followed. */
    expect(await fileTheRosterFollowedHere(doorsOf(ADA))).toBeNull();
  });

  it('ONE FILED BY A SEAT WHOSE ROLE FILES NO ROSTER IS FOLLOWED, AND NEVER BY SUCH A SEAT\'S OWN DEVICE', async () => {
    const honest: RosterSecrets = { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY)] };
    const bos = await files(BO, honest);
    for (const s of [ADA, BO, CY]) await expect(readOn(s), s.person).rejects.toThrow(/does not believe the company's roster/u);
    /* RED WHEN: a seat whose role files no roster files the version that follows, which every device refuses in turn. */
    expect(await fileTheRosterFollowedHere(doorsOf(BO))).toBeNull();
    expect(store.newestRoster(CO)!.version).toBe(bos);
    /* RED WHEN: a version refused for who filed it is not followed by a seat that may file one. */
    expect(await fileTheRosterFollowedHere(doorsOf(ADA))).toBe(bos + 1);
    for (const s of [ADA, BO, CY]) expect(shown((await readOn(s)).account), s.person).toEqual(['sgn_ada', 'sgn_bo', 'sgn_cy']);
  });
});

describe('A VERSION REFUSED FOR WHO FILED IT CARRIES ONLY WHAT EACH ENTRY BINDS', () => {
  it('TAKES EACH SIGNER\'S NAME, ROLE AND WRAPPING KEY FROM THE NEWEST VERSION FILED BY A SEAT THAT MAY FILE ONE', async () => {
    const pick = (xs: readonly Signer[]) => xs.map((x) => ({ id: x.id, name: x.name, userId: x.userId, role: x.role, wrapping: x.wrappingPublicKey }));
    const believed = pick(newest().signers);
    /* Bo's seat, whose role files no roster, renames Ada, makes Cy a viewer and gives him another wrapping key. */
    const altered = newest().signers.map((x) => (x.id === 'sgn_ada' ? { ...x, name: 'mallory' }
      : x.id === 'sgn_cy' ? { ...x, role: 'viewer' as const, wrappingPublicKey: 'cd'.repeat(32) as Hex } : x));
    const bos = await files(BO, { name: 'Acme', signers: altered });
    for (const s of [ADA, BO, CY]) await expect(readOn(s), s.person).rejects.toThrow(/does not believe the company's roster/u);
    expect(await fileTheRosterFollowedHere(doorsOf(ADA))).toBe(bos + 1);
    /* RED WHEN: a version every device refuses for who filed it has what no entry check binds re-filed under an honest seat's key. */
    expect(pick(newest().signers)).toEqual(believed);
  });
});

describe('THE VERSION FILED NEXT DROPS ONLY ENTRIES REFUSED FOR GOOD', () => {
  it('CARRIES AN ENTRY WAITING FOR ITS SIGNER\'S OWN DIRECTORY ENTRY, AND DROPS ONE GIVING RIGHTS THE CHAIN NEVER GAVE OR NAMING ANOTHER PERSON', async () => {
    /* Dee is admitted: her entry is believed only on her own device until her own device files her directory entry. */
    onChain(ADA, BO, CY, DEE);
    const junk: Signer = { ...entryOf(CY, 'sgn_junk'), name: 'junk', rights: { mayApprove: false, everyVault: false, onVaults: [] } as never };
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY), entryOf(DEE, 'sgn_dee', false), junk] });
    expect((await readOn(BO)).refused.map((r) => r.why)).toEqual(['no-entry-of-their-own', 'rights-not-the-chains']);
    /* Bo gives his vault keys again, and Ada's device folds them in: the one filing a fold makes. */
    await offerVaultKeysHere(apiAs('bo'), CO, {
      signerId: 'sgn_bo', signingSecret: BO.signingSecret as Hex, committeeKey: BO.committeeKey as never, viewingKey: KEY as Hex,
      companyKey: toHex(new Uint8Array(32).fill(BO.n + 100)) as Hex, entry: BO.statement,
      recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(BO.n)), LABEL, ADDRESS, new Uint8Array(32).fill(BO.n + 100), BO.seat),
    });
    expect((await foldOffersHere(doorsOf(ADA))).folded).toEqual([BO.seat]);
    const ids = newest().signers.map((x) => x.id);
    /* RED WHEN: a just-admitted signer's entry is dropped by another device's filing before their own directory entry is filed. */
    expect(ids).toContain('sgn_dee');
    /* RED WHEN: an entry refused for good is carried on by every honest filing. */
    expect(ids).not.toContain('sgn_junk');
    /* Ada's seat then files Cy's seat under another sign-in's entry alone: the directory holds that seat for Cy. */
    const stranger: Signer = { ...entryOf(CY, 'sgn_stranger'), name: 'stranger', userId: 'stranger' };
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), stranger, entryOf(DEE, 'sgn_dee', false)] });
    expect((await readOn(BO)).refused.map((r) => r.why)).toContain('not-their-person');
    const carried = (await rosterHere(doorsOf(ADA))).carried.signers.filter((x) => x.leafCommitment === CY.seat).map((x) => x.id);
    /* RED WHEN: an entry naming another person than the directory holds its seat for is carried on, in place of the entry an earlier version holds for that seat. */
    expect(carried).toEqual(['sgn_cy']);
  });
});

describe('A VERSION THE SERVICE SERVES SHORT, OR AS OTHER BYTES, IS NEVER FOLLOWED', () => {
  it('IS REFUSED, AND NOTHING IS FILED OVER IT', async () => {
    const versions = store.rosterVersions(CO);
    const top = versions.at(-1)!;
    const older = versions.at(-2)!;
    const otherBytes = signCompanyFiling(sealRoster(CO, { name: 'Acme', signers: newest().signers }, top.version, 0, KEY), ADA.signingSecret as Hex);
    for (const [what, roster] of [['an older version as the newest', older], ['other bytes under the newest version', otherBytes]] as const) {
      const serving = async (path: string, init?: RequestInit) => {
        const body = await apiAs('ada')(path, init);
        return path === `/api/accounts/${CO}` ? { ...body, roster } : body;
      };
      /* RED WHEN: a version the company's records show withheld or changed is followed, hiding what the service did. */
      await expect(rosterHere(doorsOf(ADA, serving)), what).rejects.toThrow(/Nothing was filed/u);
      await expect(fileTheRosterFollowedHere(doorsOf(ADA, serving)), what).rejects.toThrow(/Nothing was filed/u);
      expect(store.newestRoster(CO)!.version, what).toBe(top.version);
    }
  });
});

describe('A VERSION FOLLOWED AFTER THE COMPANY\'S KEY CHANGES', () => {
  it('IS HELD BY ITS READER TO THE KEY IN FORCE: ONE SEALED UNDER AN OLDER KEY IS REFUSED', async () => {
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY)] });
    oneCheck.inForce = 1;
    try {
      /* RED WHEN: the roster's reader hands the check no epoch, so a roster sealed under the key the signer who left holds is believed. */
      await expect(readOn(ADA)).rejects.toThrow(/sealed under an older key than the one in force/u);
    } finally {
      oneCheck.inForce = null;
    }
    /* The control: with no newer key in force, the same roster is not refused for its key. */
    expect(await readOn(ADA).then(() => 'read', (e: Error) => e.message)).not.toMatch(/older key/u);
  });

  it('IS NOT FILED WHILE THE COMPANY\'S KEY IS BEING CHANGED', async () => {
    const { CompanyKeyBeingChanged } = await import('vaults-web-shared/company-key-here.js');
    /* The company's keys after a signer's removal is carried out on the chain, before the key they held is replaced. */
    const paused = {
      epoch: 0, key: KEY as Hex, newest: 0, keyAt: (): Hex => KEY as Hex,
      sealing: () => { throw new CompanyKeyBeingChanged('the company\'s key is being changed'); },
    };
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY)] });
    const refused = await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(CY)] });
    /* RED WHEN: the roster's next version is sealed without asking whether sealing is paused. */
    await expect(fileTheRosterFollowedHere({ ...doorsOf(ADA), viewingKey: paused })).rejects.toThrow(CompanyKeyBeingChanged);
    expect(store.newestRoster(CO)!.version).toBe(refused);
  });

  it('IS SEALED UNDER THE KEY IN FORCE, AND EVERY OLDER VERSION IS STILL READ UNDER ITS OWN EPOCH\'S KEY', async () => {
    const key1 = toHex(new Uint8Array(32).fill(0x7e)) as Hex;
    /* A staying seat's keys after one change of the key: the new one in force, the founding key reached through it. */
    const after = {
      epoch: 1, key: key1, newest: 1,
      keyAt: (e: number): Hex => { if (e === 0) return KEY; if (e === 1) return key1; throw new Error(`no key at epoch ${e}`); },
      sealing: () => ({ key: key1, epoch: 1 }),
    };
    await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(BO), entryOf(CY)] });
    const refused = await files(ADA, { name: 'Acme', signers: [entryOf(ADA), entryOf(CY)] });
    /* RED WHEN: a version sealed before the change is not read under the founding key it was sealed with, so nothing can follow it. */
    expect(await fileTheRosterFollowedHere({ ...doorsOf(ADA), viewingKey: after })).toBe(refused + 1);
    const rec = store.newestRoster(CO)!;
    /* RED WHEN: the version followed after the change is sealed at the epoch of a key the signer who left still holds. */
    expect(rec.keyEpoch).toBe(1);
    expect(() => openAccount({ ...store.getAccount(CO)!, roster: rec } as never, KEY, rec)).toThrow();
    /* RED WHEN: a device holding the company's keys does not read the new version under the key of its own epoch. */
    const read = await rosterBelievedHere(await served(), after, {
      accountId: CO, label: LABEL, account: ADDRESS, reads: acmeReads,
      own: { signerId: 'sgn_ada', signingPublicKey: signingPublicKeyOf(ADA.signingSecret as Hex) },
    });
    expect(shown(read.account)).toEqual(['sgn_ada', 'sgn_bo', 'sgn_cy']);
  });
});
