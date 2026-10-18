/**
 * **THE COMPANY'S KEY AT EVERY EPOCH, AND ITS CHANGE AFTER A SIGNER LEAVES, ON
 * EACH SIGNER'S OWN DEVICE** (`companyKeyHere`, `rotateTheCompanyKeyHere`).
 * Most cases run over a directory double: the company's directory judged by
 * the directory's own judge (`applyFiling`) as each change is filed, the
 * versions the anchor holds with the digest of each filing, and the seats the
 * chain holds. The last case follows one removal over real HTTP, as
 * `a-company-whose-signers-change-on-the-chain` names its stand-ins, from the
 * approvals to the changed key each device then reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromHex, newSigningKeypair, newSymmetricKey, sign, type Hex } from '../../../src/core/crypto.js';
import { keyCheckOf, openedSeed, sealedPrevious, sealedSeed, wrapsFor } from '../../../src/core/company-key.js';
import { inboxPublicKey, sealToInbox } from '../../../src/core/sealed-records.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { directoryEntry } from '../../../src/midnight/record-manifest.js';
import {
  applyFiling, asAMember, directoryChangeMessage, emptyDirectory, type Directory, type DirectoryFiling, type DirectorySeat, type RotateChange,
} from '../../../src/midnight/seat-directory.js';
import type { Role } from '../../../src/core/types.js';
import {
  answerDigestOf, companyKeyHere, CompanyKeyBeingChanged, CompanyKeyNotBelieved, CompanyKeyNotOpened, keysInTheFilings, rotateTheCompanyKeyHere,
  type RotationDoors, type SealedAnswer,
} from './company-key-here.js';
import { removeSignerOnDevice } from './governed-call-on-device.js';
import { keptRunHere } from './run-rebuilt-here.js';
import type { DirectoryHere } from './vault-page-doors.js';
import { runEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import { signRunFiling, type RunToFile } from '../../../src/core/run-filing.js';
import { sealRecord } from '../../../src/core/sealed-records.js';
import {
  aCompanyWhoseSignersChange, ADA as ADA_SEAT, BO as BO_SEAT, CO, CY as CY_SEAT, companyKeyDoorsOf, deviceOf, events, KEY, seatsOnTheChain, store,
} from '../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';

/*
 * One stand-in a case may set, passing through to the real code when unset: the copies of a new key a rotation makes
 * for each seat.
 */
const stand = vi.hoisted(() => ({
  wraps: null as null | ((made: readonly { seat: string; wrap: unknown }[]) => readonly { seat: string; wrap: unknown }[]),
}));
vi.mock('../../../src/core/company-key.js', async (real) => {
  const actual = await real<typeof import('../../../src/core/company-key.js')>();
  return {
    ...actual,
    wrapsFor: ((key: Hex, seats: never) => {
      const made = actual.wrapsFor(key, seats);
      return stand.wraps === null ? made : stand.wraps(made);
    }) as typeof actual.wrapsFor,
  };
});

const ACC = 'acc_key';
const LABEL = `co_${'c4'.repeat(32)}` as never;
const ACCOUNT = 'ad'.repeat(32) as never;
/** The company's key at its founding: what the service serves each seat a copy of. */
const KEY0 = newSymmetricKey();

interface Person {
  readonly name: string; readonly seat: string; readonly signing: { secret: Hex; publicKey: Hex };
  readonly released: Hex; readonly wrappingKey: Hex; readonly role: Role;
}
/** A signer, with the key their wallet releases for the company and the records key it gives their seat. */
const person = (name: string, n: number, role: Role = 'admin'): Person => {
  const released = newSymmetricKey();
  return { name, seat: n.toString(16).padStart(2, '0').repeat(32), signing: newSigningKeypair(), released, wrappingKey: recordsKeypairFrom(fromHex(released)).publicKey, role };
};
const ADA = person('ada', 0xa1);
const BO = person('bo', 0xb2);
const CY = person('cy', 0xc3);
const DEE = person('dee', 0xd4);
const VI = person('vi', 0xe5, 'viewer');

const seatOf = (p: Person): DirectorySeat => ({ seat: p.seat, person: p.name, signingKey: p.signing.publicKey, wrappingKey: p.wrappingKey, role: p.role, retired: null });

/**
 * One company: its directory as every device here believes it, the versions the anchor holds, and the seats the chain
 * holds. `seated` are in the directory and on the chain; `onlyOnTheChain` are leaves the chain holds with no entry.
 */
const aWorld = (seated: readonly Person[], o: { onlyOnTheChain?: readonly Person[]; approvals?: number; seatBar?: number } = {}) => {
  let dir: Directory = { ...emptyDirectory(ACC), version: seated.length, seats: seated.map(seatOf) };
  const filings: DirectoryFiling[] = seated.map((p, i) => ({ company: ACC, version: i + 1, change: { kind: 'claim', entry: { person: p.name } } as never }));
  const anchoredAt = new Set(filings.map((f) => f.version));
  const chain = new Set([...seated, ...(o.onlyOnTheChain ?? [])].map((p) => p.seat));
  /* Every change that reached the service, as `kind version`, whether or not the directory took it. */
  const filed: string[] = [];
  let anchors = true;
  const put = (f: DirectoryFiling, next: Directory) => { filings.push(f); dir = next; if (anchors) anchoredAt.add(f.version); };
  return {
    chain, filed, filings,
    get dir() { return dir; },
    /** Each version filed from now on is filed and not anchored. */
    anchorsNot: () => { anchors = false; },
    /** Each version filed from now on is anchored at once again. */
    anchorsAgain: () => { anchors = true; },
    /** The company's directory and records as every device here reads them now. */
    here: () => ({
      dir, holders: { seats: [...chain], approvals: o.approvals ?? 1, seatBar: o.seatBar ?? 1 },
      records: { directory: new Map([...anchoredAt].map((v) => [v, { digest: directoryEntry(filings[v - 1]!).digest }])) },
    }),
    /** `p`'s seat retired in the directory and anchored; with `off`, the chain takes its leaf off too. */
    retire: (p: Person, off = true) => {
      const version = dir.version + 1;
      put({ company: ACC, version, change: { kind: 'retire', seat: p.seat } as never },
        { ...dir, version, seats: dir.seats.map((x) => (x.seat === p.seat ? { ...x, retired: {}, retiredAt: version } : x)) });
      if (off) chain.delete(p.seat);
    },
    /** `p` seated on the chain and given an entry in the directory. */
    seat: (p: Person) => {
      const version = dir.version + 1;
      put({ company: ACC, version, change: { kind: 'claim', entry: { person: p.name } } as never }, { ...dir, version, seats: [...dir.seats, seatOf(p)] });
      chain.add(p.seat);
    },
    /** The service's filing of a change, judged by the directory's own judge, then anchored at once unless told not to. */
    file: async (change: RotateChange, signedFor: number) => {
      filed.push(`${change.kind} ${signedFor}`);
      if (signedFor !== dir.version + 1) throw new Error(`the directory holds ${dir.version} versions, so version ${signedFor} is not the next`);
      const f: DirectoryFiling = { company: ACC, version: signedFor, change };
      put(f, applyFiling(dir, f, {
        label: LABEL, account: ACCOUNT, chain: null, judge: asAMember(() => null, () => null, ADA.seat), now: { approvals: 1, seats: [...chain], seatBar: 1 },
      }));
      return { version: signedFor, anchor: anchors ? { anchored: 1 } : { notAnchored: 'the anchor was refused' } };
    },
  };
};
type World = ReturnType<typeof aWorld>;

