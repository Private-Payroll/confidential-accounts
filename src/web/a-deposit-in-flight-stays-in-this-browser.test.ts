/**
 * **A DEPOSIT OR A PAYMENT SENT FROM THIS BROWSER, KEPT IN THIS BROWSER UNTIL
 * IT LANDS: SEALED UNDER THE SIGNER'S OWN KEY, AND ONE TAB NEVER OVERWRITES
 * ANOTHER'S.** Over the browser's own database, and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { browserDepositsInFlight, browserInFlightRecords, browserPaymentsInFlight } from './vault-page-doors.js';
import { newWrappingKeypair } from '../core/crypto.js';
import { openInFlight, sealInFlight, slotFor, type SealedInFlight } from './in-flight-on-this-device.js';

const VAULT = 'AB'.repeat(32) as never;
const OTHER_VAULT = 'cd'.repeat(32) as never;
const NONCE = '4f1a9c'.repeat(10) + '4f1a';
const TOKEN = '9d3e71'.repeat(10) + '9d3e';
const VALUE = '735192448';
const deposit = {
  coin: { nonce: NONCE as never, token: TOKEN as never, value: VALUE },
  recordedAt: 1_700_000_000_000, txRef: 'p-1-reference-q7', transactionHash: '33'.repeat(32),
};
const ada = () => ({ signerId: 'ada', wrappingSecret: newWrappingKeypair().secret });

/** Everything the browser's database holds, read raw, as anybody with this browser's files could. */
const everythingStored = async (factory: IDBFactory): Promise<unknown[]> => new Promise((resolve, reject) => {
  const req = factory.open('vault-operations-in-flight', 1);
  req.onsuccess = () => {
    const tx = req.result.transaction('sealed', 'readonly');
    const all = tx.objectStore('sealed').getAll();
    const keys = tx.objectStore('sealed').getAllKeys();
    tx.oncomplete = () => { req.result.close(); resolve([...keys.result, ...all.result]); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});

describe('a deposit or a payment on its way, in this browser', () => {
  it('IS READ BACK AS IT WAS KEPT, UNDER ANY SPELLING OF THE VAULT, AFTER A RELOAD, UNTIL IT IS FORGOTTEN', async () => {
    const factory = new IDBFactory();
    const me = ada();
    const kept = browserDepositsInFlight(me, factory);
    expect(await kept.get(VAULT)).toBeNull();
    const claim = await kept.claim(VAULT, deposit);
    expect(claim).toMatch(/^[0-9a-f]{32}$/u);
    /* A reload: a new store over the same database, the same signer's key opened again. */
    const reloaded = browserDepositsInFlight({ ...me }, factory);
    /* RED WHEN: a field is dropped on the way in, so the follow-up asks the chain for the wrong coin or transaction. */
    expect(await reloaded.get(('ab'.repeat(32)) as never), 'RED WHEN: a reload reads nothing, or one spelling of the vault misses the other')
      .toEqual({ ...deposit, claim });
    await kept.update(VAULT, claim!, { ...deposit, txRef: 'p-2', transactionHash: null });
    expect(await kept.get(VAULT), 'RED WHEN: an update under the record\'s own claim does not replace it').toMatchObject({ txRef: 'p-2', transactionHash: null });
    await kept.forget(VAULT, claim!);
    expect(await kept.get(VAULT), 'RED WHEN: a deposit that is settled is still kept').toBeNull();
  });

  it('TWO TABS CANNOT OVERWRITE OR FORGET EACH OTHER\'S RECORD', async () => {
    const factory = new IDBFactory();
    const me = ada();
    const [tabA, tabB] = [browserDepositsInFlight(me, factory), browserDepositsInFlight(me, factory)];
    const claims = await Promise.all([
      tabA.claim(VAULT, deposit),
      tabB.claim(VAULT, { ...deposit, coin: { ...deposit.coin, nonce: '5e'.repeat(32) as never } }),
    ]);
    /* RED WHEN: keeping a record is a plain put - both tabs then answer a claim, and the second overwrites the first. */
    expect(claims.filter((c) => c !== null), 'RED WHEN: two tabs both keep a record for one vault').toHaveLength(1);
    const won = claims.find((c) => c !== null)!;
    const lost = 'f0'.repeat(16);
    const standing = await tabA.get(VAULT);
    await tabB.update(VAULT, lost, { ...deposit, txRef: 'not mine' });
    await tabB.forget(VAULT, lost);
    /* RED WHEN: an update or a forget ignores the claim - another tab's settle then replaces or drops this one's record. */
    expect(await tabA.get(VAULT), 'RED WHEN: a tab changes or forgets a record it did not keep').toEqual(standing);
    expect(standing?.claim).toBe(won);
    /* A deposit and a payment for one vault are kept apart. */
    const payments = browserPaymentsInFlight(me, factory);
    const paying = await payments.claim(VAULT, {
      spent: { nonce: '61'.repeat(32) as never, token: TOKEN as never, value: '10' }, amount: '4', change: null,
      recordedAt: 1, txRef: '', transactionHash: null,
    });
    expect(paying, 'RED WHEN: a payment and a deposit share one place, and one refuses the other').not.toBeNull();
  });

  it('KEEPS NOTHING ABOUT THE DEPOSIT IN THE CLEAR: NOT ITS NONCE, ITS TOKEN, ITS AMOUNT, ITS VAULT OR ITS TRANSACTION', async () => {
    const factory = new IDBFactory();
    const me = ada();
    const kept = browserDepositsInFlight(me, factory);
    await kept.claim(VAULT, deposit);
    await kept.claim(OTHER_VAULT, { ...deposit, txRef: 'p-9-reference-q7' });
    /* And a payment on its way, which names the note it spends, the amount and the change it gives back. */
    const SPENT_NONCE = '2b7c5e'.repeat(10) + '2b7c';
    const CHANGE_NONCE = '6d18a4'.repeat(10) + '6d18';
    await browserPaymentsInFlight(me, factory).claim(VAULT, {
      spent: { nonce: SPENT_NONCE as never, token: TOKEN as never, value: '918273645' }, amount: '546372819',
      change: { nonce: CHANGE_NONCE, token: TOKEN, value: '371900826' }, recordedAt: 1, txRef: 'o-4-reference-q7', transactionHash: null,
    });
    const stored = JSON.stringify(await everythingStored(factory));
    /* And every hex string in it read back as text, since a record could carry its fields hex-encoded. */
    const decoded = (stored.match(/[0-9a-f]{16,}/giu) ?? []).map((h) => Buffer.from(h.length % 2 === 0 ? h : h.slice(1), 'hex').toString('latin1'));
    const raw = [stored, ...decoded].join('\n').toLowerCase();
    expect(raw.length, 'something is kept').toBeGreaterThan(200);
    /* The controls: each of these is what an unsealed record, kept under its vault, would carry. */
    const unsealed = JSON.stringify({ [String(VAULT)]: deposit, payment: {
      spent: { nonce: SPENT_NONCE, value: '918273645' }, amount: '546372819', change: { nonce: CHANGE_NONCE, value: '371900826' },
      txRef: 'o-4-reference-q7' } }).toLowerCase();
    for (const [name, needle] of [['nonce', NONCE], ['token', TOKEN], ['amount', VALUE], ['vault', 'ab'.repeat(32)],
      ['transaction', '33'.repeat(32)], ['reference', 'p-1-reference-q7'], ['note a payment spends', SPENT_NONCE],
      ['value of the note it spends', '918273645'], ['amount paid', '546372819'], ['change', CHANGE_NONCE],
      ['value of the change', '371900826'], ['payment reference', 'o-4-reference-q7']] as const) {
      expect(unsealed.includes(needle), `the control cannot see the ${name}`).toBe(true);
      /* RED WHEN: the record is stored without its seal, or with any of these beside it, or keyed by the vault. */
      expect(raw.includes(needle), `the ${name} is kept in the clear`).toBe(false);
    }
  });

  it('OPENS ONLY FOR THE SIGNER WHO KEPT IT, ONLY FOR ITS OWN VAULT AND KIND', async () => {
    const me = ada();
    const sealed = sealInFlight(me, 'deposit', VAULT, deposit);
    expect(openInFlight(me, 'deposit', VAULT, sealed)).toEqual(deposit);
    /* RED WHEN: the key is not the signer's own - another signer on this browser opens it. */
    expect(openInFlight({ signerId: 'ada', wrappingSecret: newWrappingKeypair().secret }, 'deposit', VAULT, sealed)).toBeNull();
    expect(openInFlight({ ...me, signerId: 'bo' }, 'deposit', VAULT, sealed), 'RED WHEN: the seat is not bound into the key').toBeNull();
    /* RED WHEN: the vault or the kind is not bound into the seal - a record moved to another slot opens there. */
    expect(openInFlight(me, 'deposit', OTHER_VAULT, sealed)).toBeNull();
    expect(openInFlight(me, 'payment', VAULT, sealed)).toBeNull();
    expect(openInFlight(me, 'deposit', VAULT, { ...sealed, claim: 'f1'.repeat(16) } as SealedInFlight), 'RED WHEN: the claim is not bound').toBeNull();
    /* Every slot is the signer's own: two signers, two vaults and two kinds never share one. */
    const bo = { signerId: 'bo', wrappingSecret: newWrappingKeypair().secret };
    const slots = new Set([slotFor(me, 'deposit', VAULT), slotFor(bo, 'deposit', VAULT), slotFor(me, 'deposit', OTHER_VAULT), slotFor(me, 'payment', VAULT)]);
    expect(slots.size).toBe(4);
    expect(slotFor(me, 'deposit', ('ab'.repeat(32)) as never)).toBe(slotFor(me, 'deposit', VAULT));
    expect(() => sealInFlight({ signerId: 'ada', wrappingSecret: '' }, 'deposit', VAULT, deposit), 'RED WHEN: a record is sealed with no key')
      .toThrow(/keys for this company are not open on this device/);
  });

  it('A RECORD THE SIGNER\'S KEY DOES NOT OPEN IS NOT READ AS ONE, AND A NEW DEPOSIT TAKES ITS PLACE', async () => {
    const factory = new IDBFactory();
    const me = ada();
    const records = browserInFlightRecords(factory);
    const slot = slotFor(me, 'deposit', VAULT);
    await records.add(slot, { claim: 'aa'.repeat(16), iv: '00'.repeat(12), body: '11'.repeat(40) });
    const kept = browserDepositsInFlight(me, factory);
    expect(await kept.get(VAULT)).toBeNull();
    /* RED WHEN: an unreadable record blocks every deposit from this browser into this vault, for ever. */
    expect(await kept.claim(VAULT, deposit)).not.toBeNull();
    expect(await kept.get(VAULT)).toMatchObject({ coin: deposit.coin });
  });
});
