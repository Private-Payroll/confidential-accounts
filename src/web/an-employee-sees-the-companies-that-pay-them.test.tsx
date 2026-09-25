// @vitest-environment jsdom
/**
 * **AN EMPLOYEE, SIGNED IN, SEES THE COMPANIES THAT PAY THEM, AND OPENING ONE
 * SHOWS THEIR OWN PAYSLIPS FROM IT AND NOTHING ELSE.**
 *
 * The company list is the same one a signer sees: a row for each company you
 * sign for and a row for each company that pays you, each marked. Somebody who
 * is neither sees neither.
 *
 * Opening a company that pays you is a view of its own, driven here from the
 * press of its one button to the words on the screen, with a wallet, a service
 * and a chain reader that answer as each case needs. The payslips appear once
 * they are open, before the chain is read; the chain read then fills in each
 * row. Each sentence this view can show in place of a payslip is held word for
 * word.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { ChainReader } from './payslip-worker-client.js';
import { PageOutOfDate, type MyPayslips } from './my-payslips.js';
import { AccountPicker } from './Auth.js';
import { EmployerView, onThisPage, type EmployerViewDeps } from './YourPay.js';
import { PAYSLIP_PAGE_HEADER, PAYSLIP_PAGE_VERSION } from '../core/payslip-page.js';
import { newWrappingKeypair, wrapKey, toHex, randomBytes } from '../core/crypto.js';
import { HELD_ADDRESS_SLOTS, heldAddressDigest } from 'midnight-identity/profile/unlock';

/* The tab was prepared for this person, as a sign-in leaves it. */
vi.mock('./keyring.js', async (original) => ({
  ...(await original<typeof import('./keyring.js')>()),
  currentUser: () => ({ id: 'usr_1', email: null, name: '' }),
}));

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

const ACME = 'ab'.repeat(32);
/** An address Acme's slips were sealed under before it moved. */
const ACME_BEFORE = 'a0'.repeat(32);
const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
const PAID = '01'.repeat(32);
const UNPAID = '02'.repeat(32);

/**
 * Where Dana is paid - `payeeFor('0d'.repeat(32), 'undeployed')`, written out because this file runs
 * where the address library cannot encode one - and what her wallet says about it: a digest under the
 * ask's nonce, among filler.
 */
const DANA = 'mn_shield-addr_undeployed1p5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5x4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w46h2at4w4ctsw9lr';
const SCOPE = { nonce: 'the-page-nonce', origin: 'https://payroll.example', company: 'ab'.repeat(32) };
const HELD = {
  scope: SCOPE,
  digests: [heldAddressDigest(SCOPE, DANA)!,
    ...Array.from({ length: HELD_ADDRESS_SLOTS - 1 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))].sort(),
};

/** A slip whose receipt carries `nonce`, or none; the stand-in reader below reads a payment by its nonce. */
const slip = (runId: string, nonce: string | null): OpenedPayslip => ({
  runId, period: runId, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: ACME,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 1n, period: runId, paidTo: DANA },
  receipt: nonce === null ? null
    : { runId, nonce, blinding: '09'.repeat(32), company: ACME, until: Math.floor(Date.now() / 1000) + 3_600 },
});

/* ------------------------------------------------------------------ */
/* the list                                                             */
/* ------------------------------------------------------------------ */

const SIGNED_FOR = { id: 'acc_1', name: 'Globex', signers: 2, threshold: 1, wiring: 'chain' };

const thePicker = (accounts: unknown[], employers: string[], onOpenEmployer = vi.fn()) => render(
  <AccountPicker
    user={{ id: 'usr_1', email: null, name: '' }} accounts={accounts} busy={false}
    onOpen={() => {}} onUnlock={() => {}} onCreateWithWallet={() => {}}
    onFinishSetup={() => {}} awaitingSetup={null} onDemo={() => {}} onSignOut={() => {}}
    employers={employers} onOpenEmployer={onOpenEmployer} onAddEmployer={() => {}}
    onUnlockEmployers={() => {}} />);

describe('one list: the companies you sign for and the companies that pay you, each marked', () => {
  it('A COMPANY THAT PAYS YOU IS LISTED BESIDE ONE YOU SIGN FOR, MARKED FOR WHAT YOU ARE THERE', () => {
    const open = vi.fn();
    const { container } = thePicker([SIGNED_FOR], [ACME], open);
    const paying = container.querySelectorAll('[data-employer]');
    /* RED WHEN the companies that pay you are not listed. */
    expect(paying).toHaveLength(1);
    expect(paying[0].textContent).toContain('A company that pays you');
    expect(paying[0].textContent).toContain(ACME);
    /* The one you sign for keeps its own mark. RED WHEN one row stands for both. */
    expect(container.textContent).toContain('A company you are a signer on');
    expect(paying[0].textContent).not.toContain('signer');
    fireEvent.click(paying[0]);
    /* RED WHEN opening it opens something other than that company. */
    expect(open).toHaveBeenCalledWith(ACME);
  });

  it('SOMEBODY WHO IS NEITHER SEES NEITHER', () => {
    const { container } = thePicker([], []);
    /* RED WHEN a company is listed for somebody it does not pay and who does not sign for it. */
    expect(container.querySelectorAll('[data-employer]')).toHaveLength(0);
    expect(container.textContent).not.toContain('A company that pays you');
    expect(container.textContent).not.toContain('A company you are a signer on');
  });
});

