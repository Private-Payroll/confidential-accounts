/**
 * A vault's spending policy as signers leave and join: the signers who stay
 * keep reading the policy in force, a signer who left reads none set after,
 * no filing can shut a staying signer out, the same terms are never set again
 * under a new blinding, and a signer seated later is sealed into the policy in
 * force without changing it. Two stand-ins, named: the contract's keys and
 * commitment are a function of their inputs written here, and what the chain
 * holds is a map this file keeps. The directory is one this file writes,
 * judged by the device's own rules.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonical, newSigningKeypair, newWrappingKeypair, seal } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import { assetIdHex } from '../../../src/core/assets.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openSpendingPolicy, sealSpendingPolicy } from '../../../src/midnight/spending-policy-record.js';
import { companyRecordEntry, recordKeyOf } from '../../../src/midnight/record-manifest.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { kindAsked } from './vault-page-doors.js';
import {
  refusePolicyChangeHere, removalBoundaryRefusal, sealPoliciesToNewSignersHere, setSpendingPolicyOnDevice, spendingPolicyHere,
  type PoliciesResealed, type PolicyGovernanceDoors,
} from './spending-policy-here.js';
import { heldFiledBy } from '../../../src/testing/record-tree-double.js';
import type { OpenedRound } from './governed-call-builder.js';

/* What each proposal opens as on this device: what this file says it raised. Opening real proposals is not this file's subject. */
const seams = vi.hoisted(() => ({ opens: undefined as unknown as (proposalId: string) => Promise<OpenedRound> }));
vi.mock('./round-opened-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: (_s: unknown, _a: string, proposalId: string) => seams.opens(proposalId),
}));
/* Every proposal the service lists is one the company's records name: a withheld proposal is `listedHere`'s own subject. */
vi.mock('./vault-page-doors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault-page-doors.js')>()),
  listedHere: (_h: unknown, _s: unknown, served: unknown) => served,
}));

const COMPANY = 'acme';
const VAULT = 'fa'.repeat(32);
const VIEWING = 'cd'.repeat(32);
const COMMITTEE = { tag: 'ed25519', value: 'aa'.repeat(16) };

/** Three signers: each a filing key, a wrapping key and a seat. */
const signerOf = (n: string) => ({ seat: n.repeat(32), filing: newSigningKeypair(), wrap: newWrappingKeypair() });
const ADA = signerOf('e1');
const BO = signerOf('e2');
const CY = signerOf('e3');
const EVERYONE = [ADA, BO, CY];
type Signer = typeof ADA;

const TERMS = {
  bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '1' }, { ceiling: '30', approvals: '1' }, { ceiling: '40', approvals: '1' }],
  periodLimit: '100', periodStart: '0', periodLength: '60',
};
const OTHER_TERMS = { ...TERMS, periodLimit: '90' };
const made = (...parts: string[]): string => createHash('sha256').update(parts.join(':')).digest('hex');
const POLICY_KEY = made('policy', VAULT);
const keysOf = (i: { vault: string; asset: string; assetBlinding: string; policy?: { terms: { periodLimit: string }; blinding: string } }) => ({
  assetKey: made('asset', i.asset), policyKey: made('policy', i.vault), onKey: made('on', i.vault), barKey: made('bar'),
  commitment: i.policy === undefined ? null : made('commitment', i.policy.terms.periodLimit, i.policy.blinding),
});
const commitmentOf = (terms: { periodLimit: string }, blinding: string) => made('commitment', terms.periodLimit, blinding);
const chainHolding = (terms: { periodLimit: string }, blinding: string) =>
  new Map([[made('on', VAULT), '01'], [POLICY_KEY, commitmentOf(terms, blinding)]]);

/** A seat as the directory holds it: its role, and once retired, its boundary. */
type SeatAs = { readonly who: Signer; readonly role?: string; readonly retired?: Record<string, number> };
const seatRow = (s: SeatAs) => ({
  seat: s.who.seat, person: s.who.seat.slice(0, 4), signingKey: s.who.filing.publicKey, wrappingKey: s.who.wrap.publicKey,
  committeeKey: COMMITTEE, role: s.role ?? 'admin', retired: s.retired ?? null,
});

