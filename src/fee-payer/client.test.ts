/**
 * **THE WEB PROCESS'S FEE PAYER IS A CLIENT, AND IT IS WIRED FROM TWO SETTINGS
 * OR NOT AT ALL.** The service end of these calls has its own cases; these hold
 * what the client decides before a request leaves, and how it reads a failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  feePayerFrom, feePayerAddress, RemoteFeeSponsor, FEE_PAYER_URL_SETTING, FEE_PAYER_SECRET_SETTING,
} from './client.js';
import type { TransactionCodec } from './service.js';
import { saysNothingWasSent } from '../core/jobs.js';

const SECRET = 'not-a-secret: a test literal of enough length';
const codec: TransactionCodec = {
  read: (b) => JSON.parse(Buffer.from(b).toString()),
  write: (tx) => new Uint8Array(Buffer.from(JSON.stringify(tx))),
};
const unreachable = async (): Promise<Response> => { throw new TypeError('fetch failed'); };

describe('where the fee payer comes from', () => {
  /* RED WHEN: an unconfigured deployment gets a fee payer, or a refusal. */
  it('neither setting: no fee payer, and no complaint', () => {
    expect(() => feePayerFrom({}, codec)).not.toThrow();
    expect(feePayerFrom({}, codec)).toBeNull();
    expect(feePayerFrom({ [FEE_PAYER_URL_SETTING]: '  ' }, codec)).toBeNull();
  });

  /* RED WHEN: a half-configured deployment starts quietly without its fee payer. */
  it('one setting without the other is refused, naming both', () => {
    expect(() => feePayerFrom({ [FEE_PAYER_URL_SETTING]: 'https://fees.example/' }, codec))
      .toThrow(new RegExp(`${FEE_PAYER_URL_SETTING} is set and ${FEE_PAYER_SECRET_SETTING} is not`));
    expect(() => feePayerFrom({ [FEE_PAYER_SECRET_SETTING]: SECRET }, codec))
      .toThrow(new RegExp(`${FEE_PAYER_SECRET_SETTING} is set and ${FEE_PAYER_URL_SETTING} is not`));
  });

  /* RED WHEN: the transport rule is loosened, so the secret can cross a network in the clear. */
  it('the secret never crosses a network in the clear', () => {
    expect(String(feePayerAddress('http://fees.example/'))).toMatch(/not https/);
    expect(String(feePayerAddress('http://10.0.0.5:6310/'))).toMatch(/not https/);
    expect(String(feePayerAddress('ftp://127.0.0.1/'))).toMatch(/not https/);
    expect(feePayerAddress('http://127.0.0.1:6310')).toBeInstanceOf(URL);
    expect(feePayerAddress('http://localhost:6310/')).toBeInstanceOf(URL);
    expect(feePayerAddress('http://[::1]:6310/')).toBeInstanceOf(URL);
    expect(feePayerAddress('https://fees.example')).toBeInstanceOf(URL);
  });

  /* RED WHEN: credentials or a query in the address are accepted. */
  it('the address carries no credentials', () => {
    expect(String(feePayerAddress('https://user:pw@fees.example/'))).toMatch(/carries credentials/);
    expect(String(feePayerAddress('https://:pw@fees.example/'))).toMatch(/carries credentials/);
    expect(String(feePayerAddress('https://fees.example/?secret=x'))).toMatch(/carries credentials/);
    expect(String(feePayerAddress('https://fees.example/#x'))).toMatch(/carries credentials/);
    expect(String(feePayerAddress('not an address'))).toMatch(/is not an address/);
  });

  /* RED WHEN: the trailing slash is not added, so the calls resolve beside the last segment. */
  it('calls are made under the address, not beside it', () => {
    const u = feePayerAddress('https://fees.example/payer') as URL;
    expect(new URL('fee', u).toString()).toBe('https://fees.example/payer/fee');
  });

  /* RED WHEN: a fully configured deployment does not get a client. */
  it('both settings: a client', () => {
    expect(feePayerFrom({
      [FEE_PAYER_URL_SETTING]: 'http://127.0.0.1:6310', [FEE_PAYER_SECRET_SETTING]: SECRET,
    }, codec)).toBeInstanceOf(RemoteFeeSponsor);
  });
});