/* ------------------------------------------------------------------ */
/* the view of one company that pays you                                */
/* ------------------------------------------------------------------ */

interface Asked { addressesOf: string[]; released: string[]; opened: string[]; read: string[]; done: number }

/** Everything outside the view, answering as a case says, and recording what it was asked. */
function around(opts: {
  slips?: Record<string, OpenedPayslip[]>;
  refused?: number;
  indexer?: typeof INDEXER | null;
  /** What the chain read answers; held until `let go` when `held`. */
  recorded?: (movements: string[]) => boolean[] | null;
  held?: boolean;
  failOpening?: unknown;
} = {}) {
  const asked: Asked = { addressesOf: [], released: [], opened: [], read: [], done: 0 };
  let letGo: () => void = () => {};
  const gate = opts.held ? new Promise<void>(r => { letGo = r; }) : Promise.resolve();
  const reader: ChainReader = {
    recorded: async (_indexer, company, payments) => {
      asked.read.push(company);
      await gate;
      return (opts.recorded ?? (ms => ms.map(m => m === PAID)))(payments.map(p => p.nonce));
    },
  };
  const deps: EmployerViewDeps = {
    askTheWallet: () => ({
      release: async (address) => {
        asked.released.push(address);
        return {
          key: new Uint8Array(32).fill(7), indexer: opts.indexer === undefined ? INDEXER : opts.indexer, held: HELD,
        };
      },
      done: () => { asked.done += 1; },
    }),
    addressesOf: async (company) => { asked.addressesOf.push(company); return [company, ACME_BEFORE]; },
    opened: async (_keys, address): Promise<MyPayslips> => {
      asked.opened.push(address);
      if (opts.failOpening) throw opts.failOpening;
      return {
        opened: opts.slips?.[address] ?? [], sealed: [], unopened: 0,
        refused: address === ACME ? (opts.refused ?? 0) : 0,
      };
    },
    reader: () => reader,
  };
  return { deps, asked, letGo: () => letGo() };
}

const press = (container: HTMLElement) =>
  fireEvent.click(container.querySelector('button.primary') as HTMLButtonElement);

