// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider, languagesFrom, privateAmount, publicAmount } from 'vaults-ui';
import type { RunLeg } from '../adapters/company-records.js';
import { ENGLISH } from '../english.test-support.js';
import { PublicFacts } from './public-facts.js';

/*
 * WHAT A PAYMENT MAKES PUBLIC, shown before it is paid: for a private payment how many people are paid and which vault and
 * account the network shows, and what it still lets a watcher work out; for a public one also every address and amount.
 */
const EN = ENGLISH;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const TOKEN = '00'.repeat(32);
const VAULT = 'ab'.repeat(32);
const leg = (over: Partial<RunLeg> = {}): RunLeg => ({
  code: `${TOKEN}:shielded`, asset: TOKEN, symbol: 'NIGHT', paid: 'privately', vault: VAULT, payees: 2, proposal: 'p1', form: 'shielded', list: 'employees', people: 2, total: 7_000_000n,
  pays: [
    { name: 'Ana', address: 'mn_shield-addr_ana', amount: privateAmount(5_000_000n, 6, 'NIGHT') },
    { name: 'Bo', address: 'mn_shield-addr_bo', amount: privateAmount(2_000_000n, 6, 'NIGHT') },
  ],
  ...over,
});
const PUBLIC = (): RunLeg => leg({
  code: `${TOKEN}:unshielded`, paid: 'publicly', form: 'unshielded', people: 2,
  pays: [
    { name: 'Ana', address: 'mn_addr_ana', amount: publicAmount(5_000_000n, 6, 'NIGHT') },
    { name: 'Bo', address: 'mn_addr_bo', amount: publicAmount(2_500_000n, 6, 'NIGHT') },
  ],
});
const draw = (l: RunLeg, payment = false) => render(<KitProvider languages={LANGUAGES} pick="en"><PublicFacts leg={l} vaultName="Vault 3" payment={payment} /></KitProvider>).container;
const q = (c: ParentNode, s: string) => c.querySelector(s) as HTMLElement | null;
const all = (c: ParentNode, s: string) => [...c.querySelectorAll(s)] as HTMLElement[];
afterEach(cleanup);

describe('a private payment', () => {
  /* RED WHEN: a private payment's facts leave out the number of people paid, the vault, or the payments count, or name an address or an amount the network does not show. */
  it('says how many people are paid, the vault and account the network shows and the payments count, and shows no address or amount', () => {
    const c = draw(leg());
    expect(q(c, '[data-fact=count]')!.textContent).toBe(EN['publicFacts.count_other']!.replace('{count}', '2'));
    expect(q(c, '[data-fact=vault]')!.textContent).toBe(EN['publicFacts.vault']!.replace('{vault}', 'Vault 3'));
    expect(q(c, '[data-fact=counter]')!.textContent).toBe(EN['publicFacts.counter']);
    expect(q(c, '[data-fact=hidden]')!.textContent).toBe(EN['publicFacts.private.hidden']);
    expect(all(c, '[data-public-pay]')).toEqual([]);
    expect(c.textContent).not.toMatch(/mn_shield|Ana|Bo\b|5\b/);
  });

  /* RED WHEN: a screen promises more privacy than the settlement delivers: the facts do not say a watcher who has seen the vault's earlier payments can still work out who was paid, or that a spending policy shows the band. */
  it('does not promise more privacy than the settlement gives', () => {
    const c = draw(leg());
    expect(q(c, '[data-fact=inference]')!.textContent).toBe(EN['publicFacts.private.inference']);
    expect(EN['publicFacts.private.inference']).toMatch(/earlier payments.*work out who was paid/);
    expect(q(c, '[data-fact=band]')!.textContent).toBe(EN['publicFacts.private.band']);
    expect(EN['publicFacts.private.band']).toMatch(/spending policy.*band/);
    expect(q(c, '[data-fact=public-says]')).toBeNull();
  });

  /* RED WHEN: one person is told as "1 payments". */
  it('says one payment for one person', () => {
    expect(q(draw(leg({ people: 1 })), '[data-fact=count]')!.textContent).toBe(EN['publicFacts.count_one']!.replace('{count}', '1'));
  });
});

