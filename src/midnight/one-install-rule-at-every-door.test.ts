import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { REQUEST_SCHEMA, committeeInstallRefusals, parseAsk } from 'midnight-identity/profile/request';
import { authorityValueRefusals } from './authority-replacement.js';
import { heldStateFromTheStart } from './held-from-the-start.js';
import { contractsOwingAChange } from './committee-change.js';
import type { AuthorityRead, OnChainAuthority } from './ledger.js';
import type { Committee } from './vault-committee.js';
import { refusalForCommitteeChange, refusalForHandover } from '../wiring/vault-submission.js';
import { committeeChangeRefusal } from 'vaults-web-shared/committee-change-on-device.js';

/*
 * ONE RULE FOR WHICH COMMITTEE MAY BE INSTALLED ON A CONTRACT, ASKED BY EVERY
 * DOOR: the wallet before it signs, the device before it asks the wallet, and
 * the service before it builds or pays for one. The same committees are fed
 * to each door, and each must answer as the rule does: several keys at a
 * threshold of one are installed everywhere; a key listed twice, a threshold
 * of zero, a threshold above the keys, and a key no wallet derives - another
 * kind, a length the chain does not build, or no point on the curve - are
 * refused everywhere.
 */
/** A wallet's committee key: the x-only public key of a secret made of one repeated byte. */
const walletKey = (n: number): string => Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex');
const K1 = walletKey(1);
const K2 = walletKey(2);
const K9 = walletKey(9);
/** A wallet key whose first byte is zero. */
const LEADING_ZERO = walletKey(218);
/** Thirty-two bytes that name no point on the curve, which the chain refuses to build an authority with. */
const OFF_THE_CURVE = 'ff'.repeat(32);
const VAULT = 'ab'.repeat(32);
const ACCOUNT = 'c0'.repeat(32);
const LABEL = `co_${'c1'.repeat(32)}`;
const key = (value: string, tag = 'schnorr') => ({ tag, value });

interface Case { readonly name: string; readonly to: Committee; readonly installable: boolean }
const CASES: readonly Case[] = [
  { name: 'two keys at two', to: { committee: [key(K1), key(K2)], threshold: 2 }, installable: true },
  { name: 'several keys at a threshold of one', to: { committee: [key(K1), key(K2)], threshold: 1 }, installable: true },
  { name: 'one key at one', to: { committee: [key(K1)], threshold: 1 }, installable: true },
  { name: 'a key listed twice', to: { committee: [key(K1), key(K1)], threshold: 2 }, installable: false },
  { name: 'a key listed twice in other case', to: { committee: [key(K1), key(K1.toUpperCase())], threshold: 1 }, installable: false },
  { name: 'a threshold of zero', to: { committee: [key(K1), key(K2)], threshold: 0 }, installable: false },
  { name: 'a threshold above the keys', to: { committee: [key(K1), key(K2)], threshold: 3 }, installable: false },
  { name: 'a key of a kind the chain does not hold', to: { committee: [key(K1, 'eddsa'), key(K2)], threshold: 1 }, installable: false },
  { name: 'an ecdsa key, which no wallet derives', to: { committee: [key(`02${K1}`, 'ecdsa'), key(K2)], threshold: 1 }, installable: false },
  /* Both name a point on the curve read as a number - a key whose first byte is zero, without it and with another - so only their length refuses them. */
  { name: 'a schnorr key of thirty-one bytes', to: { committee: [key(LEADING_ZERO.slice(2)), key(K2)], threshold: 1 }, installable: false },
  { name: 'a schnorr key of thirty-three bytes', to: { committee: [key(`00${K1}`), key(K2)], threshold: 1 }, installable: false },
  { name: 'a schnorr key that names no point on the curve', to: { committee: [key(OFF_THE_CURVE), key(K2)], threshold: 1 }, installable: false },
];

const held = (committee: readonly { tag: string; value: string }[], threshold: number, counter: bigint): OnChainAuthority => ({
  committee: committee.map((k) => ({ ...k })), threshold, counter,
  shape: committee.length === 1 && threshold === 1 ? 'one-key' : 'committee', hasDuplicateMembers: false,
} as OnChainAuthority);
const read = (address: string, a: OnChainAuthority): AuthorityRead => ({ state: 'read', address, authority: a } as AuthorityRead);

/* A change of who holds `address`, as the service reads a stranger's transaction: one update, nothing else. */
const changeTx = (address: string, to: Committee, counter: bigint) => ({
  intents: new Map([[1, { actions: [{
    address, counter, signatures: [[0n, key(K9)]],
    updates: [{ authority: { committee: to.committee.map((k) => ({ ...k })), threshold: to.threshold, counter: counter + 1n } }],
  }] }]]),
});

