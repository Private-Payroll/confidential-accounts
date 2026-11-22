/**
 * EVERY KEY WRITTEN INTO THE ACCOUNT'S TWO SHARED MAPS, AND WHY NONE COLLIDE.
 *
 * `signerRoles` holds the company's label, the commitment to the pay-record key
 * and each signer's sealed copy of it, each vault's spending policy per token,
 * the marker that a vault is under a policy, each period's running total, and
 * the record that a run's tree was charged in a period, under which a charged
 * leg's retries keep what they have taken, the company's record anchor, one
 * head under its own fixed key, and beside it the head the latest recovery
 * carried out wrote, under another. `proposalHolds` holds each open proposal's hold and, under one fixed key,
 * the account's removal count. In a shared map every writer is a boundary: a key
 * two derivations could both produce would let one writer overwrite the other's
 * entry.
 *
 * So this file does three things. It lists every insert into either map, read off
 * the contract, and refuses a new one it does not know. It reads each derivation's
 * domain tag off the contract and proves the tags are distinct, that every derived
 * key hashes its tag FIRST and that every fixed one is the hash of its tag alone,
 * written out, so two derivations can only meet by a hash collision. And it
 * computes the keys for real inputs and proves they differ.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contractSourceText } from '../../scripts/contract-sources.mjs';

import { pureCircuits } from '../managed/contract/index.js';
import { partKeyOf } from './part-keys.js';

/* The account's main file and every file it brings in (scripts/contract-sources.mjs). */
const SRC = contractSourceText(join(import.meta.dirname, '..', '..'), 'contracts/src/ConfidentialAccount.compact');
const bytes = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** The body of one exported circuit, from its signature to the brace that closes it, wherever it is indented. */
const bodyOf = (name: string): string => {
  const at = SRC.indexOf(`export circuit ${name}(`);
  if (at < 0) throw new Error(`the contract has no circuit ${name}`);
  let depth = 0;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    if (SRC[i] === '}' && (depth -= 1) === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`${name}'s body is never closed`);
};
/**
 * The domain tag a derivation hashes, as the contract spells it. A fixed name is written out as its 32 bytes, with the
 * tag it is the SHA-256 of named in the comment above them; `fixedBytesOf` checks the bytes are that hash.
 */
const tagOf = (name: string): string => {
  const m = bodyOf(name).match(/pad\(32, "([^"]+)"\)/) ?? bodyOf(name).match(/\/\/ SHA-256 of "([^"]+)" zero-padded to 32 bytes/);
  if (!m) throw new Error(`${name} hashes no tag`);
  return m[1]!;
};
/** The 32 bytes a fixed name returns, read off its literal. */
const fixedBytesOf = (name: string): string => {
  const m = bodyOf(name).match(/return Bytes\[([^\]]+)\];/);
  if (!m) throw new Error(`${name} is not written out as 32 bytes`);
  return m[1]!.split(',').map((b) => Number(b.trim()).toString(16).padStart(2, '0')).join('');
};
/** SHA-256 of a tag padded with zeros to 32 bytes, as the fixed names were first derived. */
const sha256OfTag = (tag: string): string => {
  const padded = new Uint8Array(32);
  padded.set(new TextEncoder().encode(tag));
  return createHash('sha256').update(padded).digest('hex');
};
/*
 * The nine names the contract writes out as bytes: fixed keys of the shared maps, and the scopes and vaults no address
 * can equal. Each value is the one every account already deployed holds its entries under, written here once and
 * never derived, so a tag and its bytes changed together still fail.
 */
