/**
 * Where a vault stands for one currency as a device reads it, and what setting
 * a policy refuses before anything is filed or sent, and which versions of the
 * policy's record a device believes. Two stand-ins, named: the contract's keys
 * and commitment are a function of their inputs written here (the real ones
 * are driven in `contracts/test/a-spending-policy-is-set-from-a-device.test.ts`),
 * and what the chain holds is a map this file keeps. The directory is one this
 * file writes, judged by the device's own rules (`judgeIn`, `readersIn`).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonical, newSigningKeypair, newWrappingKeypair, seal, type Hex } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openSpendingPolicy, sealSpendingPolicy } from '../../../src/midnight/spending-policy-record.js';
import { MOST_ROLES_ASKED } from 'midnight-identity/profile/request';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import {
  chainReadThroughTheWallet, policyProposedHere, policyReadHere, refusePolicyChangeHere, setPolicyBarOnDevice, setSpendingPolicyOnDevice,
  type PolicyGovernanceDoors,
} from './spending-policy-here.js';
import { spendingPoliciesHere, spendingPolicyHere, type PolicyPair } from './spending-policy-read-here.js';
import { accountReadsAnswered } from './account-reads-answered.js';
import { spendingPolicyKeysOf } from './governed-call-builder.js';
import { assetIdHex } from '../../../src/core/assets.js';
import { heldFiledBy } from '../../../src/testing/record-tree-double.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { withCompanyKeys } from './governed-call-on-device.js';
import { noOneOffsHere } from '../../../src/testing/no-one-offs.js';

/*
 * The proposal a device opens from the company's records, stood in for: what its sealed body says the change is, as
 * `round-opened-here.ts` opens it (followed in its own tests). Null when no proposal is opened here.
 */
const round = vi.hoisted(() => ({ opened: null as null | { chainId: string; governance: Record<string, string> } }));
vi.mock('./round-opened-here.js', async (real) => ({
  ...(await real<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: async () => { if (round.opened === null) throw new Error('no proposal is opened here'); return round.opened; },
}));

/* Each change handed to the shared governed call, as it was handed: followed in its own tests, only watched here. */
const governed = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }));
vi.mock('./company-change-on-device.js', async (real) => {
  const actual = await real<typeof import('./company-change-on-device.js')>();
  return { ...actual, governOnDevice: (d: never, i: Record<string, unknown>) => { governed.inputs.push(i); return actual.governOnDevice(d, i as never); } };
});

const COMPANY = 'acme';
const VAULT = 'fa'.repeat(32);
const VIEWING = 'cd'.repeat(32);
const founder = newSigningKeypair();
const me = newWrappingKeypair();
const SEAT = 'e1'.repeat(32);
/* Somebody the company's directory holds no entry for: the service, or anybody it names. */
const stranger = newSigningKeypair();
const strangerWrap = newWrappingKeypair();
/* A second seat in the directory, which this device believes until it is taken off the chain. */
const second = newSigningKeypair();
const secondWrap = newWrappingKeypair();
const SECOND = 'e2'.repeat(32);
const COMMITTEE2 = { tag: 'ed25519', value: 'bb'.repeat(16) };
const COMMITTEE = { tag: 'ed25519', value: 'aa'.repeat(16) };
const TERMS = {
  bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '1' }, { ceiling: '30', approvals: '1' }, { ceiling: '40', approvals: '1' }],
  periodLimit: '100', periodStart: '0', periodLength: '60',
};
/* The stand-in for the contract's keys: each one named by what it is made from. */
const made = (...parts: string[]): string => createHash('sha256').update(parts.join(':')).digest('hex');
const keysOf = (i: { vault: string; asset: string; assetBlinding: string; policy?: { terms: { periodLimit: string }; blinding: string } }) => ({
  assetKey: made('asset', i.asset), policyKey: made('policy', i.vault), onKey: made('on', i.vault), barKey: made('bar'),
  commitment: i.policy === undefined ? null : made('commitment', i.policy.terms.periodLimit, i.policy.blinding),
});