/* What each door answers, true when it would install (sign, build, pay for or fund) the committee. */
const doors: Record<string, (c: Case) => boolean | Promise<boolean>> = {
  'the one rule': (c) => committeeInstallRefusals(c.to.committee, c.to.threshold).length === 0,
  'the wallet, before it signs': (c) => {
    try {
      parseAsk({
        schema: REQUEST_SCHEMA, kind: 'committee', requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'p',
        nonce: 'n', expiresAt: 2_000, company: LABEL, account: ACCOUNT, to: c.to,
        contracts: [{ contract: 'vault', address: VAULT, counter: '4', now: { committee: [key(K1)], threshold: 1 } }],
      }, 'https://payroll.example', 1_000);
      return true;
    } catch { return false; }
  },
  'the authority builder': (c) => authorityValueRefusals(c.to.committee, c.to.threshold, { emptyCommitteeIsDeliberate: false }).length === 0,
  /* The one door every contract born held is built through: past the holders it needs a ledger, so any other failure means it built on. */
  'a contract built held from its first transaction': async (c) => {
    try {
      await heldStateFromTheStart({ ledger: undefined, runtimeState: undefined, contracts: undefined as never },
        { compiled: null, zkConfig: null, args: [], circuits: [], holders: c.to });
      return true;
    } catch (e) { return !/this maintenance authority will not be built/u.test(String(e)); }
  },
  'the service, paying for a committee change': (c) => refusalForCommitteeChange(changeTx(VAULT, c.to, 4n), {
    address: VAULT, to: c.to, onChain: held([key(K9)], 1, 4n), contract: 'vault',
  }) === null,
  'the service, paying for a handover': (c) => refusalForHandover(changeTx(VAULT, c.to, 0n), {
    vault: VAULT, to: c.to, onChain: held([key(K9)], 1, 0n), contract: 'vault',
  }) === null,
  'the service, listing the contracts owed a change': (c) =>
    contractsOwingAChange([{ contract: 'vault', read: read(VAULT, held([key(K9)], 1, 4n)), bornHeld: true }], c.to).owed.length === 1,
  'the device, before it asks the wallet': (c) => {
    /* The one asking is a super admin: their key is on the committee the account holds, which is the one to install. */
    const account = { committee: [...c.to.committee, key(K1)], threshold: c.to.threshold };
    return committeeChangeRefusal({
      company: ACCOUNT, label: LABEL, to: { committee: [...c.to.committee], threshold: c.to.threshold }, why: null, notChangeable: [],
      contracts: [{ contract: 'vault', address: VAULT, counter: '4', now: { committee: [key(K1)], threshold: 1 }, signedIndexes: [], required: 1 }],
    }, key(K1), { account, inProgress: { ...c.to, contracts: [] } }) === null;
  },
};

describe('ONE RULE FOR WHICH COMMITTEE MAY BE INSTALLED, AND EVERY DOOR ASKS IT', () => {
  for (const c of CASES) {
    it(`${c.installable ? 'installs' : 'refuses'} ${c.name} at every door`, async () => {
      /* RED WHEN: any door answers otherwise than the rule does: a wallet signs, a device asks, or the service builds,
       * pays for or funds a committee another door refuses, or refuses several keys at a threshold of one. */
      const said = await Promise.all(Object.entries(doors).map(async ([door, ask]) => [door, await ask(c)] as const));
      const wrong = said.filter(([, installs]) => installs !== c.installable).map(([door]) => door);
      expect(wrong, `the doors that answer otherwise than ${c.installable ? 'installs' : 'refuses'}`).toEqual([]);
    });
  }

  it('refuses with a sentence naming the fix, never a thrown error, when a key is not a pair of strings', () => {
    const malformed = { committee: [{ tag: 'schnorr', value: 7 }, key(K2)], threshold: 1 } as unknown as Committee;
    /* RED WHEN: a key whose digits are not a string throws out of the service's door instead of being refused by name. */
    expect(refusalForCommitteeChange(changeTx(VAULT, malformed, 4n), {
      address: VAULT, to: malformed, onChain: held([key(K9)], 1, 4n), contract: 'vault',
    })).toMatch(/is not hex digits.*Nothing was sent/);
    expect(refusalForHandover(changeTx(VAULT, malformed, 0n), {
      vault: VAULT, to: malformed, onChain: held([key(K9)], 1, 0n), contract: 'vault',
    })).toMatch(/is not hex digits.*Nothing was sent/);
    /* RED WHEN: the rule throws on what it is handed rather than naming what is wrong and what resolves it. */
    expect(committeeInstallRefusals(malformed.committee, malformed.threshold).map((r) => r.why))
      .toEqual([expect.stringMatching(/^key 1 is not a schnorr key a wallet derives.*Name it by the key its holder's wallet gives\.$/)]);
    expect(committeeInstallRefusals('not a list', 1).map((r) => r.code)).toEqual(['malformed-committee-key', 'committee-emptied', 'threshold-above-committee']);
  });
});