/**
 * `p`'s device on `w`: its wallet's released key, the copy the service serves it, the waiting answers served, who it
 * reads as under a raised removal (or why it could not read that), and the directory's filings as the service serves them.
 */
const deviceOn = (w: World, p: Person, o: {
  released?: Hex | null; wallet?: Hex | null; served?: Hex; waiting?: readonly SealedAnswer[];
  leaving?: ReadonlySet<string> | Error; filings?: (served: DirectoryFiling[]) => DirectoryFiling[];
  admitted?: ReadonlySet<string> | Error;
} = {}) => {
  const asked = { wallet: 0 };
  const doors: RotationDoors = {
    accountId: ACC, material: { signingSecret: p.signing.secret },
    records: { directory: async () => w.here() as never },
    filings: async () => (o.filings ?? ((x) => x))([...w.filings]),
    served: async () => o.served ?? KEY0,
    released: () => (o.released === undefined ? p.released : o.released),
    askTheWallet: async () => { asked.wallet += 1; return o.wallet ?? null; },
    file: w.file,
    waiting: async () => o.waiting ?? [],
    leaving: async () => { if (o.leaving instanceof Error) throw o.leaving; return o.leaving ?? new Set(); },
    ...(o.admitted === undefined ? {} : { admitted: async () => { if (o.admitted instanceof Error) throw o.admitted; return o.admitted!; } }),
  };
  return { doors, asked, key: () => companyKeyHere(doors), rotate: (leaf?: Person) => rotateTheCompanyKeyHere(doors, leaf === undefined ? {} : { leaf: leaf.seat }) };
};

/**
 * A change of the key filed by `by` with the key, replaced key and seed given, as a device other than these would make
 * it; with `previousUnder` or `seedUnder`, the replaced key or the seed is sealed under another key than the new one.
 */
const aRotation = (w: World, by: Person, o: { key: Hex; previous: Hex; seed?: Hex; previousUnder?: Hex; seedUnder?: Hex }) => {
  const epoch = (w.dir.rotations?.length ?? 0) + 1;
  const after = Math.max(...w.dir.seats.flatMap((x) => (x.retiredAt === undefined ? [] : [x.retiredAt])));
  const unsigned = {
    kind: 'rotate' as const, epoch, keyCheck: keyCheckOf(ACC, epoch, o.key), after, wraps: wrapsFor(o.key, w.dir.seats.filter((x) => x.retired === null)),
    previous: sealedPrevious(o.previousUnder ?? o.key, o.previous),
    seed: { epoch, sealed: sealedSeed(o.seedUnder ?? o.key, o.seed ?? newSymmetricKey()) }, waiting: [],
  };
  const signedFor = w.dir.version + 1;
  const message = directoryChangeMessage(ACC, signedFor, { ...unsigned, signatures: [] } as never);
  return w.file({ ...unsigned, signatures: [{ publicKey: by.signing.publicKey, signature: sign(message, by.signing.secret) }] }, signedFor);
};
/** The newest change of the key in the directory's filings. */
const newestRotation = (w: World): RotateChange => w.filings.filter((f) => f.change.kind === 'rotate').at(-1)!.change as RotateChange;

