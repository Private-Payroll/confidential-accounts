/*
 * A write over a test's own send goes through a view of the company, so a company another seat filed in meanwhile
 * stops the write before it is sent.
 */
import { describe, expect, it } from 'vitest';
import { CompanyChangedMeanwhile } from 'vaults-web-shared/company-view-probe.js';
import { NOTHING_FILED, writesOver } from './writes-over-a-send.js';

const CO = 'acc_writes';

/** A send that answers the directory with no filing the first `unchanged` times it is asked and one filing after, and logs each write. */
const aSend = (unchanged: number) => {
  let asked = 0;
  const written: string[] = [];
  const send = async (path: string, init: { readonly method: string }) => {
    if (path.endsWith('/directory')) return { status: 200, body: { filings: ++asked > unchanged ? [{ company: CO, version: 1 }] : [] } };
    if (init.method !== 'GET' && !path.endsWith('/manifest/newest')) written.push(`${init.method} ${path}`);
    return { status: 201, body: {} };
  };
  return { send, written };
};

describe('A WRITE OVER A TEST\'S SEND IS CHECKED AGAINST THE COMPANY BEFORE IT IS SENT', () => {
  it('sends a write when no other seat filed meanwhile', async () => {
    const { send, written } = aSend(Infinity);
    await writesOver(send, { ...NOTHING_FILED, directory: true })(CO, { to: 'fee', body: {} });
    expect(written).toEqual([`POST /api/accounts/${CO}/fee`]);
  });

  it('stops a write and sends nothing when another seat filed in the directory meanwhile', async () => {
    const { send, written } = aSend(1);
    /* RED WHEN: a write over a test's send is made with no view, so a company another seat filed in meanwhile does not stop it. */
    await expect(writesOver(send, { ...NOTHING_FILED, directory: true })(CO, { to: 'fee', body: {} })).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(written).toEqual([]);
  });
});