/** The seats the directory holds, and which of them the chain holds now. */
const seatsFor = (secondSeated: boolean) => ({
  seats: [
    { seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: me.publicKey, committeeKey: COMMITTEE, role: 'admin', retired: null },
    { seat: SECOND, person: 'bo', signingKey: second.publicKey, wrappingKey: secondWrap.publicKey, committeeKey: COMMITTEE2, role: 'admin', retired: null },
  ],
  onChain: secondSeated ? [SEAT, SECOND] : [SEAT],
});
const recordsWith = (chain: Map<string, string>, filed: SealedCompanyRecord[], secondSeated = false): CompanyRecordsHere => {
  const { seats, onChain } = seatsFor(secondSeated);
  const state = signedFoundingState(COMPANY, {
    keyEpoch: 0, sealed: seal(canonical({ state: {}, blinding: { assetBlinding: 'ab'.repeat(32), payRecordKey: 'ef'.repeat(32) } }), VIEWING),
  } as never, founder.secret);
  const notHere = async () => { throw new Error('not read here'); };
  return {
    oneOffs: noOneOffsHere(),
    directory: async () => {
      const believed = {
        dir: { company: COMPANY, version: 1, seats },
        holders: { committee: [COMMITTEE, COMMITTEE2], seats: onChain, approvals: 1, adoptedVaults: [VAULT], account: 'ac'.repeat(32) },
        another: new Set<string>(), at: () => null,
      };
      /* Every version filed, entered by the seat whose key signed it; nothing anchored yet but the first state, as the company was founded. */
      const records = await heldFiledBy(COMPANY, filed, [founder, stranger, second].map((k) => k.secret), { seat: SEAT, signingSecret: founder.secret, records: [state], committee: [COMMITTEE] }, believed as never);
      return { ...believed, records } as never;
    },
    people: notHere as never, runs: notHere as never, policy: notHere as never,
    state: async (id) => (id === '0' ? state : null),
    roundIdentity: pureCircuits,
    payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: notHere as never },
    spendingPolicies: {
      versions: async (id) => filed.filter((r) => r.id === id),
      /* The store files a version signed by this device's seat. */
      file: async (rec) => { filed.push(signCompanyFiling(rec, founder.secret)); },
      me: { signerId: SEAT, wrappingSecret: me.secret },
      keys: async (i) => keysOf(i),
      grantReaders: async () => [],
      onChain: async (keys) => new Map(keys.map((k) => [k, chain.get(k) ?? null])),
    },
  };
};
const reader = (chain: Map<string, string>, filed: SealedCompanyRecord[] = [], secondSeated = false) => ({
  records: recordsWith(chain, filed, secondSeated), accountId: COMPANY, viewingKey: VIEWING,
});
/** A version of the policy's record for `terms` under `blinding`, sealed to `to` and signed by `by`, or unsigned. */
const versionOf = (
  version: number, blinding: string, to: ReadonlyArray<{ id: string; wrappingPublicKey: string }>, by: { secret: string } | null, terms = TERMS,
): SealedCompanyRecord => {
  const rec = sealSpendingPolicy({
    company: COMPANY, id: made('policy', VAULT), version, keyEpoch: 0,
    secrets: { vault: VAULT, asset: TEST_TOKEN, opening: { terms, blinding } }, signers: to as never,
  });
  return by === null ? rec : signCompanyFiling(rec, by.secret as never);
};
const ME = { id: SEAT, wrappingPublicKey: me.publicKey };
const chainHolding = (blinding: string) =>
  new Map([[made('on', VAULT), '01'], [made('policy', VAULT), made('commitment', TERMS.periodLimit, blinding)]]);

