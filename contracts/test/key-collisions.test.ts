/**
 * EVERY KEY WRITTEN INTO THE ACCOUNT'S TWO SHARED MAPS, AND WHY NONE COLLIDE.
 *
 * `signerRoles` holds the company's label, the commitment to the pay-record key
 * and each signer's sealed copy of it, each vault's spending policy per token,
 * the marker that a vault is under a policy, each period's running total, and
 * the record that a run's tree was charged in a period; one key is reserved for
 * a later anchor entry. `proposalHolds` holds each open proposal's hold and, under one fixed key,
 * the account's removal count. In a shared map every writer is a boundary: a key
 * two derivations could both produce would let one writer overwrite the other's
 * entry.
 *
 * So this file does three things. It lists every insert into either map, read off
 * the contract, and refuses a new one it does not know. It reads each derivation's
 * domain tag off the contract and proves the tags are distinct and that every
 * derivation hashes its tag FIRST, so two derivations can only meet by a hash
 * collision. And it computes the keys for real inputs and proves they differ.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pureCircuits } from '../managed/contract/index.js';

const SRC = readFileSync(join(import.meta.dirname, '..', 'src', 'ConfidentialAccount.compact'), 'utf8');
const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The body of one exported pure circuit, from its signature to the next top-level `}`. */
const bodyOf = (name: string): string => {
  const at = SRC.indexOf(`export circuit ${name}(`);
  if (at < 0) throw new Error(`the contract has no circuit ${name}`);
  return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
};
/** The domain tag a derivation hashes, as the contract spells it. */
const tagOf = (name: string): string => {
  const m = bodyOf(name).match(/pad\(32, "([^"]+)"\)/);
  if (!m) throw new Error(`${name} hashes no tag`);
  return m[1]!;
};

/* Every key expression the contract inserts under, per map. Read off the source below, never assumed. */
const SIGNER_ROLES_WRITES = [
  'companyLabelKey()',
  'payKeyCommitmentKey()',
  'first',
  'disclose(payKeyWrapKeyOf(account, sk, 1))',
  'disclose(payKeyWrapKeyOf(account, sk, 2))',
  'disclose(payKeyWrapKeyOf(account, sk, 3))',
  'disclose(policyKeyOf(forVault, assetKey))',
  'disclose(policyOnKeyOf(forVault))',
  'periodKey',
  'charged',
];
/* `propose` writes each proposal's hold; `holdRun` and `releaseHold` rewrite a run's, under the same id. */
const PROPOSAL_HOLDS_WRITES = ['removalCountKey()', 'removalCountKey()', 'id', 'id', 'id', 'id'];

/** The first argument of every `<map>.insert(`, read to the comma at its own depth. */
const insertsInto = (map: string): string[] => {
  const out: string[] = [];
  let at = SRC.indexOf(`${map}.insert(`);
  while (at >= 0) {
    let i = at + map.length + '.insert('.length;
    let depth = 0;
    const start = i;
    for (; i < SRC.length; i++) {
      const ch = SRC[i];
      if (ch === '(' || ch === '[' || ch === '<') depth++;
      else if (ch === ')' || ch === ']' || ch === '>') depth--;
      else if (ch === ',' && depth === 0) break;
    }
    out.push(SRC.slice(start, i).trim());
    at = SRC.indexOf(`${map}.insert(`, i);
  }
  return out;
};

