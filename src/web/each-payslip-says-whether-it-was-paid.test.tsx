import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { ChainReader } from './payslip-worker-client.js';
import { PAID_MEANS, PayslipTable, wordsForSlips } from './YourPay.js';

/**
 * **WHAT THE EMPLOYEE READS IN THE ROW, NOT ONLY WHAT A FUNCTION RETURNS.**
 *
 * Three slips from one company, raised on a chain: one whose payment is in the
 * company's record, one whose is not, and one from a company whose record could
 * not be read. The table is rendered as the page renders it, from the words the
 * page works out, and each row is read back as text.
 */
const ACME = 'ab'.repeat(32);
const ELSEWHERE = 'cd'.repeat(32);
const value = (n: number) => n.toString(16).padStart(64, '0');

const NOW = 1_800_000_000;
const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };

/** The address Dana's wallet confirmed it holds, and one it did not. */
const MINE = 'mn_shield-addr_test1mine';
const NOT_MINE = 'mn_shield-addr_test1notmine';

const slip = (
  runId: string, period: string, company: string, nonce: string, until: number | null = NOW + 60, paidTo = MINE,
): OpenedPayslip => ({
  runId, period, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: company,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 5_000_000n, period, paidTo },
  receipt: { runId, nonce, blinding: value(9), company, until },
});

/** Dana's wallet confirmed `MINE` and nothing else. */
const confirmed = (s: OpenedPayslip): boolean => s.payslip.paidTo === MINE;

/** This device's read: ACME's contract holds two payments, told apart here by nonce; the other could not be read. */
const asked: string[] = [];
const record: ChainReader = {
  recorded: async (_indexer, company, payments) => {
    asked.push(company);
    if (company !== ACME) return null;
    return payments.map(p => p.nonce === value(1) || p.nonce === value(7));
  },
};

/** The Paid and On the chain cells of one row, as text. */
const paidCells = (html: string, runId: string): [string, string] => {
  const m = html.match(new RegExp(`<tr data-payslip="${runId}">(.*?)</tr>`));
  if (!m) throw new Error(`no row for ${runId}`);
  const cells = [...m[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(c => c[1]!);
  return [cells[2]!, cells[3]!];
};

describe('the payslips table says, row by row, whether each was paid', () => {
  it('RECORDED AS PAID, NOT YET AND CANNOT TELL, EACH IN ITS OWN ROW', async () => {
    const slips = [
      slip('run_sep', '2026-09', ACME, value(7)),
      slip('run_aug', '2026-08', ACME, value(3)),
      slip('run_jul', '2026-07', ELSEWHERE, value(1)),
      /* Its window closed with the payment not recorded. */
      slip('run_jun', '2026-06', ACME, value(4), NOW - 60),
      /* Paid to an address the wallet did not confirm, and recorded under that nonce. */
      slip('run_may', '2026-05', ACME, value(7), NOW + 60, NOT_MINE),
      /* The same, and not recorded. */
      slip('run_apr', '2026-04', ACME, value(5), NOW + 60, NOT_MINE),
    ];
    const html = renderToStaticMarkup(<PayslipTable slips={slips} words={await wordsForSlips(slips, record, INDEXER, confirmed, NOW)} />);
    /*
     * RED WHEN the page shows the run's own facts where the company's record
     * answered - every row then reads that the page cannot tell yet - or when
     * a record that could not be read is shown as not paid.
     */
    expect(paidCells(html, 'run_sep')).toEqual(['Recorded as paid', 'Yes']);
    expect(paidCells(html, 'run_aug')).toEqual(['Not yet', 'Not yet']);
    expect(paidCells(html, 'run_jul')).toEqual(['Cannot tell', 'Not known']);
    /* RED WHEN a payment whose window has closed reads "not yet" for good. */
    expect(paidCells(html, 'run_jun')).toEqual(['Cannot tell', 'Not known']);
    /* RED WHEN an address the wallet did not confirm is asked about: May would read paid and April not yet. */
    expect(paidCells(html, 'run_may')).toEqual(['Cannot tell', 'Not known']);
    expect(paidCells(html, 'run_apr')).toEqual(['Cannot tell', 'Not known']);
    expect(html).not.toContain('Sent for approval');
  });

  it('THE SENTENCE UNDER THE TABLE IS THE ONE RULED, WORD FOR WORD', async () => {
    const slips = [slip('run_sep', '2026-09', ACME, value(7))];
    const html = renderToStaticMarkup(<PayslipTable slips={slips} words={await wordsForSlips(slips, record, INDEXER, confirmed, NOW)} />);
    /* RED WHEN one word of it changes. */
    expect(PAID_MEANS).toBe('Paid means the company\'s account records your payment as made. '
      + 'Check that the amount reached your wallet\'s private balance.');
    /* RED WHEN it is not rendered, or not after the table. */
    const escaped = PAID_MEANS.replace(/'/g, '&#x27;');
    expect(html.indexOf(escaped)).toBeGreaterThan(html.indexOf('</table>'));
  });

  it('A SLIP WITH NO RECEIPT SAYS WHAT ITS RUN RECORDS, AND ASKS NOTHING', async () => {
    asked.length = 0;
    const draft: OpenedPayslip = { ...slip('run_oct', '2026-10', ACME, value(7)), status: 'draft', receipt: null };
    const html = renderToStaticMarkup(
      <PayslipTable slips={[draft]} words={await wordsForSlips([draft], record, INDEXER, confirmed, NOW)} />);
    expect(paidCells(html, 'run_oct')).toEqual(['Not sent for approval yet', 'No']);
    expect(asked).toEqual([]);
  });
});