describe('opening a company that pays you shows your payslips from it and nothing a signer sees', () => {
  it('ONLY THAT COMPANY IS ASKED ABOUT, AND ONLY THE PAYSLIPS IT GAVE ARE SHOWN', async () => {
    const w = around({ slips: { [ACME]: [slip('2026-08', PAID)], [ACME_BEFORE]: [slip('2026-07', null)] } });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    await waitFor(() => expect(container.querySelectorAll('[data-payslip]')).toHaveLength(2));
    /* RED WHEN the view asks about any company but the one opened, or skips an address it had. */
    expect(w.asked.addressesOf).toEqual([ACME]);
    expect(w.asked.released).toEqual([ACME, ACME_BEFORE]);
    expect(w.asked.opened).toEqual([ACME, ACME_BEFORE]);
    /* The wallet is put away once. */
    await waitFor(() => expect(w.asked.done).toBe(1));
    /* Nothing a signer sees: no roster, no runs, no approvals, no other company. */
    const text = container.textContent ?? '';
    for (const signerOnly of ['Approvals', 'People', 'Run payroll', 'signers', 'approvals required', 'Globex']) {
      expect(text).not.toContain(signerOnly);
    }
    expect(container.querySelector('[data-employer-view]')).not.toBeNull();
  });

  it('THE PAYSLIPS ARE SHOWN BEFORE THE CHAIN READ ENDS, WITH THE WORDS THAT SAY IT IS RUNNING', async () => {
    const w = around({ slips: { [ACME]: [slip('2026-08', PAID)] }, held: true });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    /* RED WHEN the rows wait for the chain read. */
    await waitFor(() => expect(container.querySelectorAll('[data-payslip]')).toHaveLength(1));
    const checking = container.querySelector('[data-checking]');
    /* RED WHEN the running read is not said, or said in other words. */
    expect(checking?.textContent).toBe(`Checking the chain for ${ACME.slice(0, 8)}…${ACME.slice(-6)}…`);
    expect(container.querySelector('[data-payslip]')?.textContent).not.toContain('Recorded as paid');
    w.letGo();
    await waitFor(() => expect(container.querySelector('[data-payslip]')?.textContent).toContain('Recorded as paid'));
    expect(container.querySelector('[data-checking]')).toBeNull();
    expect(container.querySelector('[data-could-not-read]')).toBeNull();
  });

  it('A WALLET THAT NAMES NO INDEXER IS SAID, WORD FOR WORD', async () => {
    const w = around({ slips: { [ACME]: [slip('2026-08', PAID)] }, indexer: null });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    /* RED WHEN every row says "Cannot tell" with no reason. */
    await waitFor(() => expect(container.querySelector('[data-could-not-read]')).not.toBeNull());
    expect(container.querySelector('[data-could-not-read]')?.textContent).toBe(
      'We could not read the chain for this company, so we cannot say whether you were paid. '
      + 'Check your wallet\'s private balance.');
  });

  it('A CHAIN READ THAT FAILS IS SAID THE SAME WAY', async () => {
    const w = around({ slips: { [ACME]: [slip('2026-08', UNPAID)] }, recorded: () => null });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    await waitFor(() => expect(container.querySelector('[data-could-not-read]')).not.toBeNull());
    expect(container.querySelector('[data-could-not-read]')?.textContent).toBe(
      'We could not read the chain for this company, so we cannot say whether you were paid. '
      + 'Check your wallet\'s private balance.');
    /* RED WHEN a read that failed is reported as an answer. */
    expect(container.querySelector('[data-payslip]')?.textContent).toContain('Cannot tell');
  });

  it('SLIPS THAT NAMED ANOTHER COMPANY ADDRESS ARE WITHHELD, AND THAT IS SAID, WORD FOR WORD', async () => {
    const w = around({ slips: {}, refused: 2 });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    await waitFor(() => expect(container.querySelector('[data-withheld]')).not.toBeNull());
    /* RED WHEN withheld slips are silent. */
    expect(container.querySelector('[data-withheld]')?.textContent).toBe(
      '2 payslip(s) named a company address you did not open them for, so they are not shown. '
      + 'Tell the company that pays you.');
    /* RED WHEN "no payslips were found" is said while slips were withheld. */
    expect(container.querySelector('[data-no-payslips]')).toBeNull();
  });

  it('WHEN THE LIST OF EARLIER ADDRESSES CANNOT BE HAD, THE COMPANY ITSELF IS STILL OPENED', async () => {
    const w = around({ slips: { [ACME]: [slip('2026-08', null)] } });
    const deps = { ...w.deps, addressesOf: async () => { throw new Error('not answered'); } };
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={deps} />);
    press(container);
    await waitFor(() => expect(container.querySelectorAll('[data-payslip]')).toHaveLength(1));
    /* RED WHEN only the addresses the service named are opened. */
    expect(w.asked.opened).toEqual([ACME]);
  });

  it('WHEN AN ADDRESS COULD NOT BE OPENED, IT IS NOT SAID THAT NO PAYSLIPS WERE FOUND', async () => {
    const w = around({ failOpening: new Error('the wallet said no') });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    await waitFor(() => expect(container.querySelector('[data-error]')).not.toBeNull());
    /* RED WHEN a failure to look reads as having looked and found nothing. */
    expect(container.querySelector('[data-no-payslips]')).toBeNull();
  });

  it('THE PAGE\'S OWN REQUESTS NAME THE ADDRESS OPENED, CARRY THE SIGN-IN, THE PAGE AND WHO THE TAB IS FOR', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const me = newWrappingKeypair();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url === '/api/payslips/proof') {
        return new Response(JSON.stringify({ sealed: wrapKey(toHex(randomBytes(32)), me.publicKey), expiresAt: '' }));
      }
      if (url === '/api/payslips') return new Response('[]');
      return new Response(JSON.stringify({ addresses: [ACME] }));
    }) as typeof fetch;
    expect(await onThisPage.addressesOf(ACME)).toEqual([ACME]);
    await onThisPage.opened(me, ACME);
    expect(seen.map(r => r.url)).toEqual(
      [`/api/payslips/addresses?company=${ACME}`, '/api/payslips/proof', '/api/payslips']);
    /* RED WHEN the list is asked for without the address it was opened for. */
    expect(JSON.parse(String(seen[2].init?.body)).from).toBe(ACME);
    for (const r of seen) {
      const headers = r.init?.headers as Record<string, string>;
      expect(r.init?.credentials).toBe('same-origin');
      expect(headers[PAYSLIP_PAGE_HEADER]).toBe(PAYSLIP_PAGE_VERSION);
      /* RED WHEN the tab stops saying who it was prepared for: the service's other-person check is lost. */
      expect(headers['x-signed-in-as']).toBe('usr_1');
    }
  });

  it('A PAGE OLDER THAN THE SERVICE SAYS SO, WORD FOR WORD, AND NOTHING ELSE', async () => {
    const w = around({ failOpening: new PageOutOfDate() });
    const { container } = render(<EmployerView company={ACME} onBack={() => {}} deps={w.deps} />);
    press(container);
    await waitFor(() => expect(container.querySelector('[data-error]')).not.toBeNull());
    /* RED WHEN it is folded into a list of addresses that could not be opened. */
    expect(container.querySelector('[data-error]')?.textContent)
      .toBe('This page is out of date. Reload it and open your payslips again.');
    /* It stops at the first address: every other would be told the same. */
    expect(w.asked.opened).toEqual([ACME]);
    expect(w.asked.done).toBe(1);
  });
});