describe('the company\'s key on this device', () => {
  it('a company never rotated reads its key at epoch 0 from the seat\'s served copy', async () => {
    const w = aWorld([ADA, BO]);
    const ada = deviceOn(w, ADA, { released: null });
    const key = await ada.key();
    /* RED WHEN: a company never rotated takes its key from anywhere but this seat's served copy, or at an epoch other than 0. */
    expect({ epoch: key.epoch, newest: key.newest, key: key.key, at0: key.keyAt(0), sealing: key.sealing() }).toEqual({ epoch: 0, newest: 0, key: KEY0, at0: KEY0, sealing: { key: KEY0, epoch: 0 } });
    /* RED WHEN: the wallet is asked for a key a company never rotated does not need. */
    expect(ada.asked.wallet).toBe(0);
  });

  it('a staying seat opens the newest key from its own copy and every older one through the keys it replaced', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    expect((await deviceOn(w, ADA).rotate()).state).toBe('rotated');
    w.retire(DEE);
    expect((await deviceOn(w, BO).rotate()).state).toBe('rotated');
    const key = await deviceOn(w, ADA).key();
    /* RED WHEN: the keys a rotation replaced are not walked back to epoch 0, or epoch 0's key is not the company's first. */
    expect([key.epoch, key.newest, key.keyAt(0)]).toEqual([2, 2, KEY0]);
    expect(new Set([key.keyAt(0), key.keyAt(1), key.keyAt(2)]).size).toBe(3);
    expect(key.key).toBe(key.keyAt(2));
    /* RED WHEN: a seed is not opened under its own epoch's key. */
    expect(key.seeds.map((s) => s.epoch)).toEqual([1, 2]);
    expect(key.sealing()).toEqual({ key: key.keyAt(2), epoch: 2 });
  });

  it('a seat seated after a rotation believes its served copy only when it matches the key check', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = (await deviceOn(w, ADA).key()).key;
    w.seat(DEE);
    const given = await deviceOn(w, DEE, { served: k1 }).key();
    /* RED WHEN: a seat with no copy in the newest rotation does not take its served copy at that epoch when it matches. */
    expect([given.epoch, given.keyAt(0)]).toEqual([1, KEY0]);
    const forged = await deviceOn(w, DEE, { served: newSymmetricKey() }).key();
    /* RED WHEN: a served copy is believed at the newest epoch unchecked. */
    expect(forged.epoch).toBe(0);
    expect(() => forged.keyAt(1)).toThrow(/no key of the company at epoch 1/u);
    expect(() => forged.sealing()).toThrow(CompanyKeyBeingChanged);
  });

  it('a rotation filed and not anchored gives no new key', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    w.anchorsNot();
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'filed-not-anchored', epoch: 1 });
    const key = await deviceOn(w, ADA).key();
    /* RED WHEN: a rotation the anchor does not hold counts. */
    expect([key.epoch, key.newest, key.key]).toEqual([0, 0, KEY0]);
  });

  it('nothing is sealed while a retirement is anchored above the newest rotation and its leaf is off the chain, and every key still opens', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    w.retire(DEE);
    const key = await deviceOn(w, BO).key();
    /* RED WHEN: sealing goes on under a key the leaver held once their removal is carried out and anchored. */
    expect(() => key.sealing()).toThrow(CompanyKeyBeingChanged);
    expect(key.notSealing).toMatch(/being changed/u);
    /* RED WHEN: the pause stops reading as well as sealing. */
    expect([key.epoch, key.keyAt(0)]).toEqual([1, KEY0]);
    await deviceOn(w, BO).rotate();
    /* RED WHEN: the pause outlives the rotation that follows the retirement. */
    expect((await deviceOn(w, BO).key()).sealing().epoch).toBe(2);
  });

  it('the pause says why this device\'s own try to change the key did not', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const ada = deviceOn(w, ADA, { leaving: new Error('the chain could not be read') });
    expect(await ada.rotate()).toMatchObject({ state: 'waits' });
    /* RED WHEN: the pause tells a staying signer that opening the company changes the key, when this device's try waits. */
    await expect((async () => (await ada.key()).sealing())()).rejects.toThrow(/tried to change it and could not yet: the chain could not be read/u);
  });

  it('a retirement whose leaf the chain still holds does not pause sealing', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY, false);
    const key = await deviceOn(w, ADA).key();
    /* RED WHEN: the pause starts at the retirement alone, before the chain takes the leaf off. */
    expect(key.sealing()).toEqual({ key: KEY0, epoch: 0 });
    /* RED WHEN: a rotation waits on a retired seat the chain still holds once its retirement is anchored, while the seats that stay can approve without it. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'rotated', epoch: 1 });
    /* RED WHEN: the retired seat the chain still holds gets a copy of the new key. */
    expect(newestRotation(w).wraps.map((x) => x.seat).sort()).toEqual([ADA.seat, BO.seat].sort());
  });

  it('a company where every signer must approve waits while the chain still holds a retired seat', async () => {
    const w = aWorld([ADA, BO, CY], { approvals: 3, seatBar: 3 });
    w.retire(CY, false);
    /* RED WHEN: the key changes while the seats that stay cannot meet the approvals the chain needs, so the retired seat, holding no new key, could never approve a proposal sealed under it. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'waits', why: expect.stringMatching(/chain still holds a retired seat/u) });
    expect(w.filed).toEqual([]);
    const bar = aWorld([ADA, BO, CY], { approvals: 1, seatBar: 3 });
    bar.retire(CY, false);
    /* RED WHEN: only the account threshold is counted, not the higher seat bar. */
    expect(await deviceOn(bar, ADA).rotate()).toMatchObject({ state: 'waits' });
  });

  it('a device that cannot read the company\'s directory with the chain\'s seats changes no key, files nothing and says why', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const d = deviceOn(w, ADA);
    const unread = { ...d.doors, records: { directory: async () => { throw new Error('the chain could not be read'); } } };
    /* RED WHEN: a read of the directory and the chain's seats that fails is answered as nothing to change, or the change goes ahead without it. */
    await expect(rotateTheCompanyKeyHere(unread, { leaf: CY.seat })).rejects.toThrow(/the chain could not be read/u);
    expect(w.filed).toEqual([]);
    /* Its control: the same device, reading them, changes the key. */
    expect(await d.rotate(CY)).toMatchObject({ state: 'rotated', epoch: 1 });
  });

  it('a pause begun by an earlier leaver ends with a rotation while a later retired seat is still on the chain', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    expect((await deviceOn(w, ADA).key()).notSealing).not.toBeNull();
    w.retire(DEE, false);
    /* RED WHEN: the pause the first leaver began waits for the later retired seat to leave the chain. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'rotated', epoch: 1 });
    expect(newestRotation(w).wraps.map((x) => x.seat).sort()).toEqual([ADA.seat, BO.seat].sort());
    /* RED WHEN: sealing stays paused after the rotation that follows both retirements. */
    expect((await deviceOn(w, ADA).key()).notSealing).toBeNull();
    w.chain.delete(DEE.seat);
    /* RED WHEN: the key is changed again when the retired seat finally leaves the chain. */
    expect(await deviceOn(w, BO).rotate()).toEqual({ state: 'not-needed' });
    expect((await deviceOn(w, ADA).key()).notSealing).toBeNull();
  });

  it('a rotation waits while the chain holds a seat the directory has no entry for', async () => {
    const w = aWorld([ADA, BO, CY], { onlyOnTheChain: [DEE] });
    w.retire(CY);
    /* RED WHEN: a rotation leaves a seat the chain holds without a copy of the new key because its entry is not yet believed. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'waits', why: expect.stringMatching(/no entry for yet/u) });
    expect(w.filed).toEqual([]);
  });

  it('a rotation does not wait on a seat the chain holds that the roster never admitted', async () => {
    const w = aWorld([ADA, BO, CY], { onlyOnTheChain: [DEE] });
    w.retire(CY);
    /* RED WHEN: a seat seated on the chain and never admitted, which holds no key, makes every rotation wait. */
    expect(await deviceOn(w, ADA, { admitted: new Set([ADA.seat, BO.seat, CY.seat]) }).rotate()).toMatchObject({ state: 'rotated', epoch: 1 });
  });

  it('a rotation still waits on a seat with no entry the roster admitted, and while the roster cannot be read', async () => {
    const w = aWorld([ADA, BO, CY], { onlyOnTheChain: [DEE] });
    w.retire(CY);
    /* RED WHEN: an admitted seat that holds the old key and has not yet filed its entry is left without the new key. */
    expect(await deviceOn(w, ADA, { admitted: new Set([ADA.seat, BO.seat, DEE.seat]) }).rotate())
      .toMatchObject({ state: 'waits', why: expect.stringMatching(/no entry for yet/u) });
    /* RED WHEN: a roster that could not be read is taken as admitting nobody. */
    expect(await deviceOn(w, ADA, { admitted: new Error('the roster was not served') }).rotate())
      .toMatchObject({ state: 'waits', why: expect.stringMatching(/could not be read/u) });
    expect(w.filed).toEqual([]);
  });

  it('a rotation waits while the directory holds a seat that stays and the chain no longer holds', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    w.chain.delete(DEE.seat);
    /* RED WHEN: a copy of the new key goes to a seat the chain removed before its retirement is anchored. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'waits', why: expect.stringMatching(/no longer holds a seat the directory has not retired/u) });
    expect(w.filed).toEqual([]);
  });

  it('two devices rotating at once leave one rotation, and the one that lost files nothing more', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const bo = deviceOn(w, BO);
    const ada = deviceOn(w, ADA);
    /* Bo's device has built its change when Ada's files hers. */
    const late = { ...bo.doors, file: async (change: RotateChange, signedFor: number) => { await ada.rotate(); return w.file(change, signedFor); } };
    expect(await rotateTheCompanyKeyHere(late)).toEqual({ state: 'rotated-elsewhere', epoch: 1 });
    /* RED WHEN: the device that lost the race files its change again at the next version. */
    expect(w.filed).toEqual(['rotate 5', 'rotate 5']);
    expect(w.dir.rotations?.map((r) => r.epoch)).toEqual([1]);
    expect((await bo.key()).epoch).toBe(1);
  });

  it('the rotation names every waiting request and handover this device opened, and no other', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const inbox = inboxPublicKey(KEY0, ACC);
    const request = sealToInbox({ name: 'joiner' }, inbox) as SealedAnswer;
    const handover = sealToInbox({ parts: { kind: 'payee' } }, inbox) as SealedAnswer;
    const elsewhere = sealToInbox({ name: 'other' }, inboxPublicKey(newSymmetricKey(), ACC)) as SealedAnswer;
    await deviceOn(w, ADA, { waiting: [request, elsewhere, handover, request] }).rotate();
    /* RED WHEN: one digest of a waiting answer this device opened is left out, or one it could not open is named. */
    expect(newestRotation(w).waiting).toEqual([answerDigestOf(request), answerDigestOf(handover)]);
    /* RED WHEN: the answers a rotation named are held under the new key's epoch rather than the epoch of the inbox they were sealed to. */
    const keys = await deviceOn(w, BO).key();
    expect([...keys.answered.keys()]).toEqual([0]);
    expect([...keys.answered.get(0)!].sort()).toEqual([answerDigestOf(request), answerDigestOf(handover)].sort());
  });

  it('the rotation\'s seed is new, 32 bytes, at the rotation\'s own epoch', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const change = newestRotation(w);
    const key = await deviceOn(w, BO).key();
    const seed = openedSeed(key.key, change.seed!.sealed);
    /* RED WHEN: the seed is missing, of another length, or at another epoch than its rotation. */
    expect(change.seed!.epoch).toBe(change.epoch);
    expect(seed).toMatch(/^[0-9a-f]{64}$/u);
    expect(key.seeds).toEqual([{ epoch: 1, seed }]);
  });

  it('a rotation whose seed is one an earlier epoch had is not believed, and every key below it still opens', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = await deviceOn(w, ADA).key();
    w.retire(DEE);
    /* The same seed sealed again, so its bytes are new and only opening it shows it is not. */
    await aRotation(w, BO, { key: newSymmetricKey(), previous: k1.key, seed: k1.seeds[0]!.seed });
    const ada = await deviceOn(w, ADA).key();
    /* RED WHEN: a seed is reused across epochs and still believed, or the keys below that change are lost with it. */
    expect([ada.epoch, ada.newest, ada.key, ada.seeds]).toEqual([1, 2, k1.key, k1.seeds]);
    expect(() => ada.keyAt(2)).toThrow(/no key of the company at epoch 2/u);
    expect(() => ada.sealing()).toThrow(/payout seed is one an earlier epoch had/u);
  });

  it('a rotation whose key is one an earlier epoch had is not believed, and every key below it still opens', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = await deviceOn(w, ADA).key();
    w.retire(DEE);
    await aRotation(w, BO, { key: KEY0, previous: k1.key });
    const ada = await deviceOn(w, ADA).key();
    /* RED WHEN: a rotation back to a key the leaver held is believed, so something new would be sealed under it. */
    expect([ada.epoch, ada.newest, ada.key, ada.keyAt(0)]).toEqual([1, 2, k1.key, KEY0]);
    expect(() => ada.keyAt(2)).toThrow(/no key of the company at epoch 2/u);
    expect(() => ada.sealing()).toThrow(/its key is one an earlier epoch had/u);
  });

  it('a seat that may not file a proposal files no rotation', async () => {
    const w = aWorld([ADA, BO, CY, VI]);
    w.retire(CY);
    /* RED WHEN: a viewer's device changes the company's key. */
    expect(await deviceOn(w, VI).rotate()).toMatchObject({ state: 'not-this-seat', why: expect.stringMatching(/files no proposal/u) });
    expect(w.filed).toEqual([]);
  });

  it('the leaving seat\'s device and a retired seat\'s device never rotate', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    /* RED WHEN: a retired seat's device, or the device of the seat named as leaving, files a change of the key. */
    expect(await deviceOn(w, CY).rotate()).toMatchObject({ state: 'not-this-seat' });
    expect(await deviceOn(w, BO).rotate(BO)).toMatchObject({ state: 'not-this-seat', why: expect.stringMatching(/the one leaving/u) });
    expect(w.filed).toEqual([]);
  });

  it('a tab holding no released key asks the wallet once and, when the person declines, rotates nothing and says so', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const declined = deviceOn(w, ADA, { released: null, wallet: null });
    const out = await declined.rotate();
    /* RED WHEN: the change is filed without the wallet's key, or the wallet is asked more than once. */
    expect(out).toMatchObject({ state: 'not-rotated', why: expect.stringMatching(/Open the company with your wallet/u) });
    expect(declined.asked.wallet).toBe(1);
    expect(w.filed).toEqual([]);
    const given = deviceOn(w, ADA, { released: null, wallet: ADA.released });
    expect((await given.rotate()).state).toBe('rotated');
    expect(given.asked.wallet).toBe(1);
    /* After the rotation, a tab with no released key and a served copy above epoch 0 opens nothing above epoch 0. */
    const k1 = (await deviceOn(w, BO).key()).key;
    const served = deviceOn(w, BO, { released: null, wallet: null, served: k1 });
    /* RED WHEN: a seat with its own copy in the newest rotation takes the served copy instead of opening its own. */
    await expect(served.key()).rejects.toThrow(CompanyKeyNotOpened);
    expect(served.asked.wallet).toBe(1);
  });

  it('a rotation waits while the leaving seat\'s retirement is filed and not anchored', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.anchorsNot();
    w.retire(CY);
    w.anchorsAgain();
    /* RED WHEN: the key is changed before the leaver's retirement is anchored. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'waits', why: expect.stringMatching(/retirement of the leaving seat is filed and not yet anchored/u) });
    expect(w.filed).toEqual([]);
  });

  it('a rotation waits while another change of the key is filed and not anchored', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    w.anchorsNot();
    expect((await deviceOn(w, ADA).rotate()).state).toBe('filed-not-anchored');
    w.anchorsAgain();
    w.retire(DEE);
    w.filed.length = 0;
    /* RED WHEN: a change of the key is filed while an earlier one is not yet anchored. */
    expect(await deviceOn(w, BO).rotate()).toMatchObject({ state: 'waits', why: expect.stringMatching(/change of the company's key is filed and not yet anchored/u) });
    expect(w.filed).toEqual([]);
  });

  it('a rotation\'s bytes the anchor does not hold are not believed, so the service cannot choose epoch 0\'s key', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = (await deviceOn(w, ADA).key()).key;
    const forged = newSymmetricKey();
    /* The service serves the rotation with the key it replaces sealed again as another key, and that key as this seat's copy. */
    const other = (served: DirectoryFiling[]) => served.map((f) => (f.change.kind !== 'rotate' ? f
      : { ...f, change: { ...f.change, previous: sealedPrevious(k1, forged) } }));
    /* RED WHEN: a rotation is read from bytes other than those the anchor holds, so epoch 0's key is the service's choice. */
    await expect(deviceOn(w, BO, { filings: other, served: forged }).key()).rejects.toThrow(/other bytes for it than the company's records anchor/u);
  });

  it('a seat under an approved removal files no rotation, and one that cannot read who is leaving waits', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    /* RED WHEN: a seat whose removal is approved changes the key, or is told its removal is only raised. */
    expect(await deviceOn(w, ADA, { leaving: new Set([ADA.signing.publicKey.toLowerCase()]) }).rotate())
      .toMatchObject({ state: 'not-this-seat', why: expect.stringMatching(/removal of this seat is approved/u) });
    /* RED WHEN: who is under an approved removal cannot be read and the key is changed anyway. */
    expect(await deviceOn(w, ADA, { leaving: new Error('the proposals were not read') }).rotate())
      .toMatchObject({ state: 'waits', why: expect.stringMatching(/the proposals were not read/u) });
    expect(w.filed).toEqual([]);
  });

  it('a staying seat whose served copy is not the key a rotation replaced does not believe that rotation, and seals nothing', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const served = newSymmetricKey();
    const bo = await deviceOn(w, BO, { served }).key();
    /* RED WHEN: the copy the service serves this seat holds a key the rotations do not lead back to, and the keys are believed. */
    expect([bo.epoch, bo.newest, bo.key]).toEqual([0, 1, served]);
    expect(() => bo.keyAt(1)).toThrow(/no key of the company at epoch 1/u);
    expect(() => bo.sealing()).toThrow(/does not match the key check of the epoch it names/u);
  });

  it('a rotation whose replaced key does not match, or does not open, or whose seed does not open, is not believed, and every key below it still opens', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = await deviceOn(w, ADA).key();
    w.retire(DEE);
    await aRotation(w, BO, { key: newSymmetricKey(), previous: newSymmetricKey() });
    const ada = await deviceOn(w, ADA).key();
    /* RED WHEN: the key a rotation says it replaced is believed without its epoch's key check, or the keys below are lost. */
    expect([ada.epoch, ada.newest, ada.key, ada.seeds]).toEqual([1, 2, k1.key, k1.seeds]);
    expect(() => ada.sealing()).toThrow(/does not match the key check of the epoch it names/u);
    /* The same company where the replaced key is sealed under another key, and where the seed is. */
    for (const [o, why] of [[{ previousUnder: newSymmetricKey() }, /the key it replaces does not open under it/u], [{ seedUnder: newSymmetricKey() }, /its payout seed does not open under its key/u]] as const) {
      const v = aWorld([ADA, BO, CY, DEE]);
      v.retire(CY);
      await deviceOn(v, ADA).rotate();
      const v1 = await deviceOn(v, ADA).key();
      v.retire(DEE);
      await aRotation(v, BO, { key: newSymmetricKey(), previous: v1.key, ...o });
      const here = await deviceOn(v, ADA).key();
      /* RED WHEN: a change whose replaced key or seed does not open stops this seat from holding any key, or is believed. */
      expect([here.epoch, here.newest, here.key, here.seeds]).toEqual([1, 2, v1.key, v1.seeds]);
      expect(() => here.sealing()).toThrow(why);
    }
  });

  it('a rotation is filed only when the wallet\'s key is the one this seat\'s entry names and this seat opens its own copy', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    /* RED WHEN: a wallet's key other than the one this seat's entry names is taken, so this seat could not open the new key. */
    expect(await deviceOn(w, ADA, { released: newSymmetricKey() }).rotate())
      .toMatchObject({ state: 'not-rotated', why: expect.stringMatching(/not the one this seat's directory entry names/u) });
    /* Ada's copy of the new key is made of another key, so it opens to that one. */
    const another = wrapsFor(newSymmetricKey(), [seatOf(ADA)])[0]!.wrap;
    stand.wraps = (made) => made.map((x) => (x.seat === ADA.seat ? { ...x, wrap: another } : x));
    try {
      /* RED WHEN: a change of the key is filed whose filer cannot open its own copy of the new key. */
      expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'not-rotated', why: expect.stringMatching(/could not open its own copy/u) });
    } finally {
      stand.wraps = null;
    }
    expect(w.filed).toEqual([]);
  });

  it('a rotation whose payout seed is one the company\'s first state had opens no run', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const seed = newSymmetricKey();
    await aRotation(w, BO, { key: newSymmetricKey(), previous: KEY0, seed });
    const key = await deviceOn(w, ADA).key();
    const { seedsOfEveryEpoch } = await vi.importActual<typeof import('./run-rebuilt-here.js')>('./run-rebuilt-here.js');
    /* RED WHEN: a rotation's seed equal to one of the first state's is taken as a seed a run may be paid from. */
    expect(() => seedsOfEveryEpoch([{ epoch: 0, seed }], key)).toThrow(/payout seed the company's first state already had/u);
    const first = { epoch: 0, seed: newSymmetricKey() };
    /* RED WHEN: the seeds the changes of the key carried are not read after the first state's own. */
    expect(seedsOfEveryEpoch([first], key)).toEqual([first, { epoch: 1, seed }]);
  });

  it('nothing in the company\'s key names a committee or a super admin', () => {
    const source = readFileSync(new URL('./company-key-here.ts', import.meta.url), 'utf8');
    /* RED WHEN: finding or changing the company's key reads the account's committee or the super admin role. */
    expect(source.match(/committee|super.?admin/giu) ?? []).toEqual([]);
  });
});

