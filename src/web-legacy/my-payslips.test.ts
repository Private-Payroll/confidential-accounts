import { describe, expect, it } from 'vitest';
import {
  newWrappingKeypair, newSymmetricKey, seal, wrapKey, canonical, toHex, randomBytes,
} from '../core/crypto.js';
import type { SealedPayslip } from '../core/payslip-open.js';
import { payslipPublicKeyOf } from '../core/payslip-open.js';
import { assets } from '../core/assets.js';
import {
  fetchMyPayslips, payslipAddressesFor, rememberCompany, rememberedCompanies, tidyCompanyLabel,
  forgetRememberedCompanies, PageOutOfDate, type Fetch,
} from 'vaults-web-shared/my-payslips.js';
import { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, PAYSLIP_PAGE_VERSION } from '../core/payslip-page.js';
import { hiringAssets, invitingAssets } from './hiring-assets.js';
import { paymentWords } from './YourPay.js';

/** The value, or a failure that says one was missing: an index that finds nothing is a broken test, not a value to carry on with. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value here, and there was none');
  return value;
}

const CO = 'co_' + 'ab'.repeat(32);
const OTHER_CO = 'co_' + 'cd'.repeat(32);

/** A slip sealed to one public key, as the service stores it. */
const slipFor = (publicKey: string, name: string, period: string): SealedPayslip => {
  const key = newSymmetricKey();
  return {
    runId: 'run_' + period, period, status: 'settled', settledAt: '2026-09-01T00:00:00.000Z',
    wiring: 'chain', issuedBy: CO,
    wrapped: wrapKey(key, publicKey),
    slip: seal(canonical({ employeeId: 'emp_1', name, asset: 'TESTUSD', amount: 5_000_000n, period }), key),
    receipt: null,
  };
};

/**
 * A service that behaves as the real one: it seals a one-use value to the key
 * asked about and answers the list only for that value. Every request is kept.
 */
const service = (slips: SealedPayslip[]) => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  let live: { publicKey: string; value: string } | null = null;
  const fetcher: Fetch = async (url, init) => {
    seen.push({ url, init });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === '/api/payslips/proof') {
      const value = toHex(randomBytes(32));
      live = { publicKey: body.publicKey, value };
      return new Response(JSON.stringify({ sealed: wrapKey(value, body.publicKey), expiresAt: '' }));
    }
    if (url === '/api/payslips') {
      const ok = live && live.publicKey === body.publicKey && live.value === body.answer;
      live = null;
      return ok
        ? new Response(JSON.stringify(slips))
        : new Response(JSON.stringify({ error: 'refused' }), { status: 403 });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher, seen };
};

describe('a payee\'s own payslips are fetched sealed and opened on this device', () => {
  it('OPENS THEIR SLIPS, THE SECRET IS IN NO REQUEST, AND THE SIGN-IN AND THE PAGE RIDE ALONG', async () => {
    const me = newWrappingKeypair();
    const someoneElse = newWrappingKeypair();
    const { fetcher, seen } = service([
      slipFor(me.publicKey, 'Dana', '2026-08'),
      slipFor(someoneElse.publicKey, 'Eli', '2026-08'),
    ]);
    const got = await fetchMyPayslips(me, CO, fetcher);
    expect(got.opened.map(s => s.payslip.name)).toEqual(['Dana']);
    expect(present(got.opened[0]).payslip.amount).toBe(5_000_000n);
    /* A slip sent for this key that it does not open is counted, not shown. */
    expect(got.unopened).toBe(1);
    expect(seen.map(r => r.url)).toEqual(['/api/payslips/proof', '/api/payslips']);
    for (const r of seen) {
      /* RED WHEN the secret is sent to prove the key, or rides in an address. */
      expect(r.url).not.toContain(me.secret);
      expect(String(r.init?.body ?? '')).not.toContain(me.secret);
      /* RED WHEN the request goes without this page's sign-in: the service refuses it. */
      expect(r.init?.credentials).toBe('same-origin');
      /* RED WHEN the page does not name itself: the service tells it it is out of date. */
      expect((r.init?.headers as Record<string, string>)[PAYSLIP_PAGE_HEADER]).toBe(PAYSLIP_PAGE_VERSION);
    }
  });

  it('A SERVICE THAT SAYS THIS PAGE IS OUT OF DATE IS SAID IN ITS WORDS, AND NOT AS ONE ADDRESS FAILING', async () => {
    const me = newWrappingKeypair();
    const stale: Fetch = async () => new Response(
      JSON.stringify({ code: 'payslip-page-out-of-date', error: PAGE_OUT_OF_DATE }), { status: 409 });
    /* RED WHEN the refusal is read as an ordinary failure. */
    const failed = await fetchMyPayslips(me, CO, stale).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(PageOutOfDate);
    expect((failed as Error).message).toBe('This page is out of date. Reload it and open your payslips again.');
    await expect(payslipAddressesFor(CO, stale)).rejects.toBeInstanceOf(PageOutOfDate);
  });

  it('SOMETHING THAT IS NOT A SLIP AT ALL IS AN ERROR, NOT A SLIP THAT DID NOT OPEN', async () => {
    const me = newWrappingKeypair();
    const { fetcher } = service([null as unknown as SealedPayslip]);
    /* RED WHEN every failure is counted as a slip that did not open. */
    await expect(fetchMyPayslips(me, CO, fetcher)).rejects.toThrow(TypeError);
  });

  it('THE ADDRESSES ARE ASKED FOR WITH THE SIGN-IN TOO', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: Fetch = async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ companies: [
        { label: OTHER_CO, account: 'EF'.repeat(32) }, { label: 'ef'.repeat(32), account: 'ef'.repeat(32) },
      ] }));
    };
    /* RED WHEN an entry without a well-formed label is kept, or the account is not folded. */
    expect(await payslipAddressesFor(CO, fetcher)).toEqual([{ label: OTHER_CO, account: 'ef'.repeat(32) }]);
    expect(present(seen[0]).url).toBe(`/api/payslips/addresses?company=${CO}`);
    /* RED WHEN it goes without the sign-in, or without naming the page. */
    expect(present(seen[0]).init?.credentials).toBe('same-origin');
    expect((present(seen[0]).init?.headers as Record<string, string>)[PAYSLIP_PAGE_HEADER]).toBe(PAYSLIP_PAGE_VERSION);
  });

  it('A PUBLIC KEY WORKED OUT FROM THE SECRET IS THE ONE THE SLIPS ARE SEALED TO', () => {
    const k = newWrappingKeypair();
    expect(payslipPublicKeyOf(k.secret)).toBe(k.publicKey);
  });
});

