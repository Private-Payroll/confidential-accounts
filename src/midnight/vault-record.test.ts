/**
 * WHAT IS WRITTEN DOWN WHEN A VAULT IS CREATED. S6e.
 *
 * Four properties, and every one of them is a money property rather than a
 * bookkeeping one:
 *
 *   · a second vault of the same name does not overwrite the first, because
 *     overwriting forgets an address that exists nowhere else;
 *   · an unreadable registry is a refusal and never an empty one;
 *   · **nothing a report prints carries the vault's address — C236;**
 *   · **two vaults' signers are never filed under one id — C275**, which is
 *     the rule that decides whether the key to a funded vault survives the
 *     next vault being created.
 *
 * The last is tested by searching the rendered lines for the address AND for
 * every substring of it long enough to be worth having, because the failure it
 * prevents is somebody adding "just the first eight characters, for support".
 */
import { describe, it, expect } from 'vitest';
import {
  assertVaultName, vaultAuthorityFile, vaultRegistryFile, vaultPoolSignersFile, mintedSignerIds,
  emptyVaultRegistry, parseVaultRegistry, addVault, updateVault, describeVaultForReport,
  type VaultEntry,
} from './vault-record.js';

const ADDRESS = '7c'.repeat(32);
const ACCOUNT = '3d'.repeat(32);

const entry = (name: string, over: Partial<VaultEntry> = {}): VaultEntry => ({
  name,
  purpose: 'the UK payroll pot',
  contractAddress: ADDRESS,
  accountAddress: ACCOUNT,
  deployedAt: '2026-08-29T10:00:00.000Z',
  circuits: ['deposit', 'payout', 'retire', 'splitNote'],
  maintenanceAuthority: {
    kind: 'single-key', committeeSize: 1, threshold: 1, fixedBy: 'the round that replaces it',
  },
  adopted: false,
  deployTx: null,
  ...over,
});

describe('a vault is named, not addressed', () => {
  it('takes a slug a person chose', () => {
    for (const n of ['payroll-uk', 'contractors', 'alice', 'a1', 'x-9-z']) {
      expect(assertVaultName(n)).toBe(n);
    }
  });

  it('refuses anything that could escape a directory or shadow another entry', () => {
    // The name becomes a FILENAME and a record key, which is why the rule is
    // this narrow. `..` and `.` cannot be spelled under it, deliberately.
    for (const n of ['..', '.', 'a/b', 'a b', 'A', '', 'a', 'a--b', '-a', 'a-', 'a.b', 'a_b']) {
      expect(() => assertVaultName(n)).toThrow(/not a usable vault name/);
    }
  });

  it('says why it is a name rather than an address, in the refusal itself', () => {
    // A refusal that does not carry its reason gets "fixed" by widening the rule.
    expect(() => assertVaultName('..')).toThrow(/C236/);
  });

  it('files the authority choice under the NAME, so no address is ever a filename', () => {
    const path = vaultAuthorityFile('/repo/.midnight', 'payroll-uk');
    expect(path).toBe('/repo/.midnight/vault-authority-payroll-uk.json');
    expect(path).not.toContain(ADDRESS);
    // And the account's own file is untouched by any of this: it is one file
    // and it stays one file.
    expect(path).not.toContain('maintenance-authority.json');
  });

  it('keeps the set per network, exactly as the account\'s record is', () => {
    expect(vaultRegistryFile('/repo/.midnight', 'stagenet'))
      .toBe('/repo/.midnight/stagenet-vaults.json');
    expect(vaultRegistryFile('/repo/.midnight', 'preview'))
      .toBe('/repo/.midnight/preview-vaults.json');
  });

  it('refuses a name that would build a path outside the state directory', () => {
    expect(() => vaultAuthorityFile('/repo/.midnight', '../../etc/passwd')).toThrow();
  });
});