describe('a seat whose copy of the newest key does not open', () => {
  /** Ada, Bo and Cy; Cy leaves; Bo's device changes the key with Ada's copy made of another key. */
  const aBadCopyForAda = async (w: World) => {
    const another = wrapsFor(newSymmetricKey(), [seatOf(ADA)])[0]!.wrap;
    stand.wraps = (made) => made.map((x) => (x.seat === ADA.seat ? { ...x, wrap: another } : x));
    try {
      expect(await deviceOn(w, BO).rotate()).toMatchObject({ state: 'rotated' });
    } finally {
      stand.wraps = null;
    }
  };

  it('still holds every older key, opens nothing new, and seals nothing', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await aBadCopyForAda(w);
    const bo = await deviceOn(w, BO).key();
    expect(bo.epoch).toBe(1);
    const ada = await deviceOn(w, ADA).key();
    /* RED WHEN: a seat whose copy of the newest key does not open holds no key at all, so it opens nothing sealed before. */
    expect([ada.epoch, ada.newest, ada.keyAt(0), ada.seeds]).toEqual([0, 1, KEY0, []]);
    expect(() => ada.keyAt(1)).toThrow(/no key of the company at epoch 1/u);
    /* RED WHEN: a seat that does not hold the newest key may seal under an older one, which the leaver holds. */
    expect(() => ada.sealing()).toThrow(CompanyKeyBeingChanged);
    expect(ada.notSealing).toMatch(/copy of the company's newest key does not open/u);
    /* RED WHEN: the refusal does not say what puts it right: the signer who made the change removed, then a new change. */
    expect(ada.notSealing).toMatch(/once the signer who made that change is removed from the company/u);
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'not-needed' });
  });

  it('a change of the key this device does not believe is refused without promising a change no device makes', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const seed = newSymmetricKey();
    await aRotation(w, BO, { key: newSymmetricKey(), previous: KEY0, seed });
    const key = await deviceOn(w, ADA).key();
    const { seedsOfEveryEpoch } = await vi.importActual<typeof import('./run-rebuilt-here.js')>('./run-rebuilt-here.js');
    const said = [new CompanyKeyNotBelieved(1, 'its payout seed does not open under its key').message];
    try { seedsOfEveryEpoch([{ epoch: 0, seed }], key); } catch (e) { said.push((e as Error).message); }
    expect(said).toHaveLength(2);
    /* RED WHEN: a refusal tells the reader a signer changes or files the key again, which no device does. */
    for (const text of said) expect(text).not.toMatch(/files? the change again|changes the key again/u);
    expect(said[0]).toMatch(/Reload the page/u);
  });

  it('is put right once the signer who made the change is removed: a staying seat changes the key from the newest key it holds', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await aBadCopyForAda(w);
    const k1 = await deviceOn(w, DEE).key();
    /* Bo is retired; the chain still holds his seat. */
    w.retire(BO, false);
    /* RED WHEN: the key is changed past Bo's change while the account still holds Bo. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'not-rotated', why: expect.stringMatching(/not removed from the company yet/u) });
    expect(w.filed).toEqual(['rotate 6']);
    /* The super admins take Bo's seat off the chain. */
    w.chain.delete(BO.seat);
    /* RED WHEN: a seat whose copy of the newest key did not open cannot change the key once its filer is removed. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'rotated', epoch: 2 });
    expect(newestRotation(w)).toMatchObject({ epoch: 2, replaces: 0 });
    /* RED WHEN: a retired seat gets a copy of the new key. */
    expect(newestRotation(w).wraps.map((x) => x.seat).sort()).toEqual([ADA.seat, DEE.seat].sort());
    const ada = await deviceOn(w, ADA).key();
    const dee = await deviceOn(w, DEE).key();
    /* RED WHEN: a staying seat does not read the new key, or cannot seal under it. */
    expect([ada.epoch, ada.newest, ada.keyAt(0), ada.sealing().epoch]).toEqual([2, 2, KEY0, 2]);
    expect([dee.epoch, dee.key, dee.keyAt(1), dee.keyAt(0), dee.sealing().epoch]).toEqual([2, ada.key, k1.key, KEY0, 2]);
    /* RED WHEN: the answers the new change found waiting are not counted against the inbox of the key it replaced. */
    expect([...ada.answered.keys()]).toEqual([0]);
    /* RED WHEN: the new seed is not held by every seat that stays. */
    expect(ada.seeds.map((x) => x.epoch)).toEqual([2]);
    expect(dee.seeds.map((x) => x.epoch)).toEqual([1, 2]);
    expect(dee.seeds.at(-1)).toEqual(ada.seeds.at(-1));
    /* RED WHEN: the keys found before the directory is believed do not follow a change back to the older key it names. */
    const found = await keysInTheFilings(ACC, w.filings, { served: async () => { throw new Error('not served'); }, released: async () => ADA.released });
    expect([found.keyAt(2), found.keyAt(0)]).toEqual([ada.key, KEY0]);
    /* RED WHEN: the removed signer holds the new key. */
    const bo = await deviceOn(w, BO).key();
    expect([bo.epoch, bo.newest]).toEqual([1, 2]);
    expect(() => bo.keyAt(2)).toThrow(/no key of the company at epoch 2/u);
  });

  it('a change not believed for its seed is put right the same way, from the key below it', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const k1 = await deviceOn(w, ADA).key();
    w.retire(DEE);
    await aRotation(w, BO, { key: newSymmetricKey(), previous: k1.key, seedUnder: newSymmetricKey() });
    w.retire(BO);
    /* RED WHEN: a change no seat believes cannot be passed over once its filer is removed. */
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'rotated', epoch: 3 });
    expect(newestRotation(w)).toMatchObject({ epoch: 3, replaces: 1 });
    const ada = await deviceOn(w, ADA).key();
    expect([ada.epoch, ada.newest, ada.keyAt(1), ada.keyAt(0), ada.sealing().epoch]).toEqual([3, 3, k1.key, KEY0, 3]);
    expect(ada.seeds.map((x) => x.epoch)).toEqual([1, 3]);
  });

  it('a seat that opened the epoch before keeps that key and its seed', async () => {
    const w = aWorld([ADA, BO, CY, DEE]);
    w.retire(CY);
    expect(await deviceOn(w, ADA).rotate()).toMatchObject({ state: 'rotated', epoch: 1 });
    const before = await deviceOn(w, ADA).key();
    w.retire(DEE);
    await aBadCopyForAda(w);
    const ada = await deviceOn(w, ADA).key();
    /* RED WHEN: only the copy in the newest change of the key is tried, so the seat falls back past keys it can open. */
    expect([ada.epoch, ada.newest, ada.key, ada.keyAt(0), ada.seeds]).toEqual([1, 2, before.key, KEY0, before.seeds]);
    expect(ada.seeds.map((s) => s.epoch)).toEqual([1]);
    expect(() => ada.sealing()).toThrow(CompanyKeyBeingChanged);
  });

  it('a seat holding the newest key and not its payout seed seals nothing', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    await deviceOn(w, ADA).rotate();
    const ada = deviceOn(w, ADA);
    /* The directory as a device would read it if the newest change of the key carried no seed it opens. */
    const doors: RotationDoors = { ...ada.doors, records: { directory: async () => {
      const here = w.here();
      return { ...here, dir: { ...here.dir, rotations: here.dir.rotations!.map((r) => ({ ...r, seed: undefined })) } } as never;
    } } };
    const keys = await companyKeyHere(doors);
    expect([keys.epoch, keys.newest, keys.seeds]).toEqual([1, 1, []]);
    /* RED WHEN: a seat without the newest seed seals, so a run would be raised under an older seed the leaver holds. */
    expect(() => keys.sealing()).toThrow(/holds no copy of the payout seed of the company's newest key/u);
  });

  it('a run sealed before the change of the key is still read on that seat\'s device', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const id = 'run_beforechange';
    const run = signRunFiling(ACC, {
      id, accountId: ACC, period: '2026-11', status: 'draft', keyEpoch: 0, payslips: [], proposalIds: [],
      sealed: sealRecord('payroll', ACC, { employees: [], totals: {}, proposalIds: {} }, KEY0),
    } as unknown as RunToFile, BO.signing.secret);
    await aBadCopyForAda(w);
    const ada = await deviceOn(w, ADA).key();
    const rotatedAt = w.dir.rotations!.at(-1)!.version;
    const here = (): DirectoryHere => {
      const base = w.here();
      return {
        ...base, leafOf: () => null, another: new Set(), at: () => null,
        records: {
          head: '00'.repeat(32), reached: {}, stopped: null,
          asked: { records: new Set(), kinds: new Set(['run:run:']) },
          history: new Map([[recordKeyOf({ store: 'run', kind: 'run', id }), [{
            version: 1, digest: runEntry(ACC, run as never, 1).digest, filedBy: BO.signing.publicKey.toLowerCase(), batch: 1, dirVersion: rotatedAt - 1,
          }]]]),
          notYetAnchored: [],
          directory: new Map([...base.records.directory].map(([v, d]) => [v, { ...d, batch: v === rotatedAt ? 2 : 0, held: {} }])),
        },
      } as unknown as DirectoryHere;
    };
    const records = { runs: async () => [run], directory: async () => here() };
    /* RED WHEN: a seat whose copy of the newest key does not open cannot read a run sealed under a key it still holds. */
    expect((await keptRunHere(records as never, ACC, id, ada)).run.id).toBe(id);
  });
});

