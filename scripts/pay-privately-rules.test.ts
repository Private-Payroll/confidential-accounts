import { describe, it, expect } from 'vitest';

import {
  assertPrivatePayee, assertVaultCanPayPrivately, theAssetPaidPrivately,
  checkTheColourWasMinted, whetherANoteCanBeSpent, assertANoteCanBeSpent, linesAboutNotesPassedOver,
  vaultNonceSecretOf,
} from './pay-privately-rules.js';
import { newWrappingKeypair } from '../src/core/crypto.js';
import { openNonceSecrets, rotateNonceSecret, startNonceSecret } from '../src/midnight/company-nonce-secret.js';
import { noteToSpend, paymentsFit } from '../src/midnight/vault-notes.js';
import type { Hex } from '../src/core/crypto.js';
import { StaticAssetRegistry, assets as productAssets, type Asset } from '../src/core/assets.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';
import type { Note } from '../src/midnight/vault-notes.js';
import { payeeFor, unshieldedPayeeFor } from '../src/testing/payees.js';
import { NETWORK } from 'midnight-identity/network';

/**
 * **THE RULES OF THE DOOR THAT MAKES THE FIRST PRIVATE PAYMENT, DRIVEN WITHOUT
 * A CHAIN.**
 *
 * The door itself proves, submits and spends, so it is not run here. What is
 * run is every rule it applies before the first fee - which is the half that
 * decides whether a run that cannot end in a payment begins with two of them.
 */

const COLOUR = 'ab'.repeat(32);
const OTHER_COLOUR = 'cd'.repeat(32);

const entryWith = (circuits: string[]): VaultEntry => ({
  name: 'payroll-test', contractAddress: 'ab'.repeat(32), accountAddress: 'cd'.repeat(32),
  deployedAt: '2026-09-09T00:00:00.000Z', circuits,
} as VaultEntry);

const note = (over: Partial<Note>): Note => ({
  nonce: '01'.repeat(32), token: COLOUR, value: 1_000n, ...over,
} as Note);

describe('who may be paid, and out of what', () => {
  it('takes a private address and hands it straight back', () => {
    const payee = payeeFor('a1'.repeat(32), NETWORK);
    /* RED WHEN the door stops accepting the only kind of address it can pay. */
    expect(assertPrivatePayee(payee)).toBe(payee);
  });

  it('REFUSES a public address, and says where a public payment goes instead', () => {
    /*
     * RED WHEN a public address is accepted. A note is sent to a shielded coin
     * key; a public address has none, so this would be discovered by the
     * circuit after a proposal and its approvals had been paid for.
     */
    expect(() => assertPrivatePayee(unshieldedPayeeFor('c3'.repeat(32), NETWORK)))
      .toThrow('that is a public address');
    /* RED WHEN the refusal stops naming what the reader can do instead (rule 19's shape). */
    expect(() => assertPrivatePayee(unshieldedPayeeFor('c3'.repeat(32), NETWORK)))
      .toThrow(/different circuit and a different door/);
  });

  it('REFUSES a vault whose record does not carry the private circuit, and lists what it has', () => {
    /* RED WHEN a vault deployed before the private path is accepted. */
    expect(() => assertVaultCanPayPrivately(entryWith(['deposit', 'payoutUnshielded'])))
      .toThrow('does not list payout');
    expect(() => assertVaultCanPayPrivately(entryWith(['deposit', 'payoutUnshielded'])))
      .toThrow('deposit, payoutUnshielded');
    /* RED WHEN a record with no circuits at all prints nothing where the list goes. */
    expect(() => assertVaultCanPayPrivately(entryWith([]))).toThrow('(nothing)');
    /* RED WHEN it stops saying a vault cannot be given a circuit later, which is the actionable half. */
    expect(() => assertVaultCanPayPrivately(entryWith([]))).toThrow(/cannot be given another/);
  });

  it('lets a vault that carries payout through', () => {
    /* RED WHEN the check refuses a vault that can in fact pay, which refuses every private payment. */
    expect(() => assertVaultCanPayPrivately(entryWith(['deposit', 'payout', 'retire']))).not.toThrow();
  });
});