describe('two vaults for the same purpose are two vaults', () => {
  it('adds a vault to an empty registry', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    expect(Object.keys(r.vaults)).toEqual(['payroll-uk']);
    expect(r.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('keeps every other vault when one is added', () => {
    let r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    r = addVault(r, entry('contractors', { contractAddress: '11'.repeat(32) }));
    r = addVault(r, entry('alice', { contractAddress: '22'.repeat(32) }));
    expect(Object.keys(r.vaults).sort()).toEqual(['alice', 'contractors', 'payroll-uk']);
    // The one operation that must not lose anything: adding.
    expect(r.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('REFUSES to write a second vault of the same name over the first', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    const second = entry('payroll-uk', { contractAddress: '99'.repeat(32) });
    expect(() => addVault(r, second)).toThrow(/LOSE THE FIRST VAULT'S ADDRESS/);
    // And the registry it refused is unchanged — no half-add.
    expect(r.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('the refusal says what to do, because a bare refusal gets worked around', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    const failure = (() => {
      try { addVault(r, entry('payroll-uk')); return null; } catch (e) { return e as Error; }
    })();
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/give this one its own name/);
    expect(failure!.message).toMatch(/move its entry aside deliberately/);
  });

  it('does not mutate the registry it was given', () => {
    const before = emptyVaultRegistry('stagenet');
    const after = addVault(before, entry('payroll-uk'));
    expect(Object.keys(before.vaults)).toEqual([]);
    expect(Object.keys(after.vaults)).toEqual(['payroll-uk']);
  });
});

describe('creating a vault and advancing its record are different acts', () => {
  it('adds what the read-back learned, without moving the vault', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    const withTx = { ...r.vaults['payroll-uk']!, deployTx: { paidFees: '42', blockHeight: 9 } };
    const after = updateVault(r, withTx);
    expect(after.vaults['payroll-uk']!.deployTx).toEqual({ paidFees: '42', blockHeight: 9 });
    expect(after.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('refuses to update a vault that was never created', () => {
    expect(() => updateVault(emptyVaultRegistry('stagenet'), entry('payroll-uk')))
      .toThrow(/there is no vault called "payroll-uk"/);
  });

  it('REFUSES to move the recorded address, which is the one thing an update may not do', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    const moved = { ...r.vaults['payroll-uk']!, contractAddress: '99'.repeat(32) };
    expect(() => updateVault(r, moved)).toThrow(/refusing to change the recorded address/);
    expect(r.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('is what the deploy uses second — adding twice would refuse and lose the measurement', () => {
    // The order the script depends on, pinned: addVault the moment the address
    // exists, updateVault for the read-back that is allowed to fail.
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    expect(() => addVault(r, entry('payroll-uk'))).toThrow();
    expect(() => updateVault(r, entry('payroll-uk'))).not.toThrow();
  });
});

describe('an unreadable registry is not an empty one', () => {
  it('parses a real registry', () => {
    const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));
    const round = parseVaultRegistry(JSON.parse(JSON.stringify(r)), 'stagenet');
    expect(round.vaults['payroll-uk']!.contractAddress).toBe(ADDRESS);
  });

  it('refuses anything that is not a registry rather than answering with none', () => {
    for (const bad of [null, undefined, 42, 'a string', {}, { vaults: null }]) {
      expect(() => parseVaultRegistry(bad, 'stagenet')).toThrow(/not an empty registry/);
    }
  });

  it('refuses a registry from another network', () => {
    const r = addVault(emptyVaultRegistry('preview'), entry('payroll-uk'));
    expect(() => parseVaultRegistry(r, 'stagenet')).toThrow(/meaningless on another chain/);
  });
});

describe('C236: no vault address reaches a screen', () => {
  const lines = describeVaultForReport(entry('payroll-uk'));
  const rendered = lines.join('\n');

  it('names the vault by the name a person chose', () => {
    expect(rendered).toContain('payroll-uk');
    expect(rendered).toContain('the UK payroll pot');
  });

  it('carries no part of the address long enough to be worth having', () => {
    expect(rendered).not.toContain(ADDRESS);
    /*
     * EVERY WINDOW OF EIGHT CHARACTERS, not just the whole string. A truncated
     * address is still an address to somebody who can find the rest, and it
     * looks exactly like something to paste into a wallet — which is the one
     * action that strands a vault's money permanently.
     */
    for (let i = 0; i + 8 <= ADDRESS.length; i += 1) {
      expect(rendered).not.toContain(ADDRESS.slice(i, i + 8));
    }
    // The account it is married to is not shown either: it is an address.
    expect(rendered).not.toContain(ACCOUNT.slice(0, 8));
  });

  it('says WHY the address is absent, where a reader will ask', () => {
    // Without this a later round reads the omission as an oversight and fixes it.
    expect(rendered).toMatch(/C236/);
    expect(rendered).toMatch(/nobody can spend/);
    expect(rendered).toMatch(/deposit CALL/);
  });

  it('reports the authority as a SHAPE and never as key material', () => {
    expect(rendered).toContain('single-key — committee of 1, threshold 1');
    expect(rendered).toContain('TEMPORARY');
    expect(rendered).not.toMatch(/signingKey|schnorr/);
  });

  it('says adoption is not yet done rather than leaving it blank', () => {
    expect(rendered).toMatch(/not yet — adopt is a governed round/);
    expect(describeVaultForReport(entry('x', { adopted: true })).join('\n'))
      .toMatch(/adopted by the account yes/);
  });
});

/*
 * `C275`. THE MINT THAT OVERWROTE THE KEY TO A FUNDED VAULT.
 *
 * Every one of these is a money property. The ids a vault's signers get are
 * the names under which their SECRETS are filed, and the sealed pool record
 * names its signers by id and never by public key — so an id reused across two
 * vaults silently replaces the first vault's key with the second's, and
 * nothing in the system can compare them to notice. The pool is the only
 * record of a note's nonce, colour and value (`C284`), and a commitment on
 * chain cannot be inverted to recover them.
 *
 * **It had already fired twice on disk before it was found.** These tests are
 * what stops a third.
 */
describe('C275: the ids a vault\'s test signers are filed under', () => {
  it('carries the vault name, so two vaults cannot be filed under one id', () => {
    expect(mintedSignerIds('payroll-uk', 3, [])).toEqual([
      'payroll-uk-signer-1', 'payroll-uk-signer-2', 'payroll-uk-signer-3',
    ]);
    const a = mintedSignerIds('payroll-uk', 3, []);
    const b = mintedSignerIds('contractors', 3, []);
    // The property, stated as the failure it prevents rather than as a format.
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it('REFUSES an id whose secret already exists, rather than writing over it', () => {
    // The load-bearing part of that refusal is WHICH id, not the phrasing: a
    // person holding it has to know which signer of which vault they are
    // about to overwrite. Pinning the prose instead pins nothing anybody acts on.
    expect(() => mintedSignerIds('payroll-uk', 2, ['payroll-uk-signer-1']))
      .toThrow(/payroll-uk-signer-1/);
  });

  it('refuses on the FIRST collision and returns nothing, so a partial set is never written', () => {
    // The second id collides. If this returned the first, a caller writing as
    // it went would leave half a signer set behind a refusal saying nothing
    // was written.
    expect(() => mintedSignerIds('payroll-uk', 3, ['payroll-uk-signer-2'])).toThrow();
  });

  it('names C275 and C284 in the refusal, because the reason is not guessable from the symptom', () => {
    // A person reading "already exists" alone concludes the file is stale and
    // deletes it. What they are actually holding is the only key to a vault.
    expect(() => mintedSignerIds('payroll-uk', 1, ['payroll-uk-signer-1']))
      .toThrow(/C275/);
    expect(() => mintedSignerIds('payroll-uk', 1, ['payroll-uk-signer-1']))
      .toThrow(/C284/);
    expect(() => mintedSignerIds('payroll-uk', 1, ['payroll-uk-signer-1']))
      .toThrow(/RE-SEAL/);
  });

  it('does not treat another vault\'s ids as taken', () => {
    // The scoping is what makes the refusal rare rather than constant. If this
    // failed, the door would refuse every second vault and a person would edit
    // the key file by hand — which is the failure, arrived at the long way.
    expect(mintedSignerIds('contractors', 2, ['payroll-uk-signer-1', 'payroll-uk-signer-2']))
      .toEqual(['contractors-signer-1', 'contractors-signer-2']);
  });

  it('applies the vault name rule, so a name cannot become a filename it should not', () => {
    expect(() => mintedSignerIds('../escape', 1, [])).toThrow(/not a usable vault name/);
    expect(() => mintedSignerIds('NEWROUND.Repository:x', 1, [])).toThrow(/not a usable vault name/);
  });

  it('refuses a signer count below one, because sealPool refuses a pool wrapped to nobody', () => {
    expect(() => mintedSignerIds('payroll-uk', 0, [])).toThrow(/V-91/);
    expect(() => mintedSignerIds('payroll-uk', -1, [])).toThrow(/V-91/);
    // And a count that is not a whole number at all. `count < 1` alone catches
    // 0 and -1, so without these the integer half of the guard is free to
    // delete with the suite still green — which is how a guard becomes decoration.
    expect(() => mintedSignerIds('payroll-uk', 2.5, [])).toThrow(/V-91/);
    expect(() => mintedSignerIds('payroll-uk', Number.NaN, [])).toThrow(/V-91/);
  });

  it('files the public halves under the vault name, by the same rule', () => {
    expect(vaultPoolSignersFile('.midnight', 'payroll-uk'))
      .toBe('.midnight/vault-pool-signers-payroll-uk.json');
    expect(() => vaultPoolSignersFile('.midnight', '../escape')).toThrow(/not a usable vault name/);
  });
});