describe('what the client decides before a request leaves', () => {
  const client = (fetchImpl: any) =>
    new RemoteFeeSponsor(new URL('http://127.0.0.1:1/'), SECRET, codec, fetchImpl);

  /* RED WHEN: the client asks for a fee without a company to record it against. */
  it('refuses to ask for a fee without a company', async () => {
    let asked = false;
    const c = client(async () => { asked = true; return new Response('{}'); });
    const refused: any = await c.addFeeAndFinalise({ n: 1 }, new Date()).catch((e) => e);
    expect(refused.message).toMatch(/which company/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(asked).toBe(false);
  });

  /* RED WHEN: a transaction nobody booked here is sent to be submitted. */
  it('refuses to submit a transaction it was not handed back', async () => {
    let asked = false;
    const c = client(async () => { asked = true; return new Response('{}'); });
    const refused: any = await c.submit({ n: 1 }).catch((e) => e);
    expect(refused.message).toMatch(/not given its fee by this fee payer/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(asked).toBe(false);
  });

  /* RED WHEN: an unreachable fee payer at the fee step is reported as an unknown outcome. */
  it('a fee request that never arrived sent nothing', async () => {
    const c = client(unreachable);
    c.payingFor('acc');
    const failed: any = await c.addFeeAndFinalise({ n: 1 }, new Date()).catch((e) => e);
    expect(failed.message).toMatch(/could not be reached/);
    expect(saysNothingWasSent(failed)).toBe(true);
  });

  /*
   * RED WHEN: an unreachable fee payer at the submit step is reported as
   * nothing sent. The request may have left.
   */
  it('a submission whose answer never came is an unknown outcome', async () => {
    let n = 0;
    const c = client(async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify({ booking: 'b1', tx: Buffer.from('{"paid":1}').toString('base64') }));
      throw new TypeError('fetch failed');
    });
    c.payingFor('acc');
    const paid = await c.addFeeAndFinalise({ n: 1 }, new Date());
    const failed: any = await c.submit(paid).catch((e) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(saysNothingWasSent(failed)).toBe(false);
  });

  /* RED WHEN: a refusing answer is read as a booking because it happens to carry the fields. */
  it('a refusing answer is a refusal, whatever else it carries', async () => {
    const c = client(async () => new Response(
      JSON.stringify({ booking: 'b1', tx: Buffer.from('{"paid":1}').toString('base64') }), { status: 500 }));
    c.payingFor('acc');
    const refused: any = await c.addFeeAndFinalise({ n: 1 }, new Date()).catch((e) => e);
    expect(refused, 'an error answer was taken as a fee added').toBeInstanceOf(Error);
    expect(saysNothingWasSent(refused)).toBe(true);
  });

  /*
   * RED WHEN: a booking is kept after its submission, so the same transaction
   * can be sent twice - or a second send is reported as nothing sent, when the
   * first may have landed.
   */
  it('a transaction is sent once, and a second send asks nobody and is not called unsent', async () => {
    let requests = 0;
    const c = client(async (_url: string, init: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init.body));
      if (body.company) return new Response(JSON.stringify({ booking: 'b1', tx: Buffer.from('{"paid":1}').toString('base64') }));
      return new Response(JSON.stringify({ ref: 'ref-1', at: '' }));
    });
    c.payingFor('acc');
    const paid = await c.addFeeAndFinalise({ n: 1 }, new Date());
    await c.submit(paid);
    const again: any = await c.submit(paid).catch((e) => e);
    expect(again, 'the same transaction was sent twice').toBeInstanceOf(Error);
    expect(again.message).toMatch(/already handed to the fee payer/);
    expect(saysNothingWasSent(again), 'a second send was called nothing sent').toBe(false);
    /* And a sent transaction has nothing left to let go of. */
    await c.release(paid);
    expect(requests, 'a sent transaction was asked to be released, or sent again').toBe(2);
  });

  /* RED WHEN: the secret is not sent, or is sent somewhere other than the authorization header. */
  it('presents the secret in the authorization header only', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const c = client(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ dust: '1', night: '2' }));
    });
    expect(await c.capacity()).toEqual({ dust: 1n, night: 2n });
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0].url).not.toContain(SECRET);
  });
});

describe('the web process can reach a fee payer only through this client', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
    });

  /*
   * RED WHEN: any shipped module under `src/` other than the class's own file
   * builds a fee payer over a wallet. That module would be a process holding
   * the wallet that pays.
   */
  it('no shipped module builds a fee payer over a wallet', () => {
    const building = walk(join(ROOT, 'src'))
      .filter(p => /new\s+WalletFeeSponsor\b|sponsorWalletOver|feePayerOver|bringUpWallet/.test(code(readFileSync(p, 'utf8'))))
      .map(p => relative(ROOT, p));
    expect(building).toEqual([]);
  });
});
