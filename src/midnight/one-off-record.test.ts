import { describe, it, expect } from 'vitest';
import { newSymmetricKey, unseal, type Hex } from '../core/crypto.js';
import { purposeKey } from '../core/sealed-records.js';
import { toCompanyWire, whyThisIsNotACompanyRecord } from './sealed-record-wire.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import {
  newOneOffId, newOneOffSeed, ONE_OFF_KIND, ONE_OFF_SEALED_BYTES, OneOffRefused, openOneOff, oneOffTidied, sealOneOff,
  type OneOffGiven,
} from './one-off-record.js';

const NET = 'undeployed' as const;
const REGISTRY = registryWithTestPrivateForms();
/* The company's key at epoch 0, which every signer's device holds. */
const KEY = newSymmetricKey();
const ID = newOneOffId();
const PRIVATELY = payeeFor('a1'.repeat(32), NET).bech32;
const PUBLICLY = unshieldedPayeeFor('b1'.repeat(32), NET).bech32;

const given = (o: Partial<OneOffGiven> = {}): OneOffGiven => ({
  vault: 'fa'.repeat(32) as Hex, asset: TEST_TOKEN, amount: 123_456n, form: 'private',
  payee: { ref: null, name: 'Northwind Paper Ltd', address: PRIVATELY, network: NET },
  reason: 'Invoice 2026-118, office paper',
  proposal: { id: 'prp_ABCDEFGHIJKL', chainId: 'c4'.repeat(32) as Hex },
  run: { opensAt: 1_000n, closesAt: 2_000n, required: 0n },
  seed: newOneOffSeed(),
  ...o,
});
const sealed = (g: OneOffGiven = given(), id = ID) => sealOneOff({ company: 'acme', id, keyEpoch: 0, key: KEY, given: g, registry: REGISTRY });

