/**
 * WHAT IS WRITTEN DOWN WHEN A VAULT IS CREATED.
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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertVaultName, vaultAuthorityFile, vaultRegistryFile, vaultPoolSignersFile, mintedSignerIds,
  emptyVaultRegistry, parseVaultRegistry, addVault, updateVault, describeVaultForReport,
  theVault, theVaultNameMeant, whenThisNameWasTaken, vaultRegistryForDisk, namesRecordedFor,
  type VaultEntry, type VaultRegistry,
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
 * THE MINT THAT OVERWROTE THE KEY TO A FUNDED VAULT.
 *
 * Every one of these is a money property. The ids a vault's signers get are
 * the names under which their SECRETS are filed, and the sealed pool record
 * names its signers by id and never by public key — so an id reused across two
 * vaults silently replaces the first vault's key with the second's, and
 * nothing in the system can compare them to notice. The pool is the only
 * record of a note's nonce, colour and value, and a commitment on
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

/* ------------------------------------------------------------------ *
 * A RETIRED VAULT, AND THE ONE LOOKUP THAT REFUSES IT FOR EVERY DOOR
 * ------------------------------------------------------------------ */

describe('a vault recorded as disposed of is refused where every path passes', () => {
  const registry = (over: Partial<VaultRegistry> = {}): VaultRegistry => ({
    network: 'stagenet',
    savedAt: '2026-09-09T02:19:20.731Z',
    current: 'live-one',
    vaults: {
      'live-one': entry('live-one'),
      'dead-one': entry('dead-one', {
        disposed: true,
        disposed_why: 'emptied and closed when the company moved to a new authority',
      }),
    },
    ...over,
  });

  /*
   * **THE SENTINEL IS NOT DECORATION.** An empty string satisfies every
   * `not.toContain` and `not.toMatch` written against it, so a helper that
   * returns '' when nothing was thrown makes the next negative assertion
   * somebody writes vacuous without saying so.
   */
  const NOTHING_THREW = 'NOTHING WAS THROWN AT ALL';
  const refusalFor = (name: string, r: VaultRegistry = registry()): string => {
    try { theVault(r, name); return NOTHING_THREW; } catch (e) { return (e as Error).message; }
  };

  it('REFUSES a vault the record marks as disposed of', () => {
    expect(
      refusalFor('dead-one'),
      'RED WHEN: theVault stops refusing on the disposed flag -- a retired vault still exists '
      + 'on chain and still accepts a deposit, and nothing downstream can give that money back',
    ).toMatch(/DISPOSED OF/);
  });

  it('carries the record\x27s OWN reason to the screen rather than a reason of its own', () => {
    /*
     * The two vaults retired today were retired for a shape, and the refusal
     * used to say so in its own words. **A vault can be retired for a reason
     * that is not a shape** -- emptied, superseded, its authority gone -- so the
     * sentence that explains WHY comes out of the record, not out of this code.
     */
    expect(
      refusalFor('dead-one'),
      'RED WHEN: the refusal stops printing disposed_why and goes back to asserting one '
      + 'particular reason, which is then false for every vault retired for another',
    ).toMatch(/emptied and closed when the company moved to a new authority/);
    /*
     * RED WHEN: the reason is pasted in raw and a `disposed_why` that already
     * ends in a full stop produces "...authority.." -- small, and it is the kind
     * of small that makes a reader trust the sentence less.
     */
    const ends = registry();
    ends.vaults['dead-one']!.disposed_why = 'superseded by the new one.';
    expect(refusalFor('dead-one', ends)).toContain('superseded by the new one.\n');
    expect(refusalFor('dead-one', ends)).not.toContain('..');
    /*
     * RED WHEN: a vault retired with no reason recorded produces a sentence that
     * runs straight into the next one. The reason is optional and the refusal is
     * not, so the punctuation cannot depend on the reason being there.
     */
    const noReason = registry();
    delete (noReason.vaults['dead-one'] as { disposed_why?: string }).disposed_why;
    expect(refusalFor('dead-one', noReason)).toContain('DISPOSED OF, so no door works '
      + 'against it.\n');
  });

  it('names the live vault, which is the only thing the reader can act on', () => {
    expect(
      refusalFor('dead-one'),
      'RED WHEN: the refusal stops naming the live vault, leaving a reader who is refused '
      + 'with nothing they can act on',
    ).toMatch(/The live vault is "live-one"/);
  });

  it('still says something actionable when no vault is recorded as live', () => {
    const r = registry(); delete (r as { current?: string }).current;
    expect(
      refusalFor('dead-one', r),
      'RED WHEN: the remedy depends on a live vault being recorded, so a record without one '
      + 'refuses with no remedy at all',
    ).toMatch(/Name it/);
  });

  it('does NOT refuse the live vault, and does not refuse a record that says nothing', () => {
    /*
     * Failing closed on the live vault stops the product, and every registry
     * written before the flag existed carries no flag at all -- refusing those
     * would refuse every vault on every machine that has not been rewritten.
     */
    expect(
      () => theVault(registry(), 'live-one'),
      'RED WHEN: the live vault, whose record says disposed is false, is refused anyway, which '
      + 'stops the product',
    ).not.toThrow();
    /*
     * TWO DIFFERENT SHAPES, and they were one before an audit said so: a record
     * that says `disposed: false` out loud, and a record written before the
     * field existed that says nothing. `entry()` sets no flag, so the second is
     * what it already is; the first has to be written.
     */
    const both = registry();
    both.vaults['says-false'] = entry('says-false', { disposed: false });
    both.vaults['says-nothing'] = entry('says-nothing');
    expect(
      () => theVault(both, 'says-false'),
      'RED WHEN: the flag is read as "present means disposed", so a record that says false out '
      + 'loud refuses the vault it was written to allow',
    ).not.toThrow();
    expect(
      () => theVault(both, 'says-nothing'),
      'RED WHEN: an absent flag is treated as disposed, which refuses every vault on every '
      + 'machine whose record was written before the field existed',
    ).not.toThrow();
  });

  it('refuses a name that is not in the record, and lists the ones that are', () => {
    const why = refusalFor('no-such-vault');
    expect(
      why,
      'RED WHEN: an unknown name resolves to undefined and is handed back as a vault, so a '
      + 'door reaches for an address that is not there',
    ).toMatch(/no vault called "no-such-vault"/);
    expect(why, 'RED WHEN: it stops listing the names that do exist, so a misspelling and an '
      + 'undeployed vault read as the same refusal')
      .toMatch(/live-one/);
  });

  it('refuses a name that is not a usable vault name before looking anything up', () => {
    /*
     * **THE KEYS OF THIS RECORD ARE NOT VALIDATED WHEN IT IS PARSED**, and the
     * file is hand-edited -- the header tells an operator to move entries aside
     * in it. A key that is not a vault name reaches a caller that builds a
     * filename out of it. This is the only thing standing there.
     */
    for (const bad of ['../../etc/passwd', 'Payroll UK', '', '-leading', 'trailing-']) {
      expect(
        () => theVault(registry(), bad),
        `RED WHEN: theVault stops validating the name, and "${bad}" reaches a door that joins `
        + 'it into a path',
      ).toThrow(/not a usable vault name/);
    }
  });

  it('REFUSES a record it cannot read on the question of disposal', () => {
    /*
     * **NOTHING IN THIS PRODUCT WRITES THE DISPOSAL FLAG.** It is typed into the
     * record by hand, so the ways of getting it slightly wrong are the ways it
     * will be got wrong -- and a bare `!== true` reads every one of them as
     * "alive", which is the silent direction.
     */
    const quoted = registry();
    (quoted.vaults['dead-one'] as unknown as { disposed: unknown }).disposed = 'true';
    expect(
      refusalFor('dead-one', quoted),
      'RED WHEN: a quoted "true" is read as not-disposed, so a vault somebody marked dead is '
      + 'handed to every door and a deposit into it succeeds',
    ).toMatch(/not true or false/);

    const orphanReason = registry();
    delete (orphanReason.vaults['dead-one'] as { disposed?: boolean }).disposed;
    expect(
      refusalFor('dead-one', orphanReason),
      'RED WHEN: a record carrying a written reason for being dead, with the flag itself '
      + 'forgotten, is treated as alive -- which is the likeliest way of all to write it, '
      + 'because the reason is the part a person wants to write down',
    ).toMatch(/does NOT carry "disposed": true/);
  });

  it('never offers a live vault that is itself refused', () => {
    /*
     * RED WHEN: the remedy names whatever the record points at, without asking
     * whether that vault is one this same function would turn away. The live
     * pointer and the flags are two independent hand edits.
     */
    const pointsAtTheDead = registry();
    pointsAtTheDead.current = 'dead-one';
    const why = refusalFor('dead-one', pointsAtTheDead);
    expect(why).toMatch(/DISPOSED OF/);
    expect(why).not.toMatch(/The live vault is/);
    expect(why).toMatch(/Name it/);
  });

  it('says so plainly when the record holds no vaults at all', () => {
    /*
     * RED WHEN: the empty case prints the list branch anyway, so somebody on a
     * fresh machine is refused with "The vaults it does have are: ." -- which
     * reads like a fault in the tool rather than an answer about the machine.
     */
    const none: VaultRegistry = { network: 'stagenet', savedAt: '', vaults: {} };
    expect(refusalFor('anything', none)).toMatch(/none at all on this network/);
    expect(refusalFor('anything', none)).not.toMatch(/does have are: \./);
  });

  it('refuses the disposed vault BEFORE handing back anything, not alongside a warning', () => {
    /*
     * RED WHEN: the refusal becomes a warning and the entry is returned anyway.
     * A returned entry carries the address, and an address is all a door needs
     * to deposit into a dead vault.
     */
    let got: unknown = 'nothing was thrown';
    try { got = theVault(registry(), 'dead-one'); } catch { got = 'refused'; }
    expect(got).toBe('refused');
  });

  it('lets a READ-ONLY POST-MORTEM through, and only when the caller passes one', () => {
    /*
     * A vault is retired while its money is still on chain, so somebody
     * eventually has to look at it. RED WHEN: the allowance stops working and
     * there is no way at all to read a retired vault.
     */
    expect(() => theVault(registry(), 'dead-one', { aReadOnlyPostMortem: true })).not.toThrow();
    expect(
      () => theVault(registry(), 'dead-one', { aReadOnlyPostMortem: false }),
      'RED WHEN: the allowance is treated as present-means-allowed, so a caller passing an '
      + 'explicit false is let through',
    ).toThrow(/DISPOSED OF/);
    expect(
      () => theVault(registry(), 'dead-one', {}),
      'RED WHEN: an empty allowances object opens the door, which is what a caller writes '
      + 'when they are threading options through and have not thought about this one',
    ).toThrow(/DISPOSED OF/);
  });
});