describe('a public payment', () => {
  /* RED WHEN: a public payment's facts do not say the address, the amount and the currency go on a record anyone can read, or leave out a person, their address, their amount or its Public mark. */
  it('lists every person\'s address and amount as put on a record anyone can read', () => {
    const c = draw(PUBLIC());
    expect(q(c, '[data-fact=public-says]')!.textContent).toBe(EN['publicFacts.public.says']);
    expect(EN['publicFacts.public.says']).toMatch(/address, the amount and the currency on a record anyone can read/);
    expect(EN['publicFacts.count_other']).not.toMatch(/against this run/);
    expect(EN['publicFacts.counter']).toMatch(/each payment sent from the vault, and a payment can cover several people/);
    expect(all(c, '[data-public-pay]').map((r) => [q(r, '[data-address]')!.textContent, q(r, '[data-slot=amount]')!.dataset.visibility, q(r, '[data-slot=amount]')!.textContent])).toEqual([
      ['mn_addr_ana', 'public', expect.stringContaining('5')], ['mn_addr_bo', 'public', expect.stringContaining('2.5')],
    ]);
    expect(all(c, '[data-public-pay] [data-slot=public-pill]')).toHaveLength(2);
    expect(q(c, '[data-fact=count]')).not.toBeNull();
    expect(q(c, '[data-fact=vault]')).not.toBeNull();
    expect(q(c, '[data-fact=counter]')).not.toBeNull();
    expect(q(c, '[data-fact=hidden]')).toBeNull();
    expect(q(c, '[data-fact=inference]')).toBeNull();
  });

  /* RED WHEN: a person with no address, or in a token this app does not know, is shown with an invented address or amount. */
  it('says so where a person has no address or is paid in a token this app does not know', () => {
    const c = draw({ ...PUBLIC(), pays: [{ name: 'Cy', address: null, amount: null }] });
    expect(q(c, '[data-public-pay] [data-address]')!.textContent).toBe(EN['publicFacts.public.noAddress']);
    expect(q(c, '[data-public-pay]')!.textContent).toContain(EN['records.unrecognisedOne']);
  });
});

describe('a single payment', () => {
  const one = (l: RunLeg): RunLeg => ({ ...l, payees: 1, people: 1, total: 5_000_000n, pays: [l.pays[0]!] });

  /* RED WHEN: a single private payment is told in a run's words (this run, each person paid), leaves out the vault, the payments count or the policy band, or names an address or amount the network does not show. */
  it('is told in the payment\'s own words, and a private one shows no address or amount', () => {
    const c = draw(one(leg()), true);
    expect(q(c, '[data-fact=vault]')!.textContent).toBe(EN['publicFacts.payment.vault']!.replace('{vault}', 'Vault 3'));
    expect(q(c, '[data-fact=count]')!.textContent).toBe(EN['publicFacts.payment.count']);
    expect(q(c, '[data-fact=counter]')!.textContent).toBe(EN['publicFacts.counter']);
    expect(q(c, '[data-fact=band]')!.textContent).toBe(EN['publicFacts.payment.band']);
    expect(q(c, '[data-fact=inference]')!.textContent).toBe(EN['publicFacts.private.inference']);
    expect(all(c, '[data-public-pay]')).toEqual([]);
    expect(c.textContent).not.toMatch(/\brun\b|mn_shield|Ana/u);
  });

  /* RED WHEN: a single public payment is told in a run's words, or does not list its one address and amount with the Public mark and say they go on a record anyone can read. */
  it('says a public payment puts its one address and amount on a record anyone can read', () => {
    const c = draw(one(PUBLIC()), true);
    expect(q(c, '[data-fact=public-says]')!.textContent).toBe(EN['publicFacts.payment.public.says']);
    expect(all(c, '[data-public-pay]')).toHaveLength(1);
    expect(q(c, '[data-public-pay] [data-address]')!.textContent).toBe('mn_addr_ana');
    expect(all(c, '[data-public-pay] [data-slot=public-pill]')).toHaveLength(1);
    expect(c.textContent).not.toMatch(/\brun\b/u);
  });

  /* RED WHEN: the count line says it counts people, though the vault's counter goes up once for each payment. */
  it('says the count is of payments, not of people', () => {
    expect(EN['publicFacts.count_one']).toMatch(/how many payments the vault has made/u);
    expect(EN['publicFacts.count_other']).toMatch(/how many payments the vault has made/u);
    expect(EN['publicFacts.count_other']).not.toMatch(/people the vault has paid/u);
  });

  /* RED WHEN: the run's sentences change for a run, because the payment's were added. */
  it('leaves a run\'s words as they were', () => {
    const c = draw(leg(), false);
    expect([q(c, '[data-fact=vault]')!.textContent, q(c, '[data-fact=band]')!.textContent]).toEqual([EN['publicFacts.vault']!.replace('{vault}', 'Vault 3'), EN['publicFacts.private.band']]);
  });
});