describe('A ONE-OFF PAYMENT FROM A VAULT, KEPT AS A RECORD OF THE COMPANY\'S OF ITS OWN KIND', () => {
  it('EVERY DEVICE HOLDING THE COMPANY\'S KEY OPENS IT, UNDER ITS OWN PURPOSE, AND NO OTHER KEY DOES', () => {
    const g = given();
    const rec = sealed(g);
    expect(rec.kind).toBe(ONE_OFF_KIND);
    /* RED WHEN: a one-off carries wraps beside its purpose seal, a second answer to who may read it. */
    expect(rec.wrapped).toEqual([]);
    expect(whyThisIsNotACompanyRecord(JSON.parse(JSON.stringify(rec)), { company: 'acme', kind: ONE_OFF_KIND, id: ID })).toBeNull();
    const opened = openOneOff(rec, KEY, REGISTRY);
    /* RED WHEN: a holder of the company's key reads another amount, payee, reason, proposal, window or seed than the one sealed. */
    expect({ ...opened, paidTo: undefined, form: undefined, token: undefined }).toEqual({ ...g, form: undefined, paidTo: undefined, token: undefined });
    expect(opened.form).toBe('private');
    expect(opened.paidTo.kind).toBe('shielded');
    /* RED WHEN: a key that is not the company's opens it. */
    expect(() => openOneOff(rec, newSymmetricKey(), REGISTRY)).toThrow(OneOffRefused);
    /* RED WHEN: it is sealed under the company's key itself, or under payroll's purpose, not one-offs' own. */
    for (const other of [KEY, purposeKey(KEY, 'acme', 'payroll'), purposeKey(KEY, 'acme', 'vaults')]) expect(() => unseal(rec.sealed, other)).toThrow();
    expect(() => unseal(rec.sealed, purposeKey(KEY, 'acme', 'one-offs'))).not.toThrow();
  });

  it('REFUSES WHAT IS SEALED INSIDE IT WHEN IT SAYS IT IS ANOTHER RECORD, COMPANY OR VERSION', () => {
    const rec = sealed();
    const me = KEY;
    /* RED WHEN: a sealed body is believed under another id than the one it was sealed for. */
    expect(() => openOneOff({ ...rec, id: newOneOffId() }, me, REGISTRY)).toThrow(/says it is another record/u);
    /* RED WHEN: a sealed body is believed for another company. */
    expect(() => openOneOff({ ...rec, company: 'globex' }, me, REGISTRY)).toThrow(/another record|does not open/u);
    /* RED WHEN: a sealed body is believed as a later version than the one it was sealed as. */
    expect(() => openOneOff({ ...rec, version: 2 }, me, REGISTRY)).toThrow(/says it is another record/u);
    /* RED WHEN: a record of another kind is opened as a one-off. */
    expect(() => openOneOff({ ...rec, kind: 'spending-policy' }, me, REGISTRY)).toThrow(/not a one-off payment/u);
  });

  it('IS SEALED AT ONE SIZE, WHATEVER ITS NAME, ADDRESS AND REASON', () => {
    const short = sealed(given({ payee: { ref: null, name: null, address: PUBLICLY, network: NET }, form: 'public', reason: 'x', amount: 1n }));
    const long = sealed(given({ payee: { ref: null, name: 'N'.repeat(128), address: PRIVATELY, network: NET }, reason: 'R'.repeat(500), amount: (1n << 127n) }));
    /* RED WHEN: the sealed body's length follows the payee's name, address or the reason, so the service learns their size. */
    expect(short.sealed.body.length).toBe(long.sealed.body.length);
    expect(ONE_OFF_SEALED_BYTES).toBeGreaterThan(4 * (128 + 500));
  });

  it('IS PAID THE WAY ITS ADDRESS SAYS, IN A CURRENCY THAT HAS THAT FORM, TO A PAYEE NAMED BY THE ADDRESS ALONE FOR NOW', () => {
    /* RED WHEN: a one-off set to private is sealed with a public address (the address decides the form). */
    expect(() => oneOffTidied(given({ form: 'private', payee: { ref: null, name: null, address: PUBLICLY, network: NET } }), REGISTRY))
      .toThrow(/set to private and the address is a public one/u);
    expect(() => oneOffTidied(given({ form: 'public' }), REGISTRY)).toThrow(/set to public and the address is a private one/u);
    expect(oneOffTidied(given({ form: 'public', payee: { ref: null, name: null, address: PUBLICLY, network: NET } }), REGISTRY).paidTo.kind).toBe('unshielded');
    /* RED WHEN: a vendor entry is named before the vendor list exists to name it. */
    expect(() => oneOffTidied(given({ payee: { ref: 'vnd_1' as never, name: null, address: PRIVATELY, network: NET } }), REGISTRY))
      .toThrow(/vendor/u);
    /* RED WHEN: nothing, or less than nothing, is paid. */
    expect(() => oneOffTidied(given({ amount: 0n }), REGISTRY)).toThrow(/positive amount/u);
    /* RED WHEN: a one-off is kept with no reason to recognise it by. */
    expect(() => oneOffTidied(given({ reason: '  ' }), REGISTRY)).toThrow(/reason/u);
    /* RED WHEN: a window that closes before it opens is kept. */
    expect(() => oneOffTidied(given({ run: { opensAt: 5n, closesAt: 5n, required: 0n } }), REGISTRY)).toThrow(/window/u);
    /* RED WHEN: a seed that is not 32 bytes is kept, so its secrets could not be made again. */
    expect(() => oneOffTidied(given({ seed: 'ab' as Hex }), REGISTRY)).toThrow(/seed/u);
    /* RED WHEN: a record id that could carry a name is filed: the id is in the clear on every path. */
    expect(() => sealed(given(), 'northwind-paper')).toThrow(/id/u);
  });

  it('THE RECORD AS FILED CARRIES NO AMOUNT, NAME, ADDRESS OR REASON IN THE CLEAR', () => {
    const g = given({ amount: 987_654_321n });
    const wire = toCompanyWire(sealed(g));
    /* RED WHEN: any of what is paid, to whom or why reaches the service readable. */
    for (const plain of ['987654321', 'Northwind', PRIVATELY, 'Invoice 2026-118', g.seed, 'c4'.repeat(32)]) {
      expect(wire.body.includes(plain), plain).toBe(false);
    }
  });
});