describe('which vault somebody meant when they pressed return', () => {
  /*
   * **`current` IS DELIBERATELY NOT THE FIRST KEY.** With one vault, or with the
   * live one listed first, "read `current`" and "take whichever key the JSON
   * object listed first" are the same value -- and the second is precisely the
   * behaviour this function exists to prevent. An audit found this fixture
   * making them one value, and a mutation that ignored `current` entirely
   * stayed green through the whole block.
   */
  const r: VaultRegistry = {
    network: 'stagenet', savedAt: '', current: 'live-one',
    vaults: { 'listed-first': entry('listed-first'), 'live-one': entry('live-one') },
  };

  it('answers with the live vault for a blank answer', () => {
    expect(
      theVaultNameMeant(r, ''),
      'RED WHEN: `current` stops being read and a blank answer refuses again, which is the '
      + 'state this was found in: the record said which vault was live and nothing read it',
    ).toBe('live-one');
    expect(theVaultNameMeant(r, '   ')).toBe('live-one');
  });

  it('answers with what was typed when something was typed', () => {
    expect(
      theVaultNameMeant(r, ' listed-first '),
      'RED WHEN: the default overrides a name the person actually typed, which would send a '
      + 'run at a vault nobody asked for',
    ).toBe('listed-first');
  });

  it('REFUSES rather than picking one when nothing is recorded as live', () => {
    const noneLive: VaultRegistry = { ...r }; delete (noneLive as { current?: string }).current;
    expect(
      () => theVaultNameMeant(noneLive, ''),
      'RED WHEN: a blank answer with no live vault recorded falls back to the first key of the '
      + 'vaults object, which is how a door ends up working against whichever vault a JSON '
      + 'object happened to list first',
    ).toThrow(/will not pick one for you/);
    expect(
      () => theVaultNameMeant(noneLive, ''),
      'RED WHEN: the refusal stops listing the vaults this machine knows, leaving somebody who '
      + 'is refused with nothing they can act on',
    ).toThrow(/The vaults it knows are: listed-first, live-one/);
  });

  it('says so plainly when there are no vaults at all', () => {
    /*
     * RED WHEN: the empty case prints the list branch anyway, so a fresh machine
     * is refused with "The vaults it knows are: ." -- which reads like a bug in
     * the tool rather than an answer about the machine.
     */
    expect(() => theVaultNameMeant(
      { network: 'stagenet', savedAt: '', vaults: {} }, '')).toThrow(/none at all on this network/);
  });
});