const FIXED_VALUES = {
  allVaults: '78dc328cecab05f96eda4c96f34635e967154d5f82046f6ecf0430902ee541b5',
  noVault: '48f37c0faabf55b9ce2232cb91b0ac15c5ff7784475deee421ac6324c9956f0b',
  companyWide: '013d1f45a06cef7b200525733767038c78c55146325eff12c3b43fabd267d33b',
  payKeyCommitmentKey: 'cc3136c78f2e28cdca860e119187d8ccafdae6f3d23e86586cc5c21bfd558c4e',
  companyLabelKey: 'e5c1cb2519bc5f6bc4a0f779d4f851bec45bdc7127d2a5e6292b508674358903',
  anchorKey: '635cdccbcbf76b7f6a9688c13b36700f71bdda8b551dd00d9b96787d8cd8b50f',
  anchorSeatKey: '26c18d23bfdb55c4313c5e478e2069dd1028b556fb1dabc69f116ab1f414c925',
  lastRecoveryKey: '800f6f4de6d643b36317a590314a8f4b06a9479521d0b128e422596d384913f4',
  policyBarKey: 'e32da4f5eb054663098534158908cfa8cd36b6c702ac1c2dae8df0e6a1178407',
} as const;
const FIXED = Object.keys(FIXED_VALUES) as Array<keyof typeof FIXED_VALUES>;

/* Every key expression the contract inserts under, per map. Read off the source below, never assumed. */
const SIGNER_ROLES_WRITES = [
  'companyLabelKey()',
  'usedKey',
  'payKeyCommitmentKey()',
  'first',
  'disclose(payKeyWrapKeyFrom(base, 1))',
  'disclose(payKeyWrapKeyFrom(base, 2))',
  'disclose(payKeyWrapKeyFrom(base, 3))',
  'disclose(policyKeyOf(forVault, assetKey))',
  'disclose(policyOnKeyOf(forVault))',
  'totalKey',
  'charged',
  'anchorKey()',
  'anchorSeatKey()',
  'anchorKey()',
  'anchorSeatKey()',
  'lastRecoveryKey()',
];
/*
 * `propose` writes each proposal's hold; `holdRun`, `releaseHold` and the receipt step (which marks
 * a run paid from) rewrite a run's, under the same id.
 */