aCompanyWhoseSignersChange();

describe('the keys a device can reach from the directory\'s filings, before any is believed', () => {
  it('reaches every epoch from this seat\'s own copy, or from a served copy that matches the newest check, and never more', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const one = newSymmetricKey();
    await aRotation(w, BO, { key: one, previous: KEY0 });
    w.seat(DEE);
    w.retire(DEE);
    const two = newSymmetricKey();
    await aRotation(w, BO, { key: two, previous: one });
    const reach = async (served: Hex, released: Hex | null) => {
      const found = await keysInTheFilings(ACC, w.filings, { served: async () => served, released: async () => released });
      return [0, 1, 2].flatMap((e) => { try { return [found.keyAt(e)]; } catch { return []; } });
    };
    /* RED WHEN: a seat's own copy in the newest change is not opened, or the keys it replaced are not walked back to epoch 0. */
    expect(await reach(KEY0, ADA.released)).toEqual([KEY0, one, two]);
    /* RED WHEN: a seat seated after the change, served the newest key, does not reach the older ones through it. */
    expect(await reach(two, null)).toEqual([KEY0, one, two]);
    /* RED WHEN: a key is reached without the wallet's key or a served copy that matches a change's check. */
    expect(await reach(KEY0, null)).toEqual([KEY0]);
    /* RED WHEN: a copy wrapped to a retired seat opens for it. */
    expect(await reach(KEY0, CY.released)).toEqual([KEY0]);
  });

  it('takes no key from a copy that does not open to its change\'s key check', async () => {
    const w = aWorld([ADA, BO, CY]);
    w.retire(CY);
    const foreign = wrapsFor(newSymmetricKey(), [seatOf(ADA)])[0]!.wrap;
    stand.wraps = (made) => made.map((x) => (x.seat === ADA.seat ? { ...x, wrap: foreign } : x));
    try {
      await aRotation(w, BO, { key: newSymmetricKey(), previous: KEY0 });
    } finally {
      stand.wraps = null;
    }
    /* RED WHEN: a key is taken from this seat's copy without checking it against the change's key check. */
    const found = await keysInTheFilings(ACC, w.filings, { served: async () => KEY0, released: async () => ADA.released });
    expect([found.epoch, found.keyAt(0)]).toEqual([0, KEY0]);
    /* RED WHEN: keys found before the directory is believed seal a record. */
    expect(() => found.sealing()).toThrow(CompanyKeyBeingChanged);
  });
});