interface World {
  readonly seats: readonly SeatAs[];
  /** The seats the chain holds now. */
  readonly onChain: readonly Signer[];
  readonly chain: Map<string, string>;
  readonly filed: SealedCompanyRecord[];
  /** The device reading: whose wrapping secret opens a version, and whose filing key signs one. */
  readonly as?: Signer;
  /**
   * Versions the anchor holds, each with the batch that anchored it (by default its place in this list, from 1) and the
   * newest directory version anchored through that batch; the batch that anchored each directory version; the
   * directory at each version.
   */
  readonly anchored?: ReadonlyArray<{ readonly rec: SealedCompanyRecord; readonly dirVersion: number; readonly batch?: number }>;
  readonly dirBatches?: Readonly<Record<number, number>>;
  readonly dirAt?: Readonly<Record<number, readonly SeatAs[]>>;
  /** Seats whose entry names a records key their own wallet has not attested in the roster this device opened. */
  readonly another?: readonly Signer[];
  /** The approvals a change of who is seated needs, as the person's own wallet reads it off the account. */
  readonly seatBar?: number;
}

const recordsOf = (w: World): CompanyRecordsHere => {
  const as = w.as ?? ADA;
  const state = signedFoundingState(COMPANY, {
    keyEpoch: 0, sealed: seal(canonical({ state: {}, blinding: { assetBlinding: 'ab'.repeat(32), payRecordKey: 'ef'.repeat(32) } }), VIEWING),
  } as never, ADA.filing.secret);
  const notHere = async () => { throw new Error('not read here'); };
  return {
    directory: async () => {
      const dirOf = (seats: readonly SeatAs[], version: number) => ({ company: COMPANY, version, seats: seats.map(seatRow) });
      const believed = {
        dir: dirOf(w.seats, 9),
        holders: {
          committee: [COMMITTEE], seats: w.onChain.map((x) => x.seat), approvals: 1, adoptedVaults: [VAULT], account: 'ac'.repeat(32),
          ...(w.seatBar === undefined ? {} : { seatBar: w.seatBar }),
        },
        another: new Set<string>((w.another ?? []).map((x) => x.seat)),
        at: (v: number) => (w.dirAt?.[v] === undefined ? null : { dir: dirOf(w.dirAt[v]!, v), digests: [] }),
      };
      const records = await heldFiledBy(COMPANY, w.filed, EVERYONE.map((x) => x.filing.secret),
        { seat: ADA.seat, signingSecret: ADA.filing.secret, records: [state], committee: [COMMITTEE] }, believed as never);
      const key = recordKeyOf({ store: 'company', kind: 'spending-policy', id: POLICY_KEY });
      const history = new Map(records.history);
      if (w.anchored !== undefined) {
        history.set(key, w.anchored.map(({ rec, dirVersion, batch }, i) => ({
          version: rec.version, digest: companyRecordEntry(rec).digest, filedBy: rec.filedBy!.publicKey.toLowerCase(), batch: batch ?? i + 1, dirVersion,
        })) as never);
      }
      const directory = w.dirBatches === undefined ? records.directory
        : new Map(Object.entries(w.dirBatches).map(([v, batch]) => [Number(v), { digest: '00'.repeat(32), batch, held: undefined }] as const));
      return { ...believed, records: { ...records, history, directory } } as never;
    },
    people: notHere as never, runs: notHere as never, policy: notHere as never,
    state: async (id) => (id === '0' ? state : null),
    roundIdentity: undefined as never,
    payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: notHere as never },
    spendingPolicies: {
      versions: async (id) => w.filed.filter((r) => r.id === id),
      file: async (rec) => { w.filed.push(signCompanyFiling(rec, as.filing.secret)); },
      me: { signerId: as.seat, wrappingSecret: as.wrap.secret },
      keys: async (i) => keysOf(i),
      onChain: async (keys) => new Map(keys.map((k) => [k, w.chain.get(k) ?? null])),
    },
  };
};
const doorsOf = (w: World) => ({ records: recordsOf(w), accountId: COMPANY, viewingKey: VIEWING });

