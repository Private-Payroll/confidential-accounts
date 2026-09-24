import { describe, expect, it } from 'vitest';
import {
  newWrappingKeypair, newSymmetricKey, seal, wrapKey, canonical, toHex, randomBytes,
} from '../core/crypto.js';
import type { SealedPayslip } from '../core/payslip-open.js';
import { payslipPublicKeyOf } from '../core/payslip-open.js';
import { assets } from '../core/assets.js';
import {
  fetchMyPayslips, payslipAddressesFor, rememberCompany, rememberedCompanies, tidyCompanyAddress,
  type Fetch,
} from './my-payslips.js';
import { hiringAssets, invitingAssets } from './hiring-assets.js';
import { paymentWords } from './YourPay.js';

/** A slip sealed to one public key, as the service stores it. */
const slipFor = (publicKey: string, name: string, period: string): SealedPayslip => {
  const key = newSymmetricKey();
  return {
    runId: 'run_' + period, period, status: 'settled', settledAt: '2026-09-01T00:00:00.000Z',
    wiring: 'chain', issuedBy: 'ab'.repeat(32),
    wrapped: wrapKey(key, publicKey),
    slip: seal(canonical({ employeeId: 'emp_1', name, asset: 'TESTUSD', amount: 5_000_000n, period }), key),
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
  it('OPENS THEIR SLIPS, AND THE SECRET IS IN NO REQUEST AND NO SIGN-IN RIDES ALONG', async () => {
    const me = newWrappingKeypair();
    const someoneElse = newWrappingKeypair();
    const { fetcher, seen } = service([
      slipFor(me.publicKey, 'Dana', '2026-08'),
      slipFor(someoneElse.publicKey, 'Eli', '2026-08'),
    ]);
    const got = await fetchMyPayslips(me, fetcher);
    expect(got.opened.map(s => s.payslip.name)).toEqual(['Dana']);
    expect(got.opened[0].payslip.amount).toBe(5_000_000n);
    /* A slip sent for this key that it does not open is counted, not shown. */
    expect(got.unopened).toBe(1);
    expect(seen.map(r => r.url)).toEqual(['/api/payslips/proof', '/api/payslips']);
    for (const r of seen) {
      /* RED WHEN the secret is sent to prove the key, or rides in an address. */
      expect(r.url).not.toContain(me.secret);
      expect(String(r.init?.body ?? '')).not.toContain(me.secret);
      /* RED WHEN the request carries this page's sign-in. */
      expect(r.init?.credentials).toBe('omit');
    }
  });

  it('SOMETHING THAT IS NOT A SLIP AT ALL IS AN ERROR, NOT A SLIP THAT DID NOT OPEN', async () => {
    const me = newWrappingKeypair();
    const { fetcher } = service([null as unknown as SealedPayslip]);
    /* RED WHEN every failure is counted as a slip that did not open. */
    await expect(fetchMyPayslips(me, fetcher)).rejects.toThrow(TypeError);
  });

  it('THE ADDRESSES ARE ASKED FOR WITHOUT THE SIGN-IN TOO', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: Fetch = async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ addresses: ['cd'.repeat(32)] }));
    };
    expect(await payslipAddressesFor('ab'.repeat(32), fetcher)).toEqual(['cd'.repeat(32)]);
    expect(seen[0].url).toBe(`/api/payslips/addresses?company=${'ab'.repeat(32)}`);
    /* RED WHEN it carries this page's sign-in, which would tie a person to a company. */
    expect(seen[0].init?.credentials).toBe('omit');
  });

  it('A PUBLIC KEY WORKED OUT FROM THE SECRET IS THE ONE THE SLIPS ARE SEALED TO', () => {
    const k = newWrappingKeypair();
    expect(payslipPublicKeyOf(k.secret)).toBe(k.publicKey);
  });
});

describe('which companies this browser has been told pay you', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  };

  it('KEEPS COMPANY ADDRESSES AND NOTHING ELSE', () => {
    const s = memory();
    expect(rememberCompany('0x' + 'AB'.repeat(32), s)).toEqual(['ab'.repeat(32)]);
    expect(rememberCompany('ab'.repeat(32), s)).toEqual(['ab'.repeat(32)]);
    expect(rememberCompany('not an address', s)).toEqual(['ab'.repeat(32)]);
    expect(rememberedCompanies(s)).toEqual(['ab'.repeat(32)]);
    expect(tidyCompanyAddress('12')).toBeNull();
  });

  it('A BROKEN LIST READS AS EMPTY RATHER THAN THROWING', () => {
    expect(rememberedCompanies({ getItem: () => '{not json' })).toEqual([]);
    expect(rememberedCompanies({ getItem: () => { throw new Error('blocked'); } })).toEqual([]);
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
    expect(assets.require(codes[0]).ledger.shielded).not.toBeNull();
    /* An employee is invited only in something that can be paid privately. RED
     * WHEN the invitation form offers a public-only asset. */
    expect(invitingAssets().map(a => a.code)).toEqual(['TESTUSD']);
  });
});