describe('one removal on two staying seats\' devices ends with the company\'s key changed', () => {
  it('Bo\'s device carries Cy\'s removal and changes the key; Ada reads epoch 1 with its seed and epoch 0, and Cy holds nothing new', async () => {
    const remove = { viewingKey: KEY, leaf: CY_SEAT.seat, name: 'cy' };
    expect(await removeSignerOnDevice(deviceOf(ADA_SEAT, { changesTheKey: true }), remove)).toMatchObject({ state: 'waiting-for-approvals' });
    events.length = 0;
    const carried = await removeSignerOnDevice(deviceOf(BO_SEAT, { changesTheKey: true }), remove);
    /* RED WHEN: the staying device that carries a removal does not change the key once the chain takes the leaf off. */
    expect(carried).toMatchObject({ state: 'done', rotation: { state: 'rotated', epoch: 1 } });
    expect(seatsOnTheChain()).toEqual([ADA_SEAT.seat, BO_SEAT.seat]);
    const filing = store.directoryFilingsOf(CO).at(-1)!;
    /* RED WHEN: the change of the key is filed before the leaf is off the chain, or is not anchored. */
    expect(events.slice(-3)).toEqual([`chain amendSigner removing ${CY_SEAT.seat}`, `directory ${filing.version} rotate`, 'anchored']);
    /* RED WHEN: a retired seat gets a copy of the new key. */
    expect((filing.change as RotateChange).wraps.map((x) => x.seat).sort()).toEqual([ADA_SEAT.seat, BO_SEAT.seat].sort());
    const read = (s: typeof ADA_SEAT) => companyKeyHere({ ...companyKeyDoorsOf(s), accountId: CO, material: { signingSecret: s.signingSecret }, records: deviceOf(s).records! });
    const ada = await read(ADA_SEAT);
    /* RED WHEN: the staying seat does not read epoch 1, its seed, or epoch 0's key through it. */
    expect([ada.epoch, ada.newest, ada.keyAt(0), ada.seeds.map((s) => s.epoch)]).toEqual([1, 1, KEY, [1]]);
    expect(ada.sealing().epoch).toBe(1);
    const cy = await read(CY_SEAT);
    /* RED WHEN: the leaver gets a key above the epoch they held. */
    expect(cy.epoch).toBe(0);
    expect(() => cy.keyAt(1)).toThrow(/no key of the company at epoch 1/u);
    const versions = store.directoryFilingsOf(CO).length;
    const again = await removeSignerOnDevice(deviceOf(CY_SEAT, { changesTheKey: true }), remove);
    /* RED WHEN: the leaver's device changes the key once its removal is done. */
    expect(again).toMatchObject({ state: 'done', rotation: { state: 'not-this-seat' } });
    expect(store.directoryFilingsOf(CO).length).toBe(versions);
  }, 170_000);
});