describe('which asset a private payment moves, and it is not asked for', () => {
  const THIRD_COLOUR = 'ef'.repeat(32);
  /** A row for the token `code`, called `symbol`, in the forms given: each form is the token itself. */
  const row = (symbol: string, code: string, forms: ReadonlyArray<'shielded' | 'unshielded'>, over: Partial<Asset> = {}): Asset => ({
    code, symbol, name: symbol, decimals: 6,
    ledger: { shielded: forms.includes('shielded') ? code : null, unshielded: forms.includes('unshielded') ? code : null },
    enabled: true, sortOrder: 1, ...over,
  });

  it('takes the one enabled asset that has a private form', () => {
    const registry = new StaticAssetRegistry([
      row('ZZA', COLOUR, ['shielded']),
      row('ZZB', OTHER_COLOUR, ['unshielded']),
      row('ZZC', THIRD_COLOUR, ['unshielded']),
    ]);
    /* RED WHEN it picks by anything but the row's own private token. */
    expect(theAssetPaidPrivately(registry).symbol).toBe('ZZA');
  });

  it('REFUSES when none has one, rather than substituting anything', () => {
    const registry = new StaticAssetRegistry([row('ZZC', THIRD_COLOUR, ['unshielded'])]);
    /* RED WHEN a registry with no private asset yields something anyway. */
    expect(() => theAssetPaidPrivately(registry)).toThrow('no asset in this registry has a private form');
    expect(() => theAssetPaidPrivately(registry)).toThrow(/nothing is substituted/);
  });

  it('REFUSES when more than one has one, and will not pick', () => {
    const registry = new StaticAssetRegistry([
      row('ZZA', COLOUR, ['shielded']),
      row('ZZB', OTHER_COLOUR, ['shielded']),
    ]);
    /*
     * RED WHEN it picks the first of two. Which token somebody's pay settles
     * in is a decision, and picking would make it by sort order.
     */
    expect(() => theAssetPaidPrivately(registry)).toThrow('2 assets have a private form');
    expect(() => theAssetPaidPrivately(registry)).toThrow('ZZA, ZZB');
  });

  it('PASSES OVER a disabled asset that has one, because a disabled asset cannot be chosen', () => {
    const registry = new StaticAssetRegistry([
      row('ZZA', COLOUR, ['shielded'], { enabled: false }),
      row('ZZB', OTHER_COLOUR, ['shielded']),
    ]);
    /* RED WHEN a disabled row is settled in, which is an asset the product says may not be used. */
    expect(theAssetPaidPrivately(registry).symbol).toBe('ZZB');
  });

  it('answers for the product registry as it stands, so this door has an asset at all', () => {
    /* RED WHEN the product registry stops having exactly one privately-payable asset. */
    expect(theAssetPaidPrivately(productAssets).ledger.shielded).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the colour in the registry against the colour a mint made', () => {
  it('agrees when they are the same value, however either is spelt', () => {
    /* RED WHEN the comparison becomes case- or prefix-sensitive and refuses a value that matches. */
    expect(checkTheColourWasMinted(COLOUR, { colour: COLOUR.toUpperCase() })).toEqual({ of: 'agrees' });
  });

  it('REFUSES when they differ, and prints neither', () => {
    let thrown: Error | null = null;
    try { checkTheColourWasMinted(COLOUR, { colour: OTHER_COLOUR }); } catch (e) { thrown = e as Error; }
    /*
     * RED WHEN a registry naming a colour nothing minted is allowed through. No
     * note can fund that payment, and it is found after the approvals and the
     * fees rather than before them.
     */
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain('not the colour the mint on this machine recorded');
    /* RED WHEN either value is printed. A colour is money's name and the screen guard is not the only rule. */
    expect(thrown!.message).not.toContain(COLOUR);
    expect(thrown!.message).not.toContain(OTHER_COLOUR);
  });

  it('SAYS IT COULD NOT CHECK rather than passing, when there is no record to check against', () => {
    for (const [what, record] of [
      ['no record at all', null],
      ['a record with no colour', {}],
      ['a colour of the wrong length', { colour: 'ab' }],
      ['a colour that is not hex', { colour: 'zz'.repeat(32) }],
    ] as const) {
      const answer = checkTheColourWasMinted(COLOUR, record as { colour?: unknown } | null);
      /*
       * RED WHEN an absent record reads as agreement. The check is a check and
       * not a source: not being able to make it is a different answer from
       * having made it and found the two equal.
       */
      expect(answer.of, what).toBe('not-checked');
    }
  });
});

describe('whether a note can be spent at all, asked before the first fee', () => {
  it('says spendable when one note of the colour is big enough AND records its transaction', () => {
    const notes = [note({ createdIn: 'ef'.repeat(32) as Note['createdIn'] })];
    /* RED WHEN a perfectly spendable note is refused, which refuses every private payment. */
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_000n)).toMatchObject({ of: 'spendable', passedOver: [] });
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD')).not.toThrow();
  });

  it('NOTES ARE NOT MERGED: two that add up to enough are not enough', () => {
    const notes = [
      note({ nonce: '01'.repeat(32), value: 600n, createdIn: 'ef'.repeat(32) as Note['createdIn'] }),
      note({ nonce: '02'.repeat(32), value: 600n, createdIn: 'ef'.repeat(32) as Note['createdIn'] }),
    ];
    /*
     * RED WHEN the rule starts adding notes up. A private payment spends ONE
     * note; a check that summed them would pass a payment the circuit refuses.
     */
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_000n)).toEqual({ of: 'nothing-big-enough' });
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD'))
      .toThrow(/made out of ONE note/);
    /* RED WHEN the refusal stops saying what to do about it. */
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD'))
      .toThrow(/deposit large enough, or pay a smaller amount/);
  });

  it('IGNORES notes of another colour, however large', () => {
    const notes = [note({ token: OTHER_COLOUR, value: 1n << 60n, createdIn: 'ef'.repeat(32) as Note['createdIn'] })];
    /* RED WHEN colour stops being compared, which would pay in money the vault does not hold. */
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_000n)).toEqual({ of: 'nothing-big-enough' });
  });

  it('SAYS STRANDED, DIFFERENTLY, when the only big enough note records no transaction', () => {
    const notes = [note({ nonce: '0a'.repeat(32) })];
    const verdict = whetherANoteCanBeSpent(notes, COLOUR, 1_000n);
    /*
     * RED WHEN the two refusals become one. One needs money put in; the other
     * needs a transaction recorded against money already there, and a single
     * "cannot pay" sends half its readers to do the wrong thing.
     */
    expect(verdict.of).toBe('stranded');
    expect(verdict.of === 'stranded' && verdict.nonces).toEqual(['0a'.repeat(32)]);
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD'))
      .toThrow(/does not record which transaction created it/);
    /* RED WHEN the refusal implies the money is gone. It is on chain and it is the vault's. */
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD'))
      .toThrow(/nothing is lost/);
    /* RED WHEN the note it is about is not named, leaving a person to guess which one to repair. */
    expect(() => assertANoteCanBeSpent(notes, COLOUR, 1_000n, 'tUSD'))
      .toThrow('0a'.repeat(32));
  });

  it('is SPENDABLE when one big enough note is stranded and another is not, and NAMES the stranded one', () => {
    const notes = [
      note({ nonce: '0a'.repeat(32) }),
      note({ nonce: '0b'.repeat(32), createdIn: 'ef'.repeat(32) as Note['createdIn'] }),
    ];
    /*
     * RED WHEN the answer is about the pool rather than about the notes this
     * payment could draw on. A vault holding one unrecorded note and one
     * recorded one CAN make the payment, and refusing it would be wrong.
     */
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_000n))
      .toEqual({ of: 'spendable', nonce: '0b'.repeat(32), passedOver: ['0a'.repeat(32)] });
    const lines = linesAboutNotesPassedOver(whetherANoteCanBeSpent(notes, COLOUR, 1_000n), 'tUSD');
    /* RED WHEN the door goes quiet about money on chain that a payment cannot reach. */
    expect(lines, 'RED WHEN: the door says nothing about a note the payment passed over').toHaveLength(2);
    expect(lines[0]).toMatch(/1 other note of tUSD large enough for this payment is the vault's and on chain, and a payment cannot spend it yet/);
    expect(lines[0], 'RED WHEN: the line names nothing a person can do').toMatch(/What resolves it: record the transaction that paid it in against the note, or rebuild the pool/);
    expect(lines.slice(1)).toEqual([`  ${'0a'.repeat(32)}`]);
    expect(linesAboutNotesPassedOver({ of: 'spendable', nonce: 'x', passedOver: [] }, 'tUSD')).toEqual([]);
    expect(linesAboutNotesPassedOver({ of: 'nothing-big-enough' }, 'tUSD')).toEqual([]);
    expect(linesAboutNotesPassedOver({ of: 'spendable', nonce: 'x', passedOver: ['a', 'b'] }, 'tUSD')[0])
      .toMatch(/^2 other notes of tUSD .* are the vault's and on chain, and a payment cannot spend them yet: no transaction that created them is recorded\. This payment does not use them\. .*paid each one in/);
  });

  it('THE CHECK BEFORE THE FIRST FEE AND THE PAYMENT CHOOSE THE SAME NOTE, for the pool the pre-flight used to pass and the spend refused', () => {
    /*
     * A small note with no recorded transaction beside a larger one that has
     * one. The pre-flight used to say spendable because ANY covering note was
     * recorded, while the payment chose the SMALLEST covering note and refused
     * it at the spend - after the proposal and its approvals had been paid for.
     */
    const small = note({ nonce: '0a'.repeat(32), value: 1_200n });
    const large = note({ nonce: '0b'.repeat(32), value: 9_000n, createdIn: 'ef'.repeat(32) as Note['createdIn'] });
    const pools: Note[][] = [
      [small, large], [large, small], [small], [large],
      [note({ nonce: '0c'.repeat(32), value: 1_000n, createdIn: 'nope' as Note['createdIn'] }), large],
      [note({ nonce: '0c'.repeat(32), value: 1_000n, createdIn: 'nope' as Note['createdIn'] })],
      [note({ value: 999n, createdIn: 'ef'.repeat(32) as Note['createdIn'] })],
    ];
    for (const notes of pools) {
      const verdict = whetherANoteCanBeSpent(notes, COLOUR, 1_000n);
      let paid: string | undefined;
      try { paid = noteToSpend(notes, COLOUR as Hex, 1_000n).nonce; } catch { paid = undefined; }
      let fits = true;
      try { paymentsFit({ notes }, [{ token: COLOUR as Hex, amount: 1_000n }]); } catch { fits = false; }
      expect(
        verdict.of === 'spendable' ? verdict.nonce : undefined,
        `RED WHEN: the pre-flight and the payment answer differently for ${notes.map((n) => n.nonce.slice(0, 2)).join('+')}`,
      ).toBe(paid);
      expect(fits, 'RED WHEN: the affordability walk answers differently from the pre-flight').toBe(verdict.of === 'spendable');
    }
    /* Spelt differently from the pool's own colour, the pre-flight says what the payment would: no such notes. */
    expect(
      whetherANoteCanBeSpent([large], ` ${COLOUR.toUpperCase()} `, 1_000n),
      'RED WHEN: the pre-flight normalises a colour the payment compares exactly, and passes a run the spend refuses',
    ).toEqual({ of: 'nothing-big-enough' });
  });

  it('says nothing-big-enough for an empty pool, and never stranded', () => {
    /* RED WHEN an empty pool is reported as a repair somebody could make. There is nothing to repair. */
    expect(whetherANoteCanBeSpent([], COLOUR, 1n)).toEqual({ of: 'nothing-big-enough' });
  });

  it('takes a note worth EXACTLY the amount, which is the boundary the circuit takes', () => {
    const notes = [note({ value: 1_000n, createdIn: 'ef'.repeat(32) as Note['createdIn'] })];
    /* RED WHEN the comparison becomes strictly greater, refusing an exact payment the vault can make. */
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_000n)).toMatchObject({ of: 'spendable' });
    expect(whetherANoteCanBeSpent(notes, COLOUR, 1_001n)).toEqual({ of: 'nothing-big-enough' });
  });
});