/** A version of the policy's record, sealed to `to` and signed by `by`. */
const versionOf = (version: number, blinding: string, to: readonly Signer[], by: Signer, terms = TERMS): SealedCompanyRecord =>
  signCompanyFiling(sealSpendingPolicy({
    company: COMPANY, id: POLICY_KEY, version, keyEpoch: 0,
    secrets: { vault: VAULT, asset: TEST_TOKEN, opening: { terms, blinding } },
    signers: to.map((x) => ({ id: x.seat, wrappingPublicKey: x.wrap.publicKey })) as never,
  }), by.filing.secret as never);
const readersOf = (rec: SealedCompanyRecord) => rec.wrapped.map((x) => x.signerId).sort();
const read = (w: World) => spendingPolicyHere(doorsOf(w), { vault: VAULT, asset: TEST_TOKEN });
/** The version of the policy in force; a vault under no policy has none, which a test of versions must not pass over. */
const versionHeld = (x: Awaited<ReturnType<typeof read>>): number => {
  if (x.state !== 'set') throw new Error(`no policy in force: ${x.state}`);
  return x.version;
};

const B1 = 'b1'.repeat(32);
const B2 = 'b2'.repeat(32);
/** Bo, retired with no policy version of his own. */
const BO_RETIRED: SeatAs = { who: BO, retired: {} };

