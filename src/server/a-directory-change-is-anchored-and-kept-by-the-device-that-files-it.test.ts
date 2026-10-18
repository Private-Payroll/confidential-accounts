/**
 * **A SIGNED CHANGE TO THE COMPANY'S DIRECTORY IS ANCHORED AT ONCE BY THE DEVICE
 * THAT FILES IT, AND KEPT THERE UNTIL IT IS ANCHORED.** A change not yet anchored
 * is counted against who holds the account when it is anchored, so one left
 * waiting can be lost to a change of the account's holders; and one the service
 * drops is never anchored at all unless the device that filed it still has it.
 * The super admins are no record here: who they are is the chain's alone.
 *
 * Over real HTTP with the company's directory and record tree as the service
 * keeps them, and the test's chain.
 */
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { newSymmetricKey, randomBytes, sign, toHex, type Hex } from '../core/crypto.js';
import { keyCheckOf, sealedPrevious, sealedSeed, wrapsFor } from '../core/company-key.js';
import {
  directoryChangeMessage, type DirectoryFiling, type QuorumChange, type RotateChange,
} from '../midnight/seat-directory.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchoredOnTheWayIn, anchorServiceFor, directoryChangeFiledHere, type AnchorDoors } from 'vaults-web-shared/records-anchored-here.js';
import { anchorFunctions, anchorSentInATest } from '../testing/record-tree-double.js';
import { treeKeptHere, treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectory, acmeDirectoryWithItsFold, ADA, ADDRESS, apiAs, BO, CO, sendAs, store, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats();

/** A seat's device anchoring, filing through `file` - the service as it is, unless a test says otherwise. */
const doorsOf = (s: Seat, kept = treeKeptInMemory(), file?: AnchorDoors['fileDirectory']): AnchorDoors => ({
  accountId: CO,
  changes: kept.changes,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(apiAs(s.person)),
  tree: treeServiceFor(apiAs(s.person)),
  directory: () => acmeDirectoryWithItsFold(),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  fileDirectory: file ?? (async (filing) => {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${filing.version}`, { method: 'POST', body: JSON.stringify(filing) });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }),
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_c, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
    },
    sealedProposals: async (c) => store.listProposals(c),
    foundingRecords: anchorServiceFor(apiAs(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

/** A quorum's change before it is signed. */
type UnsignedQuorum = Omit<Extract<QuorumChange, { kind: 'role' }>, 'signatures'> | Omit<Extract<QuorumChange, { kind: 'retire' }>, 'signatures'>;
/** `change` signed by `by`'s filing keys for the directory's next version, as a quorum signs it. */
const signedNext = (change: UnsignedQuorum, by: readonly Seat[]): { change: QuorumChange; version: number } => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { ...change, signatures: [] } as unknown as QuorumChange;
  const message = directoryChangeMessage(CO, version, unsigned);
  return { version, change: { ...unsigned, signatures: by.map((s) => ({ publicKey: s.statement.signingKey as Hex, signature: sign(message, s.signingSecret) })) } as QuorumChange };
};
const anchoredVersions = async () => [...(await acmeDirectory()).records.directory.keys()];
const roleOf = async (s: Seat) => (await acmeDirectory()).dir.seats.find((x) => x.seat === s.seat)?.role;

describe('A SIGNED CHANGE FILED FROM A DEVICE', () => {
  it('IS ANCHORED AT ONCE BY THAT DEVICE, AND KEPT THERE UNTIL A VERSION CARRYING IT IS ANCHORED', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = signedNext({ kind: 'role', seat: BO.seat, role: 'initiator', threshold: 1 }, [ADA]);
    const filed = await directoryChangeFiledHere(doorsOf(ADA, kept), change, version);
    /* RED WHEN: a change filed waits for a later anchor, so a change of who holds the account can lose it first. */
    expect(filed.anchor).toMatchObject({ anchored: expect.any(Number) });
    expect(await anchoredVersions()).toContain(version);
    expect(await roleOf(BO)).toBe('initiator');
    /* Kept until a way in sees a version carrying it anchored; then let go of. RED WHEN: it is kept and filed again for ever. */
    expect((await kept.changes.all(CO)).map((k) => k.signedAt)).toEqual([version]);
    expect(await anchoredOnTheWayIn(doorsOf(ADA, kept))).not.toHaveProperty('filedAgain');
    expect(await kept.changes.all(CO)).toEqual([]);
  });

  it('A CHANGE THE SERVICE DROPS IS FILED AGAIN FROM WHAT THE DEVICE KEPT, WITHOUT BEING SIGNED AGAIN, AND ANCHORED', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = signedNext({ kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 }, [ADA]);
    /* The service answers the filing and keeps nothing of it. */
    const dropped = await directoryChangeFiledHere(doorsOf(ADA, kept, async () => {}), change, version);
    expect(dropped.version).toBe(version);
    expect(store.directoryFilingsOf(CO).length).toBe(version - 1);
    expect(await roleOf(BO)).toBe('initiator');
    /* RED WHEN: the device keeps nothing before it files, so a change the service drops is lost and its seats must sign it again. */
    expect(await anchoredOnTheWayIn(doorsOf(ADA, kept))).toMatchObject({ filedAgain: 'directory-changes', anchored: expect.any(Number) });
    expect(store.directoryFilingsOf(CO)[version - 1]).toEqual({ company: CO, version, change });
    expect(await anchoredVersions()).toContain(version);
    expect(await roleOf(BO)).toBe('approver');
  });

  it('AN ANCHOR REFUSED AFTER THE FILING IS SAID, NOT THROWN, AND THE CHANGE STAYS KEPT UNTIL A LATER WAY IN ANCHORS IT', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = signedNext({ kind: 'role', seat: BO.seat, role: 'initiator', threshold: 1 }, [ADA]);
    /* This device's anchors are not sent: the chain answers nothing to them. */
    const working = doorsOf(ADA, kept);
    const refusing: AnchorDoors = { ...working, service: { ...working.service, sendProven: async () => { throw new Error('the node is down'); } } };
    const filed = await directoryChangeFiledHere(refusing, change, version);
    /* RED WHEN: an anchor refused after the change was filed is thrown, so a filing that landed reads as failed. */
    expect(filed).toMatchObject({ version, anchor: { notAnchored: expect.stringMatching(/the anchor was not sent/u) } });
    expect(store.directoryFilingsOf(CO)[version - 1]).toEqual({ company: CO, version, change });
    expect(await anchoredVersions()).not.toContain(version);
    /* RED WHEN: a change filed and not anchored is let go of, so a later loss of it cannot be filed again. */
    expect(await anchoredOnTheWayIn(refusing)).toHaveProperty('notAnchored');
    expect((await kept.changes.all(CO)).map((k) => k.signedAt)).toEqual([version]);
    expect(await anchoredOnTheWayIn(working)).toMatchObject({ anchored: expect.any(Number) });
    expect(await anchoredVersions()).toContain(version);
    await anchoredOnTheWayIn(working);
    expect(await kept.changes.all(CO)).toEqual([]);
  });

  it('A CHANGE THE SERVICE DROPS, FILED AGAIN ON A WAY IN WHOSE ANCHOR IS REFUSED, IS SAID AND STAYS KEPT FOR THE NEXT', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = signedNext({ kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 }, [ADA]);
    await directoryChangeFiledHere(doorsOf(ADA, kept, async () => {}), change, version);
    const working = doorsOf(ADA, kept);
    const refusing: AnchorDoors = { ...working, service: { ...working.service, sendProven: async () => { throw new Error('the node is down'); } } };
    /* RED WHEN: a change filed again and then refused its anchor is thrown, or let go of with nothing anchored. */
    expect(await anchoredOnTheWayIn(refusing)).toMatchObject({ filedAgain: 'directory-changes', notAnchored: expect.stringMatching(/the anchor was not sent/u) });
    expect((await kept.changes.all(CO)).map((k) => k.signedAt)).toEqual([version]);
    expect(await anchoredOnTheWayIn(working)).toMatchObject({ anchored: expect.any(Number) });
    expect(await roleOf(BO)).toBe('approver');
  });

  it('A CHANGE SIGNED FOR A VERSION THE DIRECTORY HAS MOVED PAST IS NOT FILED OR KEPT', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = signedNext({ kind: 'role', seat: BO.seat, role: 'initiator', threshold: 1 }, [ADA]);
    /* RED WHEN: a change is filed or kept under signatures that bind another version than the next. */
    await expect(directoryChangeFiledHere(doorsOf(ADA, kept), change, version - 1)).rejects.toThrow(/have it signed again/iu);
    expect(await kept.changes.all(CO)).toEqual([]);
    expect(store.directoryFilingsOf(CO).length).toBe(version - 1);
  });
});

/** A change of the company's key, signed by Ada's filing key for the directory's next version. */
const rotationNext = (): { change: RotateChange; version: number } => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const key = newSymmetricKey();
  const unsigned = {
    kind: 'rotate', epoch: 1, keyCheck: keyCheckOf(CO, 1, key), after: 1,
    wraps: wrapsFor(key, [ADA, BO].map((s) => ({ seat: s.seat, wrappingKey: s.statement.wrappingKey as Hex }))),
    previous: sealedPrevious(key, newSymmetricKey()), seed: { epoch: 1, sealed: sealedSeed(key, toHex(randomBytes(32))) }, waiting: [],
    signatures: [],
  } as unknown as RotateChange;
  const message = directoryChangeMessage(CO, version, unsigned);
  return { version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature: sign(message, ADA.signingSecret) }] } as RotateChange };
};

describe('A CHANGE OF THE COMPANY\'S KEY IS NEVER KEPT ON THE DEVICE OR FILED AGAIN FROM IT', () => {
  it('a change of key filed from a device is not kept, even when the service drops it', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = rotationNext();
    await directoryChangeFiledHere(doorsOf(ADA, kept, async () => {}), change, version);
    /* RED WHEN: a change of key is kept before it is filed, so a lost one is filed again under its old signatures. */
    expect(await kept.changes.all(CO)).toEqual([]);
    expect(store.directoryFilingsOf(CO).length).toBe(version - 1);
  });

  it('a change of key a device\'s store hands back is never filed again on the way in', async () => {
    const kept = treeKeptInMemory();
    const { change, version } = rotationNext();
    /* A store that holds one anyway, at the directory's next version. */
    await kept.changes.keep(CO, { signedAt: version, change });
    const filed: DirectoryFiling[] = [];
    await anchoredOnTheWayIn(doorsOf(ADA, kept, async (f) => { filed.push(f); }));
    /* RED WHEN: a change of key kept on the device is offered to be filed again on the way in. */
    expect(filed.filter((f) => f.change.kind === 'rotate')).toEqual([]);
  });

  it('a change of key written in the browser\'s own database is never read back as one to file again', async () => {
    const db = new IDBFactory();
    const { change, version } = rotationNext();
    const role = signedNext({ kind: 'role', seat: BO.seat, role: 'approver', threshold: 1 }, [ADA]);
    await treeKeptHere(db).changes.keep(CO, { signedAt: version, change });
    await treeKeptHere(db).changes.keep(CO, { signedAt: version + 1, change: role.change });
    /* RED WHEN: a change of key is read back from the database as a change to file again. */
    expect((await treeKeptHere(db).changes.all(CO)).map((k) => [k.signedAt, k.change.kind])).toEqual([[version + 1, 'role']]);
  });
});

describe('WHO THE SUPER ADMINS ARE IS NEVER FILED IN THE DIRECTORY', () => {
  it('a record naming seats beside the keys of a new committee is refused by the service and stored nowhere', async () => {
    const before = store.directoryFilingsOf(CO).length;
    const version = before + 1;
    const record = {
      company: CO, version,
      change: {
        kind: 'super-admins', given: [ADA.seat], taken: [BO.seat], committee: [ADA.committeeKey], threshold: 1,
        contracts: [{ address: ADDRESS as string, counter: '0' }], signatures: [],
      },
    };
    const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(record) });
    /* RED WHEN: the service keeps a record that puts a seat beside a committee key, or any record of who the super admins are. */
    expect([r.status, (r.body as { refused?: string }).refused]).toEqual([422, 'not-a-change']);
    expect(store.directoryFilingsOf(CO).length).toBe(before);
  });
});