describe('A VAULT\'S SPENDING POLICY, READ AND SET ON THIS DEVICE', () => {
  it('A VAULT WITH NO POLICY MARKER IS PAID AS TODAY, AND ONE UNDER A POLICY FOR ANOTHER CURRENCY HAS NONE FOR THIS ONE', async () => {
    /* RED WHEN: a vault with no marker is read as anything but no policy - it would stop paying as it always has. */
    expect(await spendingPolicyHere(reader(new Map()), { vault: VAULT, asset: TEST_TOKEN })).toMatchObject({ state: 'none' });
    /* RED WHEN: a marked vault with no policy for this currency is read as having none - its runs could never be charged. */
    expect(await spendingPolicyHere(reader(new Map([[made('on', VAULT), '01']])), { vault: VAULT, asset: TEST_TOKEN }))
      .toMatchObject({ state: 'not-for-this-currency' });
  });

  it('A POLICY THE CONTRACT COULD NOT OPEN, OR ONE THE VAULT ALREADY HAS, IS REFUSED BEFORE ANYTHING IS FILED OR SENT', async () => {
    const filed: SealedCompanyRecord[] = [];
    const sent: string[] = [];
    const doors = {
      ...reader(new Map(), filed),
      service: new Proxy({}, { get: (_t, name) => async () => { sent.push(String(name)); throw new Error('nothing is sent here'); } }),
      material: { signingSecret: founder.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: SEAT, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: { policyBarKey: async () => made('bar') },
    } as unknown as PolicyGovernanceDoors;
    /* RED WHEN: a policy of three bands is filed and raised - the contract could never open it. */
    await expect(setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: { ...TERMS, bands: TERMS.bands.slice(0, 3) } }))
      .rejects.toThrow(/exactly 4 bands/u);
    expect([filed.length, sent]).toEqual([0, []]);
    /* The vault already holds exactly these terms, opened from its record: nothing is filed or raised for them again. */
    filed.push(versionOf(1, 'b0'.repeat(32), [ME], founder));
    const chain = new Map([[made('on', VAULT), '01'], [made('policy', VAULT), made('commitment', '100', 'b0'.repeat(32))]]);
    const again = { ...doors, records: recordsWith(chain, filed) } as PolicyGovernanceDoors;
    /* RED WHEN: the policy a vault already has is filed again under a new blinding and raised as a change. */
    await expect(setSpendingPolicyOnDevice(again, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: TERMS }))
      .rejects.toThrow(/already has exactly this spending policy/u);
    expect([filed.length, sent]).toEqual([1, []]);
  });

  it('A POLICY RAISED HERE STOPS BEFORE IT IS CARRIED OUT WHEN ASKED, AND CHECKS WHAT IT IS GIVEN BEFORE IT SENDS', async () => {
    const sent: string[] = [];
    const doors = {
      ...reader(new Map(), []),
      service: new Proxy({}, { get: (_t, name) => async () => { sent.push(String(name)); throw new Error('nothing is sent here'); } }),
      material: { signingSecret: founder.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: SEAT, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: { policyBarKey: async () => made('bar') },
    } as unknown as PolicyGovernanceDoors;
    governed.inputs.length = 0;
    const before = async (): Promise<void> => { throw new Error('the caller refuses this raise'); };
    await expect(setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: TERMS, stopBeforeCarry: true, before }))
      .rejects.toThrow(/nothing is sent here/u);
    /* RED WHEN: a raise asked to stop before the carrying out is carried out by the same call, or the caller's own check is never run before a send. */
    expect(governed.inputs).toHaveLength(1);
    expect(governed.inputs[0]).toMatchObject({ stopBeforeCarry: true });
    await expect((governed.inputs[0]!['before'] as () => Promise<void>)()).rejects.toThrow(/the caller refuses this raise/u);
  });

  it('THE APPROVALS A POLICY CHANGE NEEDS ARE NEVER NONE, AND NEVER MORE THAN THE SIGNERS SEATED', async () => {
    const asked: string[] = [];
    const doors = { builder: { policyBarKey: async () => { asked.push('bar'); return made('bar'); } } } as unknown as PolicyGovernanceDoors;
    /* RED WHEN: a policy change needing no approval is raised - anybody seated could then change a policy alone. */
    await expect(setPolicyBarOnDevice(doors, { viewingKey: VIEWING, newBar: 0, seated: 2 })).rejects.toThrow(/at least one approval/u);
    /* RED WHEN: a bar above the signers seated is raised - no policy could ever be changed again. */
    await expect(setPolicyBarOnDevice(doors, { viewingKey: VIEWING, newBar: 3, seated: 2 })).rejects.toThrow(/more approvals than the 2 signers/u);
    expect(asked).toEqual([]);
  });

  it('A VERSION IS BELIEVED ONLY WHEN A SEAT THIS DEVICE BELIEVES SIGNED ITS FILING, AND ONLY WHEN IT IS SEALED TO SEATS IN THE DIRECTORY', async () => {
    const B = 'b1'.repeat(32);
    const read = (filed: SealedCompanyRecord[]) => spendingPolicyHere(reader(chainHolding(B), filed), { vault: VAULT, asset: TEST_TOKEN });
    /* The control: the same version, signed by the founding seat and sealed to it, is the vault's policy. */
    await expect(read([versionOf(1, B, [ME], founder)])).resolves.toMatchObject({ state: 'set', version: 1 });
    /* RED WHEN: a version with no filing signature is believed - the service could write any opening it chose. */
    await expect(read([versionOf(1, B, [ME], null)])).rejects.toThrow(/None of the company's records/u);
    /* RED WHEN: a version signed by a key the directory holds no seat for is believed - the service signs one of its own. */
    await expect(read([versionOf(1, B, [ME], stranger)])).rejects.toThrow(/None of the company's records/u);
    /* RED WHEN: a version signed by a seat the chain no longer holds is believed. */
    await expect(read([versionOf(1, B, [ME], second)])).rejects.toThrow(/None of the company's records/u);
    /* RED WHEN: a version also sealed to somebody the directory holds no entry for is believed - that somebody reads the policy. */
    await expect(read([versionOf(1, B, [ME, { id: 'f0'.repeat(32), wrappingPublicKey: strangerWrap.publicKey }], founder)]))
      .rejects.toThrow(/None of the company's records/u);
    /* RED WHEN: a version filed under another company is believed as this one's. */
    const elsewhere = signCompanyFiling(sealSpendingPolicy({
      company: 'other', id: made('policy', VAULT), version: 1, keyEpoch: 0,
      secrets: { vault: VAULT, asset: TEST_TOKEN, opening: { terms: TERMS, blinding: B } }, signers: [ME] as never,
    }), founder.secret);
    await expect(read([elsewhere])).rejects.toThrow(/None of the company's records/u);
  });

  it('THE COMMITMENT OF EVERY STORED VERSION IS MADE IN ONE ASK OF THE WORKER, HOWEVER MANY ARE STORED, AND A VERSION WHOSE KEYS CANNOT BE MADE IS STILL REFUSED', async () => {
    /* The chain holds the first version's commitment, so every newer version is opened and checked before it. */
    const asks = { one: 0, each: 0 };
    const readOf = (stored: number, refuse: string | null = null) => {
      const filed = Array.from({ length: stored }, (_, i) => versionOf(i + 1, `${(0xb1 + i).toString(16)}`.repeat(32), [ME], founder));
      const doors = reader(chainHolding('b1'.repeat(32)), filed);
      const policies = doors.records.spendingPolicies!;
      const keysOfEach = async (pairs: Parameters<typeof policies.keys>[0][]) => {
        asks.each += 1;
        return pairs.map((p): PromiseSettledResult<ReturnType<typeof keysOf>> => (p.policy?.blinding === refuse
          ? { status: 'rejected', reason: new Error('the worker could not make these keys') } : { status: 'fulfilled', value: keysOf(p as never) }));
      };
      const counted = { ...policies, keys: async (i: Parameters<typeof policies.keys>[0]) => { asks.one += 1; return policies.keys(i); }, keysOfEach };
      return spendingPolicyHere({ ...doors, records: { ...doors.records, spendingPolicies: counted as never } }, { vault: VAULT, asset: TEST_TOKEN });
    };
    for (const stored of [2, 4]) {
      asks.one = 0;
      asks.each = 0;
      /* RED WHEN: each stored version's commitment is asked of the worker on its own, so a policy changed more often is read with more asks. */
      await expect(readOf(stored)).resolves.toMatchObject({ state: 'set', version: 1 });
      expect(asks).toEqual({ one: 1, each: 1 });
    }
    /* RED WHEN: a newer version whose keys the worker could not make is passed over, and an older one is read as the policy. */
    await expect(readOf(4, 'b3'.repeat(32))).rejects.toThrow(/could not make these keys/u);
  });

  it('EVERY CHECK OF A CHANGE TO A POLICY MAKES THE COMMITMENTS OF ITS STORED VERSIONS IN ONE ASK OF THE WORKER, HOWEVER MANY ARE STORED', async () => {
    /* Every stored version has the same terms and the chain holds the first one's commitment, so each newer one is checked before it. */
    const FIRST = made('commitment', TERMS.periodLimit, 'b1'.repeat(32));
    const asks = { one: 0, each: 0 };
    const countedAt = (stored: number) => {
      asks.one = 0;
      asks.each = 0;
      const filed = Array.from({ length: stored }, (_, i) => versionOf(i + 1, `${(0xb1 + i).toString(16)}`.repeat(32), [ME], founder));
      const doors = reader(chainHolding('b1'.repeat(32)), filed);
      const policies = doors.records.spendingPolicies!;
      const keysOfEach = async (pairs: Parameters<typeof policies.keys>[0][]) => {
        asks.each += 1;
        return pairs.map((p): PromiseSettledResult<ReturnType<typeof keysOf>> => ({ status: 'fulfilled', value: keysOf(p as never) }));
      };
      const keys = async (i: Parameters<typeof policies.keys>[0]) => { asks.one += 1; return policies.keys(i); };
      return {
        ...doors, records: { ...doors.records, spendingPolicies: { ...policies, keys, keysOfEach } as never },
        service: new Proxy({}, { get: () => async () => { throw new Error('nothing is sent here'); } }),
        material: { signingSecret: founder.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
        filing: { seat: SEAT, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
        approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
        builder: { policyBarKey: async () => made('bar') },
      } as unknown as PolicyGovernanceDoors & ReturnType<typeof reader>;
    };
    const asset = assetIdHex(TEST_TOKEN) as Hex;
    const keys = keysOf({ vault: VAULT, asset, assetBlinding: '' }) as never;
    round.opened = { chainId: 'CC'.repeat(32), governance: { kind: 'spending-policy', vault: VAULT, assetKey: made('asset', TEST_TOKEN), commitment: FIRST } };
    try {
      for (const stored of [2, 4]) {
        /* RED WHEN: checking the policy in force and the one a proposal sets asks the worker for each stored version's commitment on its own. */
        await expect(refusePolicyChangeHere(countedAt(stored), VAULT, asset, keys, { commitment: FIRST })).resolves.toBeUndefined();
        expect(asks).toEqual({ one: 0, each: 1 });
        /* RED WHEN: a raise asks for each stored version's commitment on its own, in its check of the policy in force or of the terms it raises. */
        await expect(setSpendingPolicyOnDevice(countedAt(stored), { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: TERMS }))
          .rejects.toThrow(/already has exactly this spending policy/u);
        expect(asks).toEqual({ one: 1, each: 2 });
        /* RED WHEN: reading the policy a proposal sets asks for each stored version's commitment on its own. */
        await expect(policyReadHere(countedAt(stored), withCompanyKeys({ proposal: 'p1', vault: VAULT, among: [TEST_TOKEN] }, VIEWING)))
          .resolves.toMatchObject({ commitment: FIRST, opening: { terms: TERMS, blinding: 'b1'.repeat(32) } });
        expect(asks).toEqual({ one: 1, each: 1 });
      }
    } finally {
      round.opened = null;
    }
  });

  it('A FILED VERSION IS REUSED FOR A CHANGE ONLY WHEN THIS DEVICE BELIEVES IT AND IT IS SEALED TO EXACTLY THE SEATS BELIEVED NOW; A NEW ONE IS SEALED TO THOSE SEATS', async () => {
    const sent: string[] = [];
    const govern = (chain: Map<string, string>, filed: SealedCompanyRecord[], secondSeated = false) => ({
      ...reader(chain, filed, secondSeated),
      service: new Proxy({}, { get: (_t, name) => async () => { sent.push(String(name)); throw new Error('nothing is sent here'); } }),
      material: { signingSecret: founder.secret, blinding: '00'.repeat(32), scope: '00'.repeat(32) },
      filing: { seat: SEAT, keyEpoch: 0, salt: () => '11'.repeat(32), newId: () => 'p1' },
      approvers: async () => { throw new Error('not read here'); }, vaultName: () => 'the vault',
      builder: { policyBarKey: async () => made('bar') },
    } as unknown as PolicyGovernanceDoors);
    const NEW_TERMS = { ...TERMS, periodLimit: '90' };
    /* Each call goes on past the filing to the service, which this file refuses: that is where it stops, every time. */
    const set = async (doors: PolicyGovernanceDoors) => {
      const before = sent.length;
      await expect(setSpendingPolicyOnDevice(doors, { viewingKey: VIEWING, vault: VAULT, asset: TEST_TOKEN, terms: NEW_TERMS }))
        .rejects.toThrow(/nothing is sent here/u);
      expect(sent.length).toBeGreaterThan(before);
    };
    const opened = (rec: SealedCompanyRecord) => openSpendingPolicy(rec, { signerId: SEAT, wrappingSecret: me.secret as never }).secrets.opening;

    /* A version with exactly the new terms, believed and sealed to the one seat believed now: reused, nothing new is filed. */
    const believed = versionOf(1, 'c1'.repeat(32), [ME], founder, NEW_TERMS);
    const filed1 = [believed];
    await set(govern(new Map(), filed1));
    /* RED WHEN: a believed version for exactly these terms is not reused, so approving devices each file and raise their own. */
    expect(filed1).toHaveLength(1);

    /* The same terms in a version nobody this device believes signed: never reused for its terms alone. */
    const forged = versionOf(1, 'c2'.repeat(32), [ME], stranger, NEW_TERMS);
    const filed2 = [forged];
    await set(govern(new Map(), filed2));
    /* RED WHEN: a version is reused by its terms alone - its blinding is the service's, which then opens every period total. */
    expect(filed2).toHaveLength(2);
    expect(opened(filed2[1]!).blinding).not.toBe('c2'.repeat(32));
    expect(filed2[1]!.version).toBe(2);

    /* A believed version sealed to the founding seat alone, after a second seat is seated: a new version, sealed to both. */
    const filed3 = [versionOf(1, 'c3'.repeat(32), [ME], founder, NEW_TERMS)];
    await set(govern(new Map(), filed3, true));
    /* RED WHEN: a version that a seat believed now cannot open is reused - that signer could never pay under the policy. */
    expect(filed3).toHaveLength(2);
    /* RED WHEN: a new version is sealed to anybody but the seats this device believes now, each under its own seat. */
    expect(filed3[1]!.wrapped.map((w) => w.signerId).sort()).toEqual([SEAT, SECOND]);
    expect(opened(filed3[1]!).blinding).not.toBe('c3'.repeat(32));
  });

  /*
   * RED WHEN: the policy a proposal sets is read from anything but the version of its record this device believes and
   * opens with its own seat's key; its currency is taken on anybody's word rather than found by the key the proposal
   * commits to; a proposal whose policy opens from no believed version, or names a currency this device does not know,
   * is read at all; or terms a page names are approved when they are not the ones the proposal opens to.
   */
  it('THE POLICY A PROPOSAL SETS IS READ HERE, ITS CURRENCY FOUND BY ITS KEY AND ITS TERMS OPENED FROM A BELIEVED VERSION', async () => {
    const B = 'b3'.repeat(32);
    const OTHER = '00'.repeat(32);
    const doorsFor = (filed: SealedCompanyRecord[]) => ({ ...reader(new Map(), filed), service: {}, filing: { keyEpoch: 0 } }) as unknown as PolicyGovernanceDoors;
    const doors = doorsFor([versionOf(1, B, [ME], founder)]);
    round.opened = {
      chainId: 'CC'.repeat(32),
      governance: { kind: 'spending-policy', vault: VAULT, assetKey: made('asset', TEST_TOKEN), commitment: made('commitment', TERMS.periodLimit, B) },
    };
    try {
      const read = await policyReadHere(doors, withCompanyKeys({ proposal: 'p1', vault: VAULT, among: [OTHER, TEST_TOKEN] }, VIEWING));
      expect(read).toEqual({ chainId: 'cc'.repeat(32), commitment: made('commitment', TERMS.periodLimit, B), asset: TEST_TOKEN, opening: { terms: TERMS, blinding: B } });
      /* RED WHEN: a currency this device does not know, or one the proposal is not for, is taken as the policy's. */
      await expect(policyReadHere(doors, withCompanyKeys({ proposal: 'p1', vault: VAULT, among: [OTHER] }, VIEWING))).rejects.toThrow(/in a currency this device knows/u);
      /* RED WHEN: a proposal on another vault than the one named is read. */
      await expect(policyReadHere(doors, withCompanyKeys({ proposal: 'p1', vault: 'fb'.repeat(32), among: [TEST_TOKEN] }, VIEWING))).rejects.toThrow(/does not set a spending policy/u);
      /* RED WHEN: a policy is read from a version nobody this device believes signed. */
      await expect(policyReadHere(doorsFor([versionOf(1, B, [ME], stranger)]), withCompanyKeys({ proposal: 'p1', vault: VAULT, among: [TEST_TOKEN] }, VIEWING)))
        .rejects.toThrow(/None of the company's records/u);
      /* The terms a page names are still held to the ones the proposal opens to. */
      await expect(policyProposedHere(doors, withCompanyKeys({ proposal: 'p1', vault: VAULT, asset: TEST_TOKEN, terms: TERMS }, VIEWING))).resolves.toMatchObject({ opening: { terms: TERMS } });
      await expect(policyProposedHere(doors, withCompanyKeys({ proposal: 'p1', vault: VAULT, asset: TEST_TOKEN, terms: { ...TERMS, periodLimit: '90' } }, VIEWING)))
        .rejects.toThrow(/not the one shown/u);
    } finally {
      round.opened = null;
    }
  });

  it('WHAT THE CHAIN HOLDS IS TAKEN FROM THE WALLET ONLY WHEN IT ANSWERS EVERY KEY ASKED, IN THE ORDER ASKED', async () => {
    const A = 'a1'.repeat(32);
    const B = 'b2'.repeat(32);
    const asked: string[][] = [];
    const read = chainReadThroughTheWallet(async (roles) => {
      asked.push([...roles]);
      return { roles: roles.map((key) => ({ key, value: key === A ? 'cc'.repeat(32) : null })) };
    });
    /* RED WHEN: the wallet is asked in another case or twice for one key, or its answer is not taken as read. */
    expect(await read([A.toUpperCase(), B, A])).toEqual(new Map([[A, 'cc'.repeat(32)], [B, null]]));
    expect(asked).toEqual([[A, B]]);
    /* RED WHEN: an answer that leaves out a key asked, or answers another, is taken - a marker could be read as absent. */
    const short = chainReadThroughTheWallet(async (roles) => ({ roles: roles.slice(1).map((key) => ({ key, value: null })) }));
    await expect(short([A, B])).rejects.toThrow(/did not say what the company's account holds/u);
    const other = chainReadThroughTheWallet(async (roles) => ({ roles: roles.map((_k, i) => ({ key: i === 0 ? B : A, value: null })) }));
    await expect(other([A, B])).rejects.toThrow(/did not say what the company's account holds/u);
    const none = chainReadThroughTheWallet(async () => ({}));
    await expect(none([A])).rejects.toThrow(/did not say what the company's account holds/u);
    /* RED WHEN: a key that is not thirty-two bytes is put to the wallet. */
    await expect(read(['zz'])).rejects.toThrow(/not thirty-two bytes/u);
    /* RED WHEN: more keys are put to the wallet at once than its parser takes, and the person is told the wallet failed rather than why. */
    const many = Array.from({ length: MOST_ROLES_ASKED + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    const before = asked.length;
    await expect(read(many)).rejects.toThrow(new RegExp(`at most ${MOST_ROLES_ASKED} of the account's entries`, 'u'));
    expect(asked.length).toBe(before);
    await expect(read(many.slice(1))).resolves.toHaveProperty('size', MOST_ROLES_ASKED);
  });
});

describe('EVERY VAULT AND CURRENCY A PAGE SHOWS, READ TOGETHER', () => {
  const MARKED = 'fb'.repeat(32);
  const UNOPENED = 'fc'.repeat(32);
  const PLAIN = 'fd'.repeat(32);
  const REFUSED = 'fe'.repeat(32);
  const B = 'b1'.repeat(32);
  /* The worker's one ask for every pair, stood in for with the same keys as the one-pair ask; a pair of REFUSED is refused. */
  const keysAsked: unknown[] = [];
  const keysOfEach = async (pairs: readonly Parameters<typeof keysOf>[0][]): Promise<readonly PromiseSettledResult<ReturnType<typeof keysOf>>[]> => {
    keysAsked.push(pairs);
    return pairs.map((p) => (p.vault === REFUSED ? { status: 'rejected', reason: new Error('no keys for this vault') } : { status: 'fulfilled', value: keysOf(p) }));
  };
  const countingReads = (chain: Map<string, string>, filed: SealedCompanyRecord[]) => {
    const doors = reader(chain, filed);
    const asked: string[][] = [];
    const policies = doors.records.spendingPolicies!;
    const onChain = async (keys: readonly string[]) => { asked.push([...keys]); return policies.onChain(keys); };
    return { doors: { ...doors, records: { ...doors.records, spendingPolicies: { ...policies, onChain } } }, asked };
  };

  it('EACH PAIR STANDS AS IT DOES READ ALONE, WITH THE KEYS ASKED ONCE AND THE CHAIN READ ONCE, AND ONE PAIR\'S FAILURE IS ITS OWN', async () => {
    const chain = new Map([...chainHolding(B), [made('on', MARKED), '01'], [made('on', UNOPENED), '01'], [made('policy', UNOPENED), made('commitment', '1', B)]]);
    const filed = [versionOf(1, B, [ME], founder)];
    const { doors, asked } = countingReads(chain, filed);
    keysAsked.length = 0;
    const pairs: PolicyPair[] = [VAULT, MARKED, UNOPENED, PLAIN, REFUSED].map((vault) => ({ vault: vault.toUpperCase(), asset: TEST_TOKEN }));
    const read = await spendingPoliciesHere(doors, pairs, keysOfEach);
    /* RED WHEN: the pairs' keys are asked of the worker one pair at a time, or the chain is read once for each pair. */
    expect(keysAsked).toHaveLength(1);
    expect(asked).toHaveLength(1);
    /* RED WHEN: a pair read together stands otherwise than it does read alone: a set policy, none, or another currency's. */
    for (const [i, vault] of [VAULT, MARKED, PLAIN].map((v) => [[VAULT, MARKED, UNOPENED, PLAIN].indexOf(v), v] as const)) {
      expect(read[i]).toEqual({ status: 'fulfilled', value: await spendingPolicyHere(reader(chain, filed), { vault, asset: TEST_TOKEN }) });
    }
    expect(read.map((r) => (r.status === 'fulfilled' ? r.value.state : 'unread'))).toEqual(['set', 'not-for-this-currency', 'unread', 'none', 'unread']);
    /* RED WHEN: a pair whose policy cannot be opened, or whose keys could not be made, is shown as none, or takes another pair down with it. */
    await expect(spendingPolicyHere(reader(chain, filed), { vault: UNOPENED, asset: TEST_TOKEN })).rejects.toThrow();
    expect(read[4]).toMatchObject({ status: 'rejected', reason: { message: 'no keys for this vault' } });
  });

  it('THE CHAIN IS READ IN PARTS NO LARGER THAN THE WALLET TAKES, AND A PART THAT FAILS IS ASKED KEY BY KEY, SO ONLY THE PAIR WHOSE OWN KEY FAILS IS UNREAD', async () => {
    const vaults = Array.from({ length: MOST_ROLES_ASKED }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
    const { doors, asked } = countingReads(new Map(), []);
    const read = await spendingPoliciesHere(doors, vaults.map((vault) => ({ vault, asset: TEST_TOKEN })), keysOfEach);
    /* RED WHEN: more keys are put to the wallet at once than it takes, or the keys are read again for each pair. */
    expect(asked.map((a) => a.length)).toEqual([MOST_ROLES_ASKED, MOST_ROLES_ASKED]);
    expect(read.every((r) => r.status === 'fulfilled' && r.value.state === 'none')).toBe(true);
    const failing = { ...doors, records: { ...doors.records, spendingPolicies: { ...doors.records.spendingPolicies, onChain: async (keys: readonly string[]) => {
      if (keys.includes(made('on', vaults[0]!))) throw new Error('the wallet did not answer');
      return new Map(keys.map((k) => [k, null]));
    } } } };
    const partly = await spendingPoliciesHere(failing, vaults.map((vault) => ({ vault, asset: TEST_TOKEN })), keysOfEach);
    expect(partly[0]).toMatchObject({ status: 'rejected', reason: { message: 'the wallet did not answer' } });
    /* RED WHEN: a part that fails leaves every pair in it unread, rather than asking each of its keys alone. */
    expect(partly.slice(1).every((r) => r.status === 'fulfilled' && r.value.state === 'none')).toBe(true);
  });

  it('THE WORKER MAKES EVERY PAIR\'S KEYS IN ONE ANSWER, EACH THE SAME AS ASKED ALONE, AND REFUSES A PAIR WITHOUT REFUSING ANOTHER', async () => {
    const d = { accountPure: pureCircuits } as never;
    const asset = assetIdHex(TEST_TOKEN);
    const pairs = [
      { vault: VAULT, asset, assetBlinding: 'ab'.repeat(32) },
      { vault: 'not a vault', asset, assetBlinding: 'ab'.repeat(32) },
      { vault: 'fb'.repeat(32), asset, assetBlinding: 'ab'.repeat(32), policy: { terms: TERMS, blinding: B }, total: '15' },
    ];
    const answer = await accountReadsAnswered(d, null as never, { id: 7, network: 'undeployed', ask: 'spending-policy-keys', pairs });
    /* RED WHEN: the keys made for many pairs at once differ in any byte from the keys made for each pair alone. */
    expect(answer).toEqual({
      id: 7, ok: true, ask: 'spending-policy-keys',
      keys: [{ keys: spendingPolicyKeysOf(d, pairs[0]!) }, { refused: expect.any(String) }, { keys: spendingPolicyKeysOf(d, pairs[2]!) }],
    });
    expect(() => spendingPolicyKeysOf(d, pairs[1]!)).toThrow();
  });
});