describe('the vault\'s nonce secret, which every private payment makes its coins under', () => {
  const VAULT_ADDRESS = 'ab'.repeat(32);
  const ada = newWrappingKeypair();
  const bo = newWrappingKeypair();
  const record = startNonceSecret(VAULT_ADDRESS, [{ publicKey: ada.publicKey }, { publicKey: bo.publicKey }]);

  it('opens the company\'s record as the signer this machine holds, and hands back its newest secret', () => {
    const secret = vaultNonceSecretOf(record, 'the record', VAULT_ADDRESS, { wrappingSecret: ada.secret });
    /* RED WHEN the payment is handed anything but the secret the company's record holds now. */
    expect(secret).toBe(openNonceSecrets(record, VAULT_ADDRESS, ada).secrets[0]);
    const rotated = rotateNonceSecret(record, VAULT_ADDRESS, ada, { remaining: [{ publicKey: ada.publicKey }], leaving: [{ publicKey: bo.publicKey }] });
    const newest = openNonceSecrets(rotated, VAULT_ADDRESS, ada).secrets;
    /* RED WHEN an earlier epoch's secret is handed over after a rotation: the vault refuses coins made under it. */
    expect(newest).toHaveLength(2);
    expect(vaultNonceSecretOf(rotated, 'the record', VAULT_ADDRESS, { wrappingSecret: ada.secret })).toBe(newest[1]);
  });

  it('REFUSES by name, before any fee, when there is no record, it is another vault\'s, or it is not wrapped to this signer', () => {
    /* RED WHEN a missing record is passed over and the payment is built without the secret. */
    expect(() => vaultNonceSecretOf(null, '.midnight/stagenet-vault-nonce-secret-payroll.json', VAULT_ADDRESS, { wrappingSecret: ada.secret }))
      .toThrow(/this vault has no nonce secret on this machine: \.midnight\/stagenet-vault-nonce-secret-payroll\.json does not exist/);
    /* RED WHEN a record filed for another vault is opened for this one. */
    expect(() => vaultNonceSecretOf(record, 'the record', 'cd'.repeat(32), { wrappingSecret: ada.secret }))
      .toThrow(/filed for a different vault/);
    /* RED WHEN a signer with no copy is handed a secret anyway. */
    expect(() => vaultNonceSecretOf(record, 'the record', VAULT_ADDRESS, { wrappingSecret: newWrappingKeypair().secret }))
      .toThrow(/no copy is wrapped to this signer/);
  });
});