describe('which companies this browser holds for one person', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    };
  };

  it('KEEPS COMPANY LABELS AND NOTHING ELSE', () => {
    const s = memory();
    expect(rememberCompany('usr_a', ' ' + CO + ' ', s)).toEqual([CO]);
    expect(rememberCompany('usr_a', CO, s)).toEqual([CO]);
    /* RED WHEN an account's address is taken for a company's label. */
    expect(rememberCompany('usr_a', 'ab'.repeat(32), s)).toEqual([CO]);
    /* RED WHEN a label is folded to lower case rather than refused. */
    expect(rememberCompany('usr_a', 'co_' + 'AB'.repeat(32), s)).toEqual([CO]);
    expect(rememberCompany('usr_a', 'not a label', s)).toEqual([CO]);
    expect(rememberedCompanies('usr_a', s)).toEqual([CO]);
    expect(tidyCompanyLabel('co_12')).toBeNull();
  });

  it('ANOTHER PERSON IN THE SAME BROWSER IS NEVER SHOWN IT', () => {
    const s = memory();
    rememberCompany('usr_a', CO, s);
    /* RED WHEN the list is kept for the browser rather than for the person. */
    expect(rememberedCompanies('usr_b', s)).toEqual([]);
    /* And the list from before, kept for nobody in particular, is shown to nobody. */
    s.setItem('payslip-companies', JSON.stringify([OTHER_CO]));
    expect(rememberedCompanies('usr_b', s)).toEqual([]);
    forgetRememberedCompanies('usr_a', s);
    expect(rememberedCompanies('usr_a', s)).toEqual([]);
  });

  it('A BROKEN LIST READS AS EMPTY RATHER THAN THROWING', () => {
    expect(rememberedCompanies('usr_a', { getItem: () => '{not json' })).toEqual([]);
    expect(rememberedCompanies('usr_a', { getItem: () => { throw new Error('blocked'); } })).toEqual([]);
  });
});

describe('what the page says about each payment', () => {
  it('ON A CHAIN ONLY WHEN SETTLED BY A CHAIN', () => {
    expect(paymentWords({ status: 'settled', settledAt: '2026-09-01T00:00:00.000Z', wiring: 'chain' }))
      .toEqual({ paid: new Date('2026-09-01T00:00:00.000Z').toLocaleDateString('en-GB'), onChain: 'Yes' });
    /* RED WHEN a rehearsal reads as paid. */
    expect(paymentWords({ status: 'settled', settledAt: '2026-09-01T00:00:00.000Z', wiring: 'simulated' }))
      .toEqual({ paid: 'No: a rehearsal, nothing was sent', onChain: 'No' });
    expect(paymentWords({ status: 'settled', settledAt: null, wiring: null }))
      .toEqual({ paid: 'Not known', onChain: 'Not recorded' });
    /* RED WHEN a run sent for approval is said to be unpaid: it may have been
     * paid out of a vault, which the run does not record. */
    expect(paymentWords({ status: 'proposed', settledAt: null, wiring: 'chain' }))
      .toEqual({ paid: 'Sent for approval. This page cannot tell yet whether it has been paid', onChain: 'Not known' });
    expect(paymentWords({ status: 'draft', settledAt: null, wiring: 'chain' }))
      .toEqual({ paid: 'Not sent for approval yet', onChain: 'No' });
  });
});

describe('what the hiring form offers', () => {
  it('ONLY ASSETS THAT CAN BE PAID ON MIDNIGHT, THE PRIVATE ONES FIRST', () => {
    const codes = hiringAssets().map(a => a.code);
    /* RED WHEN the form offers an asset with no form on Midnight, or starts on one. */
    for (const code of ['GBP', 'USD', 'EUR', 'USDC']) expect(codes).not.toContain(code);
    expect(codes[0]).toBe('TESTUSD');
    expect(codes).toContain('NIGHT');
    expect(assets.require(present(codes[0])).ledger.shielded).not.toBeNull();
    /* An employee can be invited in anything they can be hired in, NIGHT among
     * it: the invitation asks their wallet for a public address when the money
     * has no private form. RED WHEN the invitation form offers less than hiring,
     * which is where NIGHT was left out. */
    expect(invitingAssets().map(a => a.code)).toEqual(codes);
    expect(invitingAssets().map(a => a.code)).toContain('NIGHT');
  });
});