describe('every insert into the two shared maps is one this file knows', () => {
  it("signerRoles: the label, the pay-record key's commitment and four parts of each signer's copy, and nothing else", () => {
    /* RED WHEN a new writer of signerRoles appears: it must be listed here, and its key checked below. */
    expect(insertsInto('signerRoles')).toEqual(SIGNER_ROLES_WRITES);
    /* `first` is the copy's first part, derived the same way as the other three. */
    expect(SRC).toContain('const first = disclose(payKeyWrapKeyOf(account, sk, 0));');
  });

  it("the policy's writers derive every key in the circuit, from the vault, the token and the period, never from a caller", () => {
    /* RED WHEN setPolicy's token key is taken from anything but the device's own asset and blinding. */
    expect(SRC).toContain('const assetKey = assetKeyOf(assetId(), assetBlinding());');
    /* RED WHEN clearRun's keys are read from an argument rather than derived. */
    expect(SRC).toContain('const policyKey = disclose(policyKeyOf(forVault, assetKeyOf(asset, assetBlinding())));');
    expect(SRC).toContain('const periodKey = disclose(periodKeyOf(policyKey, commitment, disclose(period)));');
    expect(SRC).toContain('const charged = disclose(chargedKeyOf(periodKey, forRoot));');
  });

  it('proposalHolds: the removal count under its fixed key, twice, and each proposal under its id', () => {
    /* RED WHEN a new writer of proposalHolds appears. */
    expect(insertsInto('proposalHolds')).toEqual(PROPOSAL_HOLDS_WRITES);
    /* The id `propose` writes under is the commitment `proposalIdOf` computes, nothing a caller hands in. */
    expect(SRC).toContain('const id = disclose(proposalIdOf(payload, disclose(vault), salt));');
    /* RED WHEN a hold or its release writes under a key that is not an open run's own id, read from the ledger first. */
    expect(bodyOf('holdRun')).toContain('const hold = holdOf(id);');
    expect(bodyOf('releaseHold')).toContain('const hold = holdOf(id);');
  });

  it('approvals: an approval and an agreement to release a hold are nullifiers under different tags', () => {
    const tag = (name: string) => {
      const at = SRC.indexOf(`circuit ${name}(`);
      return SRC.slice(at, SRC.indexOf('\n}\n', at)).match(/pad\(32, "([^"]+)"\)/)![1];
    };
    /* RED WHEN the two share a tag: one signer's approval of a run would then count as their release of its hold, or the reverse. */
    expect(tag('releaseNullifier')).not.toBe(tag('approvalNullifier'));
    /* And both are written the same way: a nullifier computed in the circuit, never a caller's value. */
    expect(SRC.match(/approvals\.insert\(/g)).toHaveLength(2);
    expect(SRC.match(/approvals\.insert\(nul\);/g)).toHaveLength(2);
  });
});

describe('the derivations are separated by their tags', () => {
  const DERIVATIONS = [
    'companyLabelKey', 'payKeyCommitmentKey', 'payKeyWrapKeyOf', 'anchorKey',
    'removalCountKey', 'proposalIdOf',
    'policyKeyOf', 'policyOnKeyOf', 'periodKeyOf', 'chargedKeyOf',
  ];

  it("every derivation has its own tag, and the anchor's is reserved as ruled", () => {
    const tags = DERIVATIONS.map(tagOf);
    /* RED WHEN two derivations share a tag, the anchor's above all. */
    expect(new Set(tags).size).toBe(tags.length);
    expect(tagOf('anchorKey')).toBe('midnight-accounts:roles:anchor');
    /* And no tag is another's prefix padded out: each fits 32 bytes as written. */
    for (const t of tags) expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(32);
  });

  it('the fixed keys hash their tag alone, and the derived ones hash their tag FIRST', () => {
    for (const fixed of ['companyLabelKey', 'payKeyCommitmentKey', 'anchorKey']) {
      /* RED WHEN a fixed key is derived from anything but its own tag. */
      expect(bodyOf(fixed)).toMatch(/return persistentHash<Bytes<32>>\(pad\(32, "[^"]+"\)\);/);
    }
    expect(bodyOf('payKeyWrapKeyOf')).toMatch(/persistentHash<Vector<4, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:wrap:"\), account, sk,/);
    expect(bodyOf('proposalIdOf')).toMatch(/persistentCommit<Vector<3, Bytes<32>>>\(\s*\[pad\(32, "midnight-accounts:proposal-id:"\)/);
    /* RED WHEN a policy key stops hashing its own tag first. */
    expect(bodyOf('policyKeyOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:policy:"\), vault, assetKey/);
    expect(bodyOf('policyOnKeyOf')).toMatch(/persistentHash<Vector<2, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:pol-on:"\), vault/);
    expect(bodyOf('periodKeyOf')).toMatch(/persistentHash<Vector<4, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:period:"\), policyKey, commitment,/);
    expect(bodyOf('chargedKeyOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:charged:"\), periodKey, root/);
    /* The removal count's key is the padded tag itself, which no hash is expected to produce. */
    expect(bodyOf('removalCountKey')).toMatch(/return pad\(32, "midnight-accounts:removal-count"\);/);
  });
});

describe('and computed for real inputs, every key differs', () => {
  it("in signerRoles: the label, the commitment, the anchor, and every part of every signer's copy on two accounts", () => {
    const keys = [
      pureCircuits.companyLabelKey(),
      pureCircuits.payKeyCommitmentKey(),
      pureCircuits.anchorKey(),
    ];
    for (const account of [bytes(0xa0), bytes(0xa1)]) {
      for (const sk of [bytes(1), bytes(2)]) {
        for (const part of [0n, 1n, 2n, 3n]) keys.push(pureCircuits.payKeyWrapKeyOf(account, sk, part));
      }
    }
    for (const vault of [bytes(0xb0), bytes(0xb1)]) {
      keys.push(pureCircuits.policyOnKeyOf(vault));
      for (const assetKey of [bytes(0xc0), bytes(0xc1)]) {
        const policyKey = pureCircuits.policyKeyOf(vault, assetKey);
        keys.push(policyKey);
        for (const period of [0n, 1n]) {
          const periodKey = pureCircuits.periodKeyOf(policyKey, bytes(0xd0), period);
          keys.push(periodKey, pureCircuits.chargedKeyOf(periodKey, bytes(0xe0)));
        }
      }
    }
    /* RED WHEN any two derivations produce the same key. */
    expect(new Set(keys.map(hex)).size).toBe(keys.length);
  });

  it("in proposalHolds: the removal count's key is no proposal's id", () => {
    const ids = [1, 2, 3].map((n) => pureCircuits.proposalIdOf(bytes(n), pureCircuits.noVault(), bytes(n + 10)));
    const all = [pureCircuits.removalCountKey(), ...ids];
    expect(new Set(all.map(hex)).size).toBe(all.length);
  });

  it('and nothing in one map is keyed like the other: the fixed keys of both are four distinct values', () => {
    const fixed = [
      pureCircuits.companyLabelKey(), pureCircuits.payKeyCommitmentKey(),
      pureCircuits.anchorKey(), pureCircuits.removalCountKey(),
    ];
    expect(new Set(fixed.map(hex)).size).toBe(4);
  });
});