describe('the record is written back the way the file spells it', () => {
  /**
   * **A WRITER THAT SILENTLY DELETES THE THING THE RECORD WAS EXTENDED TO
   * CARRY.** `_current` and `_why` are read into `current` and `currentWhy`; a
   * writer handing the parsed shape to `JSON.stringify` writes `current` and the
   * file loses `_current` -- so the next read finds no live vault, every door
   * stops offering one, and every refusal of a retired vault loses the sentence
   * naming the vault to use instead.
   */
  const onDisk = {
    _current: 'payroll-uk',
    _why: 'the note beside it, which is also deleted by a careless write',
    network: 'stagenet',
    savedAt: '2026-09-09T02:19:20.731Z',
    vaults: { 'payroll-uk': entry('payroll-uk') },
  };

  it('survives a full read-modify-write round trip with its keys intact', () => {
    const parsed = parseVaultRegistry(JSON.parse(JSON.stringify(onDisk)), 'stagenet');
    const written = JSON.parse(JSON.stringify(vaultRegistryForDisk(
      addVault(parsed, entry('payroll-de')))));
    expect(
      written._current,
      'RED WHEN: a deploy writes the record back without `_current`, and the live vault the '
      + 'whole default rests on is gone one deploy after it was written down',
    ).toBe('payroll-uk');
    expect(
      written._why,
      'RED WHEN: the note explaining why a live vault is recorded is deleted by the next write',
    ).toBe(onDisk._why);
    expect(
      written.current,
      'RED WHEN: the parsed spelling is written alongside the file\x27s own, so the record '
      + 'carries two keys for one fact and a later reader picks the wrong one',
    ).toBeUndefined();
    expect(Object.keys(written.vaults).sort()).toEqual(['payroll-de', 'payroll-uk']);
    /* And the loop closes: what was written reads back the same. */
    expect(parseVaultRegistry(written, 'stagenet').current).toBe('payroll-uk');
  });

  it('writes no _current or _why when the record carries neither', () => {
    const written = vaultRegistryForDisk(emptyVaultRegistry('stagenet'));
    expect(
      Object.keys(written),
      'RED WHEN: an absent live vault is written as `_current: undefined`, which JSON drops '
      + 'silently in one place and keeps in another',
    ).toEqual(['network', 'savedAt', 'vaults']);
  });
});