const PROPOSAL_HOLDS_WRITES = ['removalCountKey()', 'proposal', 'removalCountKey()', 'id', 'id', 'id', 'id'];

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
  it("signerRoles: the label, the pay-record key's commitment, four parts of each signer's copy, the policy's keys, the anchor and its seat from anchor and recoverAnchor, and the latest recovery's head, and nothing else", () => {
    /* RED WHEN a new writer of signerRoles appears: it must be listed here, and its key checked below. */
    expect(insertsInto('signerRoles')).toEqual(SIGNER_ROLES_WRITES);
    /* `first` is the copy's first part, derived the same way as the other three, from the signer's own hash. */
    expect(SRC).toContain('const base = payKeyWrapBaseOf(account, sk);');
    expect(SRC).toContain('const first = disclose(payKeyWrapKeyFrom(base, 0));');
  });

  it("the policy's writers derive every key in the circuit, from the vault, the token and the period, never from a caller", () => {
    /* RED WHEN setPolicy's token key is taken from anything but the device's own asset and blinding. */
    expect(SRC).toContain('const assetKey = assetKeyOf(assetId(), assetBlinding());');
    /* RED WHEN clearRun's keys are read from an argument rather than derived. */
    expect(SRC).toContain('const policyKey = disclose(policyKeyOf(forVault, assetKeyOf(asset, assetBlinding())));');
    expect(SRC).toContain('const periodKey = disclose(periodKeyOf(policyKey, commitment, inPeriod));');
    expect(SRC).toContain('const legCharged = disclose(chargedKeyOf(periodKey, forLeg));');
    expect(SRC).toContain('const charged = disclose(chargedKeyOf(periodKey, forRoot));');
    /* RED WHEN the key a period's or a leg's total is written under is anything but one of those two. */
    expect(SRC).toContain('const totalKey = free ? legCharged : periodKey;');
  });

  it('the anchor and a recovery write one head and one seat under their fixed keys, each derived in the circuit', () => {
    /* RED WHEN the anchor or a recovery writes under a key or a value taken from its caller. */
    expect(SRC).toContain('signerRoles.insert(anchorKey(), anchorHeadOf(before, anchorHeldOf(records, judged, root, tag)));');
    expect(bodyOf('recoverAnchor')).toContain('const head = anchorHeadOf(before, anchorRecoveredOf(records, judged, root, tag, resumed));');
    expect(bodyOf('recoverAnchor')).toContain('signerRoles.insert(anchorKey(), head);');
    expect(SRC.match(/signerRoles\.insert\(anchorSeatKey\(\), tag\);/g)).toHaveLength(2);
    /* RED WHEN a recovery writes anything but the head it moved the anchor to as the latest recovery's head. */
    expect(bodyOf('recoverAnchor')).toContain('signerRoles.insert(lastRecoveryKey(), head);');
    /* RED WHEN the seat's tag is taken from the caller rather than worked out from the seat the circuit proved. */
    const mayMove = SRC.slice(SRC.indexOf('circuit anchorMayMove('), SRC.indexOf('\n}\n', SRC.indexOf('circuit anchorMayMove(')));
    expect(mayMove).toContain('return disclose(anchorTagOf(kernel.self().bytes, caller.pk, caller.blinding));');
    expect(bodyOf('anchor')).toContain('const caller = openedSeat();');
    expect(bodyOf('recoverAnchor')).toContain('const caller = openedSeat();');
  });

  it('proposalHolds: the removal count under its fixed key, twice, and each proposal under its id', () => {
    /* RED WHEN a new writer of proposalHolds appears. */
    expect(insertsInto('proposalHolds')).toEqual(PROPOSAL_HOLDS_WRITES);
    /* The id `propose` writes under is the commitment `proposalIdOf` computes, nothing a caller hands in. */
    expect(SRC).toContain('const id = disclose(proposalIdOf(payload, disclose(vault), salt));');
    /* RED WHEN a hold or its release writes under a key that is not an open run's own id, read from the ledger first. */
    expect(bodyOf('holdRun')).toContain('const hold = holdOf(id);');
    expect(bodyOf('releaseHold')).toContain('const hold = holdOf(id);');
    /* RED WHEN the paid-from mark writes under a key it did not first read as an open proposal's hold. */
    const mark = SRC.slice(SRC.indexOf('circuit markPaidFrom('), SRC.indexOf('\n}\n', SRC.indexOf('circuit markPaidFrom(')));
    expect(mark).toContain('const hold = holdOf(proposal);');
  });

  it('approvals: an approval and an agreement to release a hold are nullifiers under different tags', () => {
    const tag = (name: string) => {
      const at = SRC.indexOf(`circuit ${name}(`);
      return SRC.slice(at, SRC.indexOf('\n}\n', at)).match(/pad\(32, "([^"]+)"\)/)![1];
    };
    /* RED WHEN the two share a tag: one signer's approval of a run would then count as their release of its hold, or the reverse. */
    expect(tag('releaseNullifier')).not.toBe(tag('approvalNullifierOf'));
    /* And both are written the same way: a nullifier computed in the circuit, never a caller's value. */
    expect(SRC.match(/approvals\.insert\(/g)).toHaveLength(3);
    expect(SRC.match(/approvals\.insert\(nul\);/g)).toHaveLength(2);
    /* The third is the raise's: the raiser's approval nullifier, computed in the helper both raises share from the
     * secret key of the seat each one proved. */
    const opened = SRC.slice(SRC.indexOf('circuit openProposal('), SRC.indexOf('\n}\n', SRC.indexOf('circuit openProposal(')));
    expect(opened).toContain('approvals.insert(disclose(approvalNullifier(sk, id)));');
    expect(bodyOf('propose')).toMatch(/const caller = seat\(\);[\s\S]*openProposal\(id, change, caller\.sk,/);
    expect(bodyOf('proposeCompanyChange')).toMatch(/const caller = seat\(\);[\s\S]*openProposal\(id, companyChangeMark\(\), caller\.sk,/);
  });
});

describe('the derivations are separated by their tags', () => {
  const DERIVATIONS = [
    'companyLabelKey', 'payKeyCommitmentKey', 'payKeyWrapBaseOf', 'anchorKey',
    'removalCountKey', 'proposalIdOf',
    'policyKeyOf', 'policyOnKeyOf', 'periodKeyOf', 'chargedKeyOf', 'changesUsedKeyOf',
    'anchorHeadOf', 'anchorHeldOf', 'retrySaltOf', 'periodTotalTag', 'legTakenTag',
    'anchorSeatKey', 'anchorTagOf', 'anchorRecoveredOf', 'recoverAnchorPayload', 'lastRecoveryKey',
    'approvalNullifierOf',
  ];

  it("every derivation has its own tag, and the anchor's is the one ruled", () => {
    const tags = DERIVATIONS.map(tagOf);
    /* RED WHEN two derivations share a tag, the anchor's above all. */
    expect(new Set(tags).size).toBe(tags.length);
    expect(tagOf('anchorKey')).toBe('midnight-accounts:roles:anchor');
    /* And no tag is another's prefix padded out: each fits 32 bytes as written. */
    for (const t of tags) expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(32);
  });

  it('the nine fixed names are the SHA-256 of their own tags, written out, and no two are equal', () => {
    for (const fixed of FIXED) {
      /* RED WHEN a fixed name's bytes are not the hash of the tag it names, so a value it was first written under moves. */
      expect(fixedBytesOf(fixed)).toBe(sha256OfTag(tagOf(fixed)));
      /* RED WHEN the compiled circuit returns anything but those bytes. */
      expect(hex((pureCircuits as unknown as Record<string, () => Uint8Array>)[fixed]!())).toBe(fixedBytesOf(fixed));
      /* RED WHEN a fixed name moves off the value deployed accounts hold their entries under, even with its tag moved too. */
      expect(fixedBytesOf(fixed)).toBe(FIXED_VALUES[fixed]);
    }
    /* RED WHEN two fixed names share a tag or a value: two writers of a shared map, or a scope standing for a vault. */
    expect(new Set(FIXED.map(tagOf)).size).toBe(FIXED.length);
    expect(new Set(FIXED.map(fixedBytesOf)).size).toBe(FIXED.length);
  });

  it('a part key is kept to 31 bytes on both sides: a hash at the very top wraps its later parts to 0, 1 and 2', () => {
    const top = new Uint8Array(32).fill(0xff);
    const wrapped = [0n, 1n, 2n, 3n].map((part) => hex(partKeyOf(top, part)));
    /* RED WHEN the runtime stops keeping the key to the 31 bytes the circuit keeps, so a device reads where nothing was written. */
    expect(wrapped).toEqual(['ff'.repeat(31) + '00', '00'.repeat(32), '01' + '00'.repeat(31), '02' + '00'.repeat(31)]);
    for (const [dir, circuit] of [['managed', 'sealPayKey'], ['managed-vault', 'writeSecretCopy']]) {
      const zkir = JSON.parse(readFileSync(join(import.meta.dirname, '..', dir!, 'zkir', `${circuit}.zkir`), 'utf8')) as { instructions: Array<{ op: string; bits?: number }> };
      /* RED WHEN the circuit stops keeping each part key to 248 bits, as the runtime does. */
      expect(zkir.instructions.filter((i) => i.op === 'div_mod_power_of_two' && i.bits === 248).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('the derived keys hash their tag FIRST', () => {
    expect(bodyOf('payKeyWrapBaseOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[pad\(32, "midnight-accounts:roles:wrap:"\), account, sk\]\)/);
    /* RED WHEN a part's key is made any other way than the shared hash plus the part. */
    expect(bodyOf('payKeyWrapKeyOf')).toMatch(/return payKeyWrapKeyFrom\(payKeyWrapBaseOf\(account, sk\), part\);/);
    expect(bodyOf('payKeyWrapKeyFrom')).toMatch(/return upgradeFromTransient\(degradeToTransient\(base\) \+ \(part as Field\)\);/);
    expect(bodyOf('proposalIdOf')).toMatch(/persistentCommit<Vector<3, Bytes<32>>>\(\s*\[pad\(32, "midnight-accounts:proposal-id:"\)/);
    /* RED WHEN a policy key stops hashing its own tag first. */
    expect(bodyOf('policyKeyOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:policy:"\), vault, assetKey/);
    expect(bodyOf('policyOnKeyOf')).toMatch(/persistentHash<Vector<2, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:pol-on:"\), vault/);
    expect(bodyOf('periodKeyOf')).toMatch(/persistentHash<Vector<4, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:period:"\), policyKey, commitment,/);
    expect(bodyOf('chargedKeyOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:charged:"\), periodKey, root/);
    /* RED WHEN a head stops hashing its own tag first, then the head before it, then the batch. */
    expect(bodyOf('anchorHeadOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:anchor:"\), previous, batch/);
    /* RED WHEN what one anchor folds stops hashing its own tag first, then the batch, the approvals and the signer root. */
    expect(bodyOf('anchorHeldOf')).toMatch(/persistentHash<Vector<5, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:anchor:held:"\), batch, approvals as Field as Bytes<32>, signerRoot\.field as Bytes<32>, tag/);
    /* RED WHEN what a recovery folds stops hashing its own tag first, then as an anchor does, then the head it resumes from. */
    expect(bodyOf('anchorRecoveredOf')).toMatch(/persistentHash<Vector<6, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:recovered:"\), batch, approvals as Field as Bytes<32>, signerRoot\.field as Bytes<32>, tag,\s*resumesFrom/);
    /* RED WHEN what a recovery is approved for stops hashing its own tag first, then the head it resumes from, its latest time and the latest recovery's head. */
    expect(bodyOf('recoverAnchorPayload')).toMatch(/persistentHash<Vector<4, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:recover:"\), resumesFrom, latest as Field as Bytes<32>, lastRecovery/);
    /* RED WHEN a seat's tag stops hashing its own tag first, then the account, the seat's key and its blinding. */
    expect(bodyOf('anchorTagOf')).toMatch(/persistentHash<Vector<4, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:anchor:seat:"\), account, pk, blinding/);
    /* RED WHEN a retry's salt stops hashing its own tag first, then its leg's root. */
    expect(bodyOf('retrySaltOf')).toMatch(/persistentHash<Vector<3, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:retry-salt:"\), legRoot, fresh/);
    /* RED WHEN the count of a run's used changes stops hashing its own tag first, with the run's id. */
    expect(bodyOf('changesUsedKeyOf')).toMatch(/persistentHash<Vector<2, Bytes<32>>>\(\[\s*pad\(32, "midnight-accounts:roles:used:"\), proposal/);
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
      pureCircuits.anchorSeatKey(),
      pureCircuits.lastRecoveryKey(),
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
    for (const id of [bytes(0xf0), bytes(0xf1)]) keys.push(pureCircuits.changesUsedKeyOf(id));
    /* RED WHEN any two derivations produce the same key. */
    expect(new Set(keys.map(hex)).size).toBe(keys.length);
  });

  it("in proposalHolds: the removal count's key is no proposal's id", () => {
    const ids = [1, 2, 3].map((n) => pureCircuits.proposalIdOf(bytes(n), pureCircuits.noVault(), bytes(n + 10)));
    const all = [pureCircuits.removalCountKey(), ...ids];
    expect(new Set(all.map(hex)).size).toBe(all.length);
  });

  it('and nothing in one map is keyed like the other: the fixed keys of both are six distinct values', () => {
    const fixed = [
      pureCircuits.companyLabelKey(), pureCircuits.payKeyCommitmentKey(),
      pureCircuits.anchorKey(), pureCircuits.anchorSeatKey(), pureCircuits.lastRecoveryKey(), pureCircuits.removalCountKey(),
    ];
    expect(new Set(fixed.map(hex)).size).toBe(6);
  });
});