describe('A VAULT\'S SPENDING POLICY AS SIGNERS LEAVE AND JOIN', () => {
  it('A SIGNER WHO LEAVES TAKES NO POLICY WITH THEM: THE SIGNERS WHO STAY STILL READ THE ONE IN FORCE', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    /* Sealed to both while both were seated, anchored before Bo was retired. */
    const w: World = {
      seats: [{ who: ADA }, BO_RETIRED], onChain: [ADA], chain: chainHolding(TERMS, B1), filed: [v1],
      anchored: [{ rec: v1, dirVersion: 1 }], dirBatches: { 1: 1, 2: 2 }, dirAt: { 1: [{ who: ADA }, { who: BO }] },
    };
    /* RED WHEN: a removal leaves a policy unreadable to a signer who stays. */
    await expect(read(w)).resolves.toMatchObject({ state: 'set', version: 1, commitment: commitmentOf(TERMS, B1) });
  });

  it('A POLICY CHANGE CARRIED WHILE A SIGNER WAS SEATED STAYS READABLE WHEN IT IS ANCHORED TOGETHER WITH THEIR RETIREMENT', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    /* Filed and carried while Bo was seated, so sealed to him too; its entry waited and was anchored in the retirement's batch. */
    const v2 = versionOf(2, B2, [ADA, BO], ADA, OTHER_TERMS);
    const w: World = {
      seats: [{ who: ADA }, BO_RETIRED], onChain: [ADA], chain: chainHolding(OTHER_TERMS, B2), filed: [v1, v2],
      anchored: [{ rec: v1, dirVersion: 1, batch: 1 }, { rec: v2, dirVersion: 2, batch: 2 }], dirBatches: { 1: 1, 2: 2 },
      dirAt: { 1: [{ who: ADA }, { who: BO }], 2: [{ who: ADA }, BO_RETIRED] },
    };
    /* RED WHEN: a version anchored in the same batch as a retirement is judged as filed after it - the vault's policy is unreadable for good. */
    await expect(read(w)).resolves.toMatchObject({ state: 'set', version: 2, commitment: commitmentOf(OTHER_TERMS, B2) });
  });

  it('A POLICY SET AFTER A SIGNER LEFT IS NEVER SEALED TO THEM', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    const v2 = versionOf(2, B2, [ADA, BO], ADA, OTHER_TERMS);
    const w: World = {
      seats: [{ who: ADA }, BO_RETIRED], onChain: [ADA], chain: chainHolding(OTHER_TERMS, B2), filed: [v1, v2],
      anchored: [{ rec: v1, dirVersion: 1, batch: 1 }, { rec: v2, dirVersion: 2, batch: 3 }], dirBatches: { 1: 1, 2: 2 },
      dirAt: { 1: [{ who: ADA }, { who: BO }], 2: [{ who: ADA }, BO_RETIRED] },
    };
    /* RED WHEN: a version anchored after a seat's retirement and sealed to that seat is believed - the signer who left reads it. */
    await expect(read(w)).rejects.toThrow(/None of the company's records/u);
    /* The chain holds it, approved at the bar: a signer who stays seals the same opening to the signers who stay, and not to Bo. */
    const recovered: World = { ...w, filed: [v1, v2] };
    expect(await sealPoliciesToNewSignersHere({ ...doorsOf(recovered), keyEpoch: 0, filingKey: ADA.filing.publicKey })).toEqual({ sealed: [POLICY_KEY], refused: [] });
    /* RED WHEN: a policy the chain holds that no device believes is never sealed again to the signers who stay, so the vault never pays again. */
    expect(readersOf(recovered.filed[2]!)).toEqual([ADA.seat]);
    await expect(read(recovered)).resolves.toMatchObject({ state: 'set', version: 3, commitment: commitmentOf(OTHER_TERMS, B2) });
    /* RED WHEN: a version not yet anchored, sealed to a seat retired now, is believed. */
    const pending: World = { seats: [{ who: ADA }, BO_RETIRED], onChain: [ADA], chain: chainHolding(OTHER_TERMS, B2), filed: [v2] };
    await expect(read(pending)).rejects.toThrow(/None of the company's records/u);
    /* RED WHEN: a version anchored with a directory this device cannot replay is believed on a guess. */
    const unreplayed: World = {
      seats: [{ who: ADA }, { who: BO }], onChain: [ADA, BO], chain: chainHolding(TERMS, B1), filed: [v1],
      anchored: [{ rec: v1, dirVersion: 3, batch: 2 }], dirBatches: { 3: 1 },
    };
    await expect(read(unreplayed)).rejects.toThrow(/None of the company's records/u);
    await expect(read({ ...unreplayed, dirAt: { 3: [{ who: ADA }, { who: BO }] } })).rejects.toThrow(/None of the company's records/u);
    await expect(read({ ...unreplayed, dirBatches: { 1: 1, 2: 1, 3: 1 } })).rejects.toThrow(/None of the company's records/u);
    await expect(read({ ...unreplayed, dirBatches: { 1: 1, 2: 1, 3: 1 }, dirAt: { 3: [{ who: ADA }, { who: BO }] } })).resolves.toMatchObject({ version: 1 });
  });

  it('NO VERSION SHUTS OUT A SIGNER WHO STAYS, AND A SIGNER SEATED LATER MAY BE LEFT OUT UNTIL SEALED IN', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    const both: World = { seats: [{ who: ADA }, { who: BO }], onChain: [ADA, BO], chain: chainHolding(OTHER_TERMS, B2), filed: [] };
    /* RED WHEN: a version leaving out a signer who stays is believed - that signer could never raise or approve a run from the vault. */
    await expect(read({ ...both, filed: [v1, versionOf(2, B2, [ADA], ADA, OTHER_TERMS)] })).rejects.toThrow(/None of the company's records/u);
    await expect(read({ ...both, filed: [v1, versionOf(2, B2, [ADA, BO], ADA, OTHER_TERMS)] })).resolves.toMatchObject({ version: 2 });
    /* The first version is judged by the other rules alone. */
    await expect(read({ ...both, chain: chainHolding(TERMS, B1), filed: [versionOf(1, B1, [ADA], ADA)] })).resolves.toMatchObject({ version: 1 });
    /* RED WHEN: a signer seated after the policy was set makes the policy unbelieved for everybody, freezing the vault. */
    const joined: World = {
      seats: [{ who: ADA }, { who: BO }, { who: CY }], onChain: [ADA, BO, CY], chain: chainHolding(OTHER_TERMS, B2),
      filed: [v1, versionOf(2, B2, [ADA, BO], ADA, OTHER_TERMS)],
    };
    await expect(read(joined)).resolves.toMatchObject({ version: 2 });
  });

  it('WHETHER A VERSION IS BELIEVED DOES NOT CHANGE WITH WHAT THE ROSTER THIS DEVICE OPENED ATTESTS, AND A POLICY IN FORCE NOBODY BELIEVES IS SEALED AGAIN', async () => {
    const v1 = versionOf(1, B1, [ADA, BO, CY], ADA);
    /* Filed while Ada's device did not believe Cy's records key, so sealed to Ada and Bo only; carried. */
    const v2 = versionOf(2, B2, [ADA, BO], ADA, OTHER_TERMS);
    const filed = [v1, v2];
    const w: World = { seats: [{ who: ADA }, { who: BO }, { who: CY }], onChain: [ADA, BO, CY], chain: chainHolding(OTHER_TERMS, B2), filed };
    const lagging = await read({ ...w, another: [CY] }).then(versionHeld, (e: Error) => e.message.slice(0, 20));
    const caughtUp = await read(w).then(versionHeld, (e: Error) => e.message.slice(0, 20));
    /* RED WHEN: a version is believed while a roster lags and refused once it catches up - a policy carried in between is then unreadable. */
    expect(lagging).toBe(caughtUp);
    expect(await sealPoliciesToNewSignersHere({ ...doorsOf(w), keyEpoch: 0, filingKey: ADA.filing.publicKey })).toEqual({ sealed: [POLICY_KEY], refused: [] });
    /* RED WHEN: the policy the chain holds, opened by a version no device believes, is never sealed again to every signer who stays. */
    expect(readersOf(filed[2]!)).toEqual([ADA.seat, BO.seat, CY.seat].sort());
    await expect(read({ ...w, as: CY })).resolves.toMatchObject({ state: 'set', version: 3, commitment: commitmentOf(OTHER_TERMS, B2) });
  });

  it('THE SAME TERMS ARE NEVER SET AGAIN UNDER A NEW BLINDING, BY THE RAISER OR AN APPROVER', async () => {
    const v1 = versionOf(1, B1, [ADA], ADA);
    /* An older change to the same terms, still on file, believed and sealed to exactly the seats believed now. */
    const stale = versionOf(2, B2, [ADA], ADA);
    const filed = [v1, stale];
    const w: World = { seats: [{ who: ADA }], onChain: [ADA], chain: chainHolding(TERMS, B1), filed };
    const sent: string[] = [];
    const doors = {
      ...doorsOf(w),
      service: new Proxy({}, { get: (_t, name) => async () => { sent.push(String(name)); throw new Error('nothing is sent here'); } }),
      material: { signingSecret: ADA.filing.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: ADA.seat, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: { policyBarKey: async () => made('bar') },
    } as unknown as PolicyGovernanceDoors;
    /* RED WHEN: the same terms are raised again under a new blinding, so the vault's period total starts from zero. */
    await expect(setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: TERMS }))
      .rejects.toThrow(/already has exactly this spending policy/u);
    expect([filed.length, sent]).toEqual([2, []]);
    /* RED WHEN: an approving device approves a proposal for exactly the terms in force under another commitment. */
    const keys = keysOf({ vault: VAULT, asset: TEST_TOKEN, assetBlinding: '' });
    await expect(refusePolicyChangeHere(doorsOf(w), VAULT, TEST_TOKEN, keys as never, { commitment: commitmentOf(TERMS, B2) }))
      .rejects.toThrow(/exactly the spending policy this vault already has/u);
    /* A real change of terms is approved. */
    const change = versionOf(3, 'b3'.repeat(32), [ADA], ADA, OTHER_TERMS);
    await expect(refusePolicyChangeHere(doorsOf({ ...w, filed: [...filed, change] }), VAULT, TEST_TOKEN, keys as never,
      { commitment: commitmentOf(OTHER_TERMS, 'b3'.repeat(32)) })).resolves.toBeUndefined();
  });

  it('A DEVICE THAT CANNOT OPEN THE POLICY IN FORCE CHANGES NOTHING', async () => {
    /* The policy in force is sealed to Ada alone; Bo's device cannot open it. */
    const filed = [versionOf(1, B1, [ADA], ADA)];
    const w: World = { seats: [{ who: ADA }, { who: BO }], onChain: [ADA, BO], chain: chainHolding(TERMS, B1), filed, as: BO };
    const doors = {
      ...doorsOf(w),
      service: new Proxy({}, { get: () => async () => { throw new Error('nothing is sent here'); } }),
      material: { signingSecret: BO.filing.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: BO.seat, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: { policyBarKey: async () => made('bar') },
    } as unknown as PolicyGovernanceDoors;
    /* RED WHEN: a device that cannot open the policy in force files or raises a change - the same terms under a new blinding pass. */
    await expect(setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: TERMS }))
      .rejects.toThrow(/cannot open the spending policy this vault holds now/u);
    expect(filed).toHaveLength(1);
    /* RED WHEN: such a device approves or carries out a change it cannot compare with the policy in force. */
    const change = versionOf(2, B2, [ADA, BO], ADA);
    const keys = keysOf({ vault: VAULT, asset: TEST_TOKEN, assetBlinding: '' });
    await expect(refusePolicyChangeHere(doorsOf({ ...w, filed: [...filed, change] }), VAULT, TEST_TOKEN, keys as never,
      { commitment: commitmentOf(TERMS, B2) })).rejects.toThrow(/cannot open the spending policy this vault holds now/u);
  });

  it('A POLICY FILED BY A SIGNER WHOSE REMOVAL IS RAISED IS NOT APPROVED', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    const bosChange = versionOf(2, B2, [ADA, BO], BO, OTHER_TERMS);
    const w: World = { seats: [{ who: ADA }, { who: BO }], onChain: [ADA, BO], chain: chainHolding(TERMS, B1), filed: [v1, bosChange] };
    const keys = keysOf({ vault: VAULT, asset: TEST_TOKEN, assetBlinding: '' });
    const approve = (leaving: readonly Signer[]) => refusePolicyChangeHere(doorsOf(w), VAULT, TEST_TOKEN, keys as never, {
      commitment: commitmentOf(OTHER_TERMS, B2), leaving: async () => new Set(leaving.map((x) => x.filing.publicKey)),
    });
    await expect(approve([])).resolves.toBeUndefined();
    /* RED WHEN: a policy version filed by a seat under a raised removal is approved, so a signer on their way out sets the terms the company keeps. */
    await expect(approve([BO])).rejects.toThrow(/filed by a signer whose removal is raised/u);
  });

  it('A REMOVAL WHOSE BOUNDARY LEAVES OUT A POLICY VERSION THE LEAVER FILED IS REFUSED', async () => {
    const filed = [versionOf(1, B1, [ADA, BO], ADA), versionOf(2, B2, [ADA, BO], BO, OTHER_TERMS)];
    const here = await recordsOf({ seats: [{ who: ADA }, { who: BO }], onChain: [ADA, BO], chain: new Map(), filed })
      .directory(kindAsked('company', 'spending-policy'));
    const key = companyRecordKey('spending-policy', POLICY_KEY);
    /* RED WHEN: a removal is approved with a boundary below a version the leaver filed - that version is believed by no device after. */
    expect(removalBoundaryRefusal(here, BO.filing.publicKey, { [key]: 1 })).toMatch(/version 2 of a vault's spending policy/u);
    expect(removalBoundaryRefusal(here, BO.filing.publicKey, {})).toMatch(/past the last version this removal keeps \(0\)/u);
    expect(removalBoundaryRefusal(here, BO.filing.publicKey, { [key]: 2 })).toBeNull();
    /* Another signer's versions are not the leaver's to keep. */
    expect(removalBoundaryRefusal(here, CY.filing.publicKey, {})).toBeNull();
  });

  it('A SIGNER SEATED LATER IS SEALED INTO THE POLICY IN FORCE, WHICH DOES NOT CHANGE', async () => {
    const filed = [versionOf(1, B1, [ADA, BO], ADA)];
    const chain = chainHolding(TERMS, B1);
    const seats: SeatAs[] = [{ who: ADA }, { who: BO }, { who: CY }];
    const w: World = { seats, onChain: [ADA, BO, CY], chain, filed };
    /* Cy cannot read it yet. */
    await expect(read({ ...w, as: CY })).rejects.toThrow(/None of the company's records/u);
    const done: PoliciesResealed = await sealPoliciesToNewSignersHere({ ...doorsOf(w), keyEpoch: 0, filingKey: ADA.filing.publicKey });
    expect(done).toEqual({ sealed: [POLICY_KEY], refused: [] });
    /* RED WHEN: a newly seated signer is not sealed into the policy in force, so they can never raise or approve a run from the vault. */
    expect(filed).toHaveLength(2);
    expect(readersOf(filed[1]!)).toEqual([ADA.seat, BO.seat, CY.seat].sort());
    /* RED WHEN: the re-seal mints a new blinding - the chain's commitment and the vault's period total would change. */
    expect(openSpendingPolicy(filed[1]!, { signerId: CY.seat, wrappingSecret: CY.wrap.secret as never }).secrets.opening).toEqual({ terms: TERMS, blinding: B1 });
    await expect(read({ ...w, as: CY })).resolves.toMatchObject({ state: 'set', version: 2, commitment: commitmentOf(TERMS, B1) });
    expect(chain.get(POLICY_KEY)).toBe(commitmentOf(TERMS, B1));
    /* Everybody is sealed in now: nothing more is filed, and the same terms are still refused as a change. */
    await sealPoliciesToNewSignersHere({ ...doorsOf(w), keyEpoch: 0, filingKey: ADA.filing.publicKey });
    expect(filed).toHaveLength(2);
  });

  it('A RE-SEAL IS SEALED TO NO RETIRED SEAT, AND ONLY A SEAT THAT MAY FILE A POLICY AND CAN OPEN IT FILES ONE', async () => {
    const v1 = versionOf(1, B1, [ADA, BO], ADA);
    const filed = [v1];
    const w: World = {
      seats: [{ who: ADA }, BO_RETIRED, { who: CY }], onChain: [ADA, CY], chain: chainHolding(TERMS, B1), filed,
      anchored: [{ rec: v1, dirVersion: 1 }], dirBatches: { 1: 1, 2: 2 }, dirAt: { 1: [{ who: ADA }, { who: BO }] },
    };
    /* RED WHEN: a device whose seat may not file a spending policy files a re-seal. */
    const approver: World = { ...w, seats: [{ who: ADA, role: 'approver' }, BO_RETIRED, { who: CY }] };
    expect(await sealPoliciesToNewSignersHere({ ...doorsOf(approver), keyEpoch: 0, filingKey: ADA.filing.publicKey })).toEqual({ sealed: [], refused: [] });
    expect(filed).toHaveLength(1);
    /* RED WHEN: a device that cannot open the policy in force files anything for it. */
    expect(await sealPoliciesToNewSignersHere({ ...doorsOf({ ...w, as: CY }), keyEpoch: 0, filingKey: CY.filing.publicKey })).toEqual({ sealed: [], refused: [] });
    expect(filed).toHaveLength(1);
    await sealPoliciesToNewSignersHere({ ...doorsOf(w), keyEpoch: 0, filingKey: ADA.filing.publicKey });
    /* RED WHEN: a retired seat is sealed into a re-seal - a signer who left reads the policy again. */
    expect(readersOf(filed[1]!)).toEqual([ADA.seat, CY.seat].sort());
    await expect(read({ ...w, as: CY })).resolves.toMatchObject({ state: 'set', version: 2 });
  });
});

describe('A SPENDING POLICY WHILE A SIGNER\'S REMOVAL IS RAISED', () => {
  /* The same bands as the policy in force, but for the last: what a change asks of the approvals a change of who is seated needs. */
  const lastBandAt = (approvals: string) => ({ ...TERMS, bands: [...TERMS.bands.slice(0, 3), { ceiling: '40', approvals }], periodLimit: `9${approvals}` });
  const ABOVE = lastBandAt('3');
  const AT = lastBandAt('2');
  const B3 = 'b3'.repeat(32);
  const ASSET_KEY = made('asset', assetIdHex(TEST_TOKEN));

  /**
   * Ada, Bo and Cy seated at a seat bar of two, the policy in force readable by all three, Cy's removal raised with one
   * approval and `policy` (a proposal for a change of policy, at its approvals so far) raised beside it where given.
   * Ada's device; everything it would send is written down, and the chain is never reached.
   */
  const aCompany = (filed: SealedCompanyRecord[], policy?: { commitment: string; approvals: number }) => {
    const w: World = {
      seats: [{ who: ADA }, { who: BO }, { who: CY }], onChain: [ADA, BO, CY], chain: chainHolding(TERMS, B1), filed, seatBar: 2,
    };
    const served = [
      { id: 'prp_removal', accountId: COMPANY, status: 'open', chainId: '0a'.repeat(32), approvalCount: 1, raisedAt: 'now', createdAt: '2026-10-16' },
      ...(policy === undefined ? [] : [{
        id: 'prp_policy', accountId: COMPANY, status: 'open', chainId: '0b'.repeat(32), approvalCount: policy.approvals, raisedAt: 'now', createdAt: '2026-10-16',
      }]),
    ];
    const opened = (chainId: string, governance: OpenedRound['governance']): OpenedRound =>
      ({ chainId, digest: 'dd'.repeat(32), vault: '00'.repeat(32), salt: '11'.repeat(32), summary: '', governance } as OpenedRound);
    seams.opens = async (id) => (id === 'prp_removal' ? opened('0a'.repeat(32), { kind: 'remove-signer', leaf: CY.seat })
      : opened('0b'.repeat(32), { kind: 'spending-policy', vault: VAULT, assetKey: ASSET_KEY, commitment: policy!.commitment }));
    const sent: string[] = [];
    const records = {
      ...recordsOf(w),
      roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => {
        const p = served.find((x) => x.chainId === id)!;
        return [id, { held: 'open', approvals: p.approvalCount, raisedAt: 1, txRef: id }];
      })),
    };
    const doors = {
      records, accountId: COMPANY, viewingKey: VIEWING,
      service: {
        sealedProposals: async () => served,
        standing: async (id: string) => served.find((x) => x.id === id),
        callState: async () => ({ account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }),
        file: async () => { sent.push('raise'); throw new Error('nothing is sent here'); },
        approve: async () => { sent.push('approve'); throw new Error('nothing is sent here'); },
        carry: async () => { sent.push('carry'); throw new Error('nothing is sent here'); },
      },
      material: { signingSecret: ADA.filing.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: ADA.seat, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1', entered: { enter: async () => {} } },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: {
        policyBarKey: async () => made('bar'),
        proposalIdentity: async () => ({ digest: 'dd'.repeat(32), chainId: '0c'.repeat(32), noVault: '00'.repeat(32) }),
        governedCall: async () => { sent.push('build'); throw new Error('nothing is built here'); },
      },
    } as unknown as PolicyGovernanceDoors;
    return { doors, sent, set: (terms: typeof TERMS) => setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms }) };
  };

  it('A POLICY WHOSE HIGHEST BAND IS ABOVE THE SEAT BAR IS NOT RAISED, APPROVED OR CARRIED OUT UNTIL THE REMOVAL IS CARRIED OUT OR WITHDRAWN', async () => {
    const v1 = versionOf(1, B1, [ADA, BO, CY], ADA);
    const raising = aCompany([v1]);
    /* RED WHEN: a policy needing three approvals is raised while a removal is open at a bar of two - once carried out, the removal never can be. */
    await expect(raising.set(ABOVE)).rejects.toThrow(/would raise the approvals a change of who is seated needs while a removal of a signer is raised/u);
    expect(raising.sent).toEqual([]);
    /* The same change raised beside the removal before this device saw it, one approval short. */
    const filed = [v1, versionOf(2, B3, [ADA, BO, CY], ADA, ABOVE)];
    const approving = aCompany(filed, { commitment: commitmentOf(ABOVE, B3), approvals: 1 });
    /* RED WHEN: a policy needing three approvals is approved while a removal is open at a bar of two. */
    await expect(approving.set(ABOVE)).rejects.toThrow(/would raise the approvals a change of who is seated needs while a removal of a signer is raised/u);
    expect(approving.sent).toEqual([]);
    /* RED WHEN: a policy needing three approvals is carried out while a removal is open at a bar of two. */
    const carrying = aCompany(filed, { commitment: commitmentOf(ABOVE, B3), approvals: 2 });
    await expect(carrying.set(ABOVE)).rejects.toThrow(/would raise the approvals a change of who is seated needs while a removal of a signer is raised/u);
    expect(carrying.sent).toEqual([]);
  });

  it('A POLICY WHOSE HIGHEST BAND IS AT THE SEAT BAR IS RAISED AND APPROVED WHILE A REMOVAL IS RAISED', async () => {
    const v1 = versionOf(1, B1, [ADA, BO, CY], ADA);
    const raising = aCompany([v1]);
    /* Past every check: the raise is built and handed to the builder. */
    /* RED WHEN: a policy at the seat bar is refused while a removal is raised, so no policy can be set until the removal ends. */
    await expect(raising.set(AT)).rejects.toThrow(/nothing is built here/u);
    expect(raising.sent).toEqual(['build']);
    const approving = aCompany([v1, versionOf(2, B3, [ADA, BO, CY], ADA, AT)], { commitment: commitmentOf(AT, B3), approvals: 1 });
    await expect(approving.set(AT)).rejects.toThrow(/nothing is built here/u);
    expect(approving.sent).toEqual(['build']);
  });
});
