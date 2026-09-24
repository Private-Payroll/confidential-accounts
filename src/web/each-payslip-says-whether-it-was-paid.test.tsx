import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OpenedPayslip } from '../core/payslip-open.js';
import type { Fetch } from './my-payslips.js';
import { PayslipTable, wordsForSlips } from './YourPay.js';

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

const slip = (runId: string, period: string, company: string, movement: string): OpenedPayslip => ({
  runId, period, status: 'proposed', settledAt: null, wiring: 'chain', issuedBy: company,
  payslip: { employeeId: 'emp_1', name: 'Dana', asset: 'TESTUSD', amount: 5_000_000n, period },
  receipt: { runId, leaf: value(9), movement, company },
});

const record: Fetch = async (url) => {
  if (url === `/api/payslips/paid?company=${ACME}`) {
    return new Response(JSON.stringify({ known: true, movements: [value(1), value(7)] }));
  }
  return new Response('{"error":"down"}', { status: 503 });
};

/** The Paid and On the chain cells of one row, as text. */
const paidCells = (html: string, runId: string): [string, string] => {
  const m = html.match(new RegExp(`<tr data-payslip="${runId}">(.*?)</tr>`));
  if (!m) throw new Error(`no row for ${runId}`);
  const cells = [...m[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(c => c[1]!);
  return [cells[2]!, cells[3]!];
};

describe('the payslips table says, row by row, whether each was paid', () => {
  it('PAID, NOT YET AND CANNOT TELL, EACH IN ITS OWN ROW', async () => {
    const slips = [
      slip('run_sep', '2026-09', ACME, value(7)),
      slip('run_aug', '2026-08', ACME, value(3)),
      slip('run_jul', '2026-07', ELSEWHERE, value(1)),
    ];
    const html = renderToStaticMarkup(<PayslipTable slips={slips} words={await wordsForSlips(slips, record)} />);
    /*
     * RED WHEN the page shows the run's own facts where the company's record
     * answered - every row then reads that the page cannot tell yet - or when
     * a record that could not be read is shown as not paid.
     */
    expect(paidCells(html, 'run_sep')).toEqual(['Paid', 'Yes']);
    expect(paidCells(html, 'run_aug')).toEqual(['Not yet', 'Not yet']);
    expect(paidCells(html, 'run_jul')).toEqual(['Cannot tell', 'Not known']);
    expect(html).not.toContain('Sent for approval');
  });

  it('A SLIP WITH NO RECEIPT SAYS WHAT ITS RUN RECORDS, AND ASKS NOTHING', async () => {
    const asked: string[] = [];
    const counting: Fetch = async (url, init) => { asked.push(url); return record(url, init); };
    const draft: OpenedPayslip = { ...slip('run_oct', '2026-10', ACME, value(7)), status: 'draft', receipt: null };
    const html = renderToStaticMarkup(
      <PayslipTable slips={[draft]} words={await wordsForSlips([draft], counting)} />);
    expect(paidCells(html, 'run_oct')).toEqual(['Not sent for approval yet', 'No']);
    expect(asked).toEqual([]);
  });
});
