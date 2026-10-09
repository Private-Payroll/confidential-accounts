/**
 * Where a vault stands for one currency as a device reads it, and what setting
 * a policy refuses before anything is filed or sent, and which versions of the
 * policy's record a device believes. Two stand-ins, named: the contract's keys
 * and commitment are a function of their inputs written here (the real ones
 * are driven in `contracts/test/a-spending-policy-is-set-from-a-device.test.ts`),
 * and what the chain holds is a map this file keeps. The directory is one this
 * file writes, judged by the device's own rules (`judgeIn`, `readersIn`).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonical, newSigningKeypair, newWrappingKeypair, seal } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { TEST_TOKEN } from '../../../src/testing/assets.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import { openSpendingPolicy, sealSpendingPolicy } from '../../../src/midnight/spending-policy-record.js';
import { MOST_ROLES_ASKED } from 'midnight-identity/profile/request';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import {
  chainReadThroughTheWallet, setPolicyBarOnDevice, setSpendingPolicyOnDevice, spendingPolicyHere, type PolicyGovernanceDoors,
} from './spending-policy-here.js';

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
    directory: async () => ({
      dir: { company: COMPANY, version: 1, seats },
      holders: { committee: [COMMITTEE, COMMITTEE2], seats: onChain, approvals: 1, adoptedVaults: [VAULT], founding: SEAT, foundingCommittee: [COMMITTEE], account: 'ac'.repeat(32) },
      another: new Set(),
    }) as never,
    people: notHere as never, runs: notHere as never, policy: notHere as never,
    state: async (id) => (id === '0' ? state : null),
    payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: notHere as never },
    spendingPolicies: {
      versions: async (id) => filed.filter((r) => r.id === id),
      /* The store files a version signed by this device's seat. */
      file: async (rec) => { filed.push(signCompanyFiling(rec, founder.secret)); },
      me: { signerId: SEAT, wrappingSecret: me.secret },
      keys: async (i) => keysOf(i),
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
    /* The control: the same version, signed by the founder's seat and sealed to it, is the vault's policy. */
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

    /* A believed version sealed to the founder alone, after a second seat is seated: a new version, sealed to both. */
    const filed3 = [versionOf(1, 'c3'.repeat(32), [ME], founder, NEW_TERMS)];
    await set(govern(new Map(), filed3, true));
    /* RED WHEN: a version that a seat believed now cannot open is reused - that signer could never pay under the policy. */
    expect(filed3).toHaveLength(2);
    /* RED WHEN: a new version is sealed to anybody but the seats this device believes now, each under its own seat. */
    expect(filed3[1]!.wrapped.map((w) => w.signerId).sort()).toEqual([SEAT, SECOND]);
    expect(opened(filed3[1]!).blinding).not.toBe('c3'.repeat(32));
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