describe('asking whether a vault name is already taken', () => {
  const r = addVault(emptyVaultRegistry('stagenet'), entry('payroll-uk'));

  it('answers with when the existing vault was deployed, and with no address', () => {
    const taken = whenThisNameWasTaken(r, 'payroll-uk');
    expect(
      taken?.deployedAt,
      'RED WHEN: the answer stops carrying the deploy time, which is the one fact that makes '
      + 'the refusal believable to somebody who thinks the name is free',
    ).toBe('2026-08-29T10:00:00.000Z');
    /*
     * **EVERY WINDOW, NOT THE WHOLE STRING**, and this file says why at the top:
     * the failure being guarded is somebody adding "just the first eight
     * characters, for support". A check for the full 64 passes that, and it
     * passed it here until an audit tried it.
     */
    const rendered = JSON.stringify(taken) ?? '';
    for (const secret of [ADDRESS, ACCOUNT]) {
      for (let i = 0; i + 8 <= secret.length; i += 1) {
        expect(
          rendered,
          'RED WHEN: this starts handing back any part of the entry\x27s addresses, including a '
          + 'truncated one, to a caller whose question was yes or no',
        ).not.toContain(secret.slice(i, i + 8));
      }
    }
  });

  it('answers with nothing for a name no vault has', () => {
    expect(
      whenThisNameWasTaken(r, 'payroll-de'),
      'RED WHEN: a free name reads as taken, which refuses every deploy',
    ).toBeUndefined();
  });

  it('refuses a name that is not a vault name rather than answering about it', () => {
    expect(
      () => whenThisNameWasTaken(r, 'Payroll UK'),
      'RED WHEN: an unusable name is quietly answered "free", and the deploy proceeds to write '
      + 'a record key that is not a usable filename',
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * AND THE CHECK THAT THE NEXT DOOR CANNOT QUIETLY SKIP IT
 * ------------------------------------------------------------------ */

describe('which names a record gives an address', () => {
  it('answers every name recorded for the address, retired ones included, whatever the case of the hex', () => {
    let r = emptyVaultRegistry('stagenet');
    r = addVault(r, entry('payroll-a', { contractAddress: ADDRESS }));
    r = addVault(r, entry('payroll-b', { contractAddress: '8d'.repeat(32) }));
    r = { ...r, vaults: { ...r.vaults, 'payroll-a': { ...r.vaults['payroll-a']!, disposed: true } } };
    expect(namesRecordedFor(r, ADDRESS.toUpperCase()),
      'RED WHEN: a vault the record keeps is not found because it is retired or its address was written in capitals').toEqual(['payroll-a']);
    expect(namesRecordedFor(r, 'ff'.repeat(32))).toEqual([]);
  });
});

describe('nothing resolves a vault name to a vault outside this module', () => {
  /**
   * **THE FAILURE THIS EXISTS FOR IS THE ONE THAT PRODUCED IT.** Ten
   * doors turned a name into a vault; one of them checked the record's own
   * disposal flag and nine did not, and two of the nine were not even using the
   * shared parse -- they read `JSON.parse(...).vaults[name]` by hand, so a fix
   * to the parse would have missed them.
   *
   * **A RULE THE NEXT DOOR HAS TO REMEMBER IS A RULE THE NEXT DOOR WILL NOT
   * HAVE.** This is that rule with a check in front of it instead of a promise.
   */
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sourceFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
      }
    };
    for (const d of ['src', 'scripts']) walk(join(root, d));
    return out;
  };

  /**
   * **A COUNT OF NAMES IS NOT A LOOKUP, AND IT IS THE ONE READING ALLOWED.**
   * `Object.keys(<something>.vaults)` answers "how many" and "which names" and
   * hands back no entry, so it cannot reach an address. Everything else that
   * touches the map of vaults is a lookup, whatever spelling it uses -- which is
   * why this removes the allowed reading first and then refuses the WORD, rather
   * than trying to enumerate the ways of subscripting it. An audit listed five
   * spellings the first version of this missed, including
   * `Object.values(r.vaults).find(...)`.
   */
  const withoutTheAllowedReading = (text: string): string =>
    text.replace(/Object\.keys\([^()]*\.vaults\)/g, '');

  const offenders = (rx: RegExp, allowed: readonly string[]): string[] => {
    for (const a of allowed) {
      /*
       * **`'anything'.endsWith('')` IS TRUE**, so one empty entry in this list
       * silences the whole check for ever, and nothing downstream would say so.
       */
      if (a.trim() === '' || !a.endsWith('.ts') || !a.includes('/')) {
        throw new Error(`the allow-list entry ${JSON.stringify(a)} is not a directory-qualified `
          + '.ts path. An empty entry matches every file, and so does a bare suffix like ".ts" '
          + '-- either one turns this check off while leaving it looking switched on');
      }
    }
    return sourceFiles()
      .filter((f) => !allowed.some((a) => f.endsWith(a)))
      .filter((f) => rx.test(withoutTheAllowedReading(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(root.length + 1));
  };

  /** Any reach into the map of vaults that is not the counting of names. */
  const A_LOOKUP = /\.vaults\b|\[['"]vaults['"]\]|\{\s*vaults\s*[,:}]/;
  const THE_ALLOWANCE = /aReadOnlyPostMortem/;

  it('finds no hand-rolled lookup of a vault by name', () => {
    expect(
      offenders(A_LOOKUP, ['src/midnight/vault-record.ts']),
      'RED WHEN: a file starts reaching into the map of vaults itself instead of calling '
      + 'theVault, which is how two instruments stayed outside every rule the record enforces, '
      + 'including the refusal of a retired vault',
    ).toEqual([]);
  });

  it('finds the post-mortem allowance passed only where it is argued for', () => {
    /*
     * The allowance is a parameter and not an environment variable so that no
     * door can be talked past its own guard by whatever somebody types. That
     * only holds while the list of callers is short and deliberate.
     */
    expect(
      offenders(THE_ALLOWANCE, ['src/midnight/vault-record.ts', 'scripts/read-the-chain.ts']),
      'RED WHEN: a door that moves money or writes a pool starts passing the post-mortem '
      + 'allowance, turning the one refusal on the money path into an option',
    ).toEqual([]);
  });

  it('names every door that turns a vault name into a vault, and each one calls theVault', () => {
    /**
     * **THE CHECKS ABOVE ARE NEGATIVE, AND A NEGATIVE CHECK CANNOT SEE A DOOR
     * THAT STOPPED ASKING.** Rewrite any of these to resolve its vault some
     * other way and both `toEqual([])` stay green, because not indexing the map
     * is exactly what such a door would do. **So the doors are named here.**
     *
     * The rebuild door is the reason this list is written down: the refusal used
     * to live in that door's own rules file, was tested there, and the test went
     * with the function when it moved.
     */
    const doors = [
      'scripts/fund-vault.ts', 'scripts/deposit-to-vault.ts', 'scripts/pay-from-vault.ts',
      'scripts/pay-privately-from-vault.ts', 'scripts/transfer-from-vault.ts',
      'scripts/open-vault-pool.ts', 'scripts/reconcile-vault-pool.ts',
      'scripts/record-a-notes-transaction.ts', 'scripts/measure-note-index.ts',
      'scripts/read-the-chain.ts',
    ];
    for (const door of doors) {
      const text = readFileSync(join(root, door), 'utf8');
      expect(
        /\btheVault\s*\(/.test(text),
        `RED WHEN: ${door} stops resolving its vault through theVault, and a retired vault is `
        + 'accepted by that door again with the whole suite still green',
      ).toBe(true);
    }
    /* The deploy door creates a vault rather than opening one, and asks the other question. */
    expect(/\bwhenThisNameWasTaken\s*\(/.test(readFileSync(join(root, 'scripts/deploy-vault.ts'),
      'utf8'))).toBe(true);
  });

  it('finds no door written in shell reaching for a vault\x27s address', () => {
    /*
     * The pickers a person sees are shell, and they read the record to LIST
     * names. RED WHEN: one of them starts pulling a contract address out of that
     * file, where no rule in this module can reach it.
     */
    const shell = readdirSync(root).filter((n) => n.endsWith('.command'));
    /*
     * **THE SHELL PICKERS DO NOT SHIP**, so the published tree holds none of
     * them and a bare count would refuse there while passing here -- which is
     * what it did, on the first run of this file outside the working tree.
     * The guard is therefore the pair of states that are real: a tree that has
     * the pickers has many and every one is scanned, or a tree has none at all
     * and there is nothing that could offend. **A tree holding one or two is
     * neither**, and that is the walk breaking rather than a published tree.
     */
    expect(
      shell.length === 0 || shell.length > 50,
      `RED WHEN: this directory holds ${shell.length} shell picker(s) -- too few to be the `
      + 'working tree and too many to be the published one, so the scan below is looking at '
      + 'a fraction of them and reporting an empty result',
    ).toBe(true);
    const reaching = shell.filter((n) => {
      const text = readFileSync(join(root, n), 'utf8');
      return text.includes('-vaults.json') && text.includes('contractAddress');
    });
    expect(reaching, 'RED WHEN: a shell door resolves a vault address out of the record itself, '
      + 'where nothing in this module refuses a retired one').toEqual([]);
  });

  it('is looking at the files it thinks it is', () => {
    /*
     * **A CHECKER THAT SCANS NOTHING PASSES EVERYTHING**, which is the shape of
     * a guard keyed on an empty read. RED WHEN: the walk stops finding the
     * source tree -- a moved test file, a renamed directory -- and the two
     * assertions above become true of the empty set.
     */
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith('scripts/deposit-to-vault.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('src/midnight/vault-record.ts'))).toBe(true);
    expect(offenders(/theVault\b/, []).length).toBeGreaterThan(5);

    /*
     * **AND A POSITIVE CONTROL ON EACH REGEX THE TWO CHECKS ABOVE ACTUALLY
     * USE.** Those two assert an empty result. A regex that had stopped matching
     * anything at all would satisfy both for ever, and the walk being healthy
     * says nothing about that. RED WHEN: either pattern stops matching the file
     * it is known to match.
     */
    expect(
      offenders(A_LOOKUP, []),
      'RED WHEN: the lookup pattern stops matching, and the check above passes because it '
      + 'finds nothing anywhere rather than because nothing is there',
    ).toContain('src/midnight/vault-record.ts');
    expect(
      offenders(THE_ALLOWANCE, []).sort(),
      'RED WHEN: the allowance pattern stops matching, or a third file starts passing it',
    ).toEqual(['scripts/read-the-chain.ts', 'src/midnight/vault-record.ts']);

    /*
     * **AND THE PATTERN IS MEASURED AGAINST THE SPELLINGS IT EXISTS FOR**, not
     * only against the tree. Nothing in the tree is written in the four forms
     * below today, so narrowing the pattern back to the one spelling it used to
     * look for changes no result anywhere -- and the check would go on passing
     * while the rule it enforces had quietly shrunk to a third of itself.
     */
    const aLookupHoweverItIsSpelled = [
      'const e = registry.vaults[name];',
      'const e = registry.vaults?.[name];',
      'const { vaults } = registry; return vaults[name];',
      'return Object.values(registry.vaults).find((v) => v.name === name);',
      'return Object.entries(registry.vaults).find(([k]) => k === name)?.[1];',
      "return (registry as any)['vaults'][name];",
    ];
    for (const spelling of aLookupHoweverItIsSpelled) {
      expect(
        A_LOOKUP.test(withoutTheAllowedReading(spelling)),
        `RED WHEN: the pattern stops recognising "${spelling}" as reaching into the map of `
        + 'vaults, so a door written that way resolves a retired vault with the suite green',
      ).toBe(true);
    }
    /* And the one reading that is allowed stays allowed. */
    expect(A_LOOKUP.test(withoutTheAllowedReading(
      'good(`${Object.keys(registry.vaults).length} vault(s)`);'))).toBe(false);

    /* And the allow-list refuses an entry that would swallow the tree. */
    expect(() => offenders(A_LOOKUP, [''])).toThrow(/turns this check off/);
    expect(() => offenders(A_LOOKUP, ['.ts'])).toThrow(/turns this check off/);
  });
});
