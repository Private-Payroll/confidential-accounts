import React, { useState } from 'react';
import { assets, formatAmount } from '../core/assets.js';
import { payslipKeypairFrom } from '../core/payslip-key-derive.js';
import type { OpenedPayslip } from '../core/payslip-open.js';
import * as keyring from './keyring.js';
import { shownError } from './shown-error.js';
import { WALLET_ORIGIN } from './Auth.js';
import { askWalletToUnlock } from './wallet-unlock.js';
import { openWalletDialog } from './wallet-sign-in.js';
import { walletInThisPage } from './wallet-frame.js';
import { US_TO_A_WALLET } from './Join.js';
import {
  fetchMyPayslips, payslipAddressesFor, rememberedCompanies, rememberCompany, tidyCompanyAddress,
} from './my-payslips.js';

export { YOUR_PAY_PATH } from './my-payslips.js';

/**
 * The words for one payslip's payment, from the run's own facts. Exported so a
 * test can hold each case against what the screen prints.
 *
 * **WHAT A RUN RECORDS IS WHETHER IT WAS SENT FOR APPROVAL, NOT WHETHER ITS
 * PAYEES WERE PAID.** A run sent for approval is paid leg by leg out of a
 * vault, and the payment is recorded on the company's account against a
 * value this page does not hold. So a sent run says that it cannot tell, and
 * never that nothing was paid. A run is said to be paid on a chain only when
 * it is marked settled and the ledger that wrote it was a chain; a settled run
 * written by a rehearsal ledger moved no money.
 */
export function paymentWords(p: Pick<OpenedPayslip, 'status' | 'settledAt' | 'wiring'>): {
  paid: string; onChain: string;
} {
  if (p.status === 'draft') return { paid: 'Not sent for approval yet', onChain: 'No' };
  if (p.status === 'proposed') {
    return {
      paid: 'Sent for approval. This page cannot tell yet whether it has been paid',
      onChain: 'Not known',
    };
  }
  const when = p.settledAt ? new Date(p.settledAt).toLocaleDateString('en-GB') : 'date not recorded';
  if (p.wiring === 'chain') return { paid: when, onChain: 'Yes' };
  if (p.wiring === 'simulated') {
    return { paid: 'No: a rehearsal, nothing was sent', onChain: 'No' };
  }
  return { paid: 'Not known', onChain: 'Not recorded' };
}

const amountOf = (p: OpenedPayslip): string => {
  const asset = assets.find(p.payslip.asset);
  return asset
    ? `${formatAmount(p.payslip.amount, asset)} ${asset.code}`
    : `${p.payslip.amount.toString()} (smallest units of ${p.payslip.asset})`;
};

const short = (address: string | null): string =>
  address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'none';

/**
 * **YOUR PAYSLIPS, OPENED WITH YOUR OWN WALLET.**
 *
 * For each company address this browser has been told about, the wallet is
 * asked for its key for that company, the payslip key is worked out from it
 * here, and the slips sealed to that key are fetched and opened on this
 * device. The key is not sent, not saved and not shown; closing the tab
 * forgets it.
 */
export function YourPay({ onBack }: { onBack: () => void }) {
  const [companies, setCompanies] = useState<string[]>(() => rememberedCompanies());
  const [adding, setAdding] = useState('');
  const [slips, setSlips] = useState<OpenedPayslip[] | null>(null);
  const [unopened, setUnopened] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = () => {
    const tidy = tidyCompanyAddress(adding);
    if (tidy === null) {
      setErr('That is not a company address. It is 64 characters of 0-9 and a-f; the company '
        + 'that pays you can tell you theirs.');
      return;
    }
    setErr('');
    setCompanies(rememberCompany(tidy));
    setAdding('');
  };

  const open = async () => {
    setErr(''); setBusy(true);
    let dialog;
    let stopShowing: (() => void) | null = null;
    try {
      if (!WALLET_ORIGIN) {
        throw new Error('this site cannot open your wallet, because it was set up without your '
          + 'wallet\'s address. Tell the company that pays you.');
      }
      if (companies.length === 0) {
        throw new Error('add the address of a company that pays you first.');
      }
      /* Opened in the click, before any round trip, as every wallet ask here is. */
      const host = walletInThisPage(window);
      dialog = openWalletDialog(host, WALLET_ORIGIN);
      stopShowing = keyring.showWaitingFor(dialog);
      dialog.moreThanOneAsk();

      /* Every address each company's slips were sealed under, so a company
       * that has moved still opens the slips from before it did. */
      const addresses = new Set<string>();
      for (const company of companies) {
        const named = await payslipAddressesFor(company).catch(() => [] as string[]);
        for (const a of [company, ...named]) addresses.add(a);
      }

      /* Each address on its own, so one the wallet refuses, or one that is not
       * answered, does not hide the payslips of every other. */
      const found: OpenedPayslip[] = [];
      let notOpened = 0;
      const missed: string[] = [];
      for (const address of addresses) {
        try {
          const companyKey = await askWalletToUnlock(host, WALLET_ORIGIN, {
            company: address,
            atOrigin: window.location.origin,
            name: US_TO_A_WALLET.name,
            rdns: US_TO_A_WALLET.rdns,
          }, dialog);
          const mine = await fetchMyPayslips(payslipKeypairFrom(companyKey));
          found.push(...mine.opened);
          notOpened += mine.unopened;
        } catch (e) {
          missed.push(`${short(address)}: ${shownError(e, 'opening payslips for one company address')}`);
        }
      }
      found.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
      setSlips(found);
      setUnopened(notOpened);
      if (missed.length > 0) {
        setErr('Payslips for these company addresses could not be opened, so none from them are '
          + `shown: ${missed.join('; ')}`);
      }
    } catch (e) {
      setErr(shownError(e, 'opening your payslips'));
    } finally {
      dialog?.giveUp();
      stopShowing?.();
      setBusy(false);
    }
  };

  return (
    <div className="authwrap" data-your-pay>
      <div className="authcard wide">
        <div className="authmark">CA</div>
        <h1>Your payslips</h1>
        <p className="authsub">
          The key that opens your payslips is worked out on this device from your wallet. It is
          not sent to us or saved here, and nobody else holds it, including the company.
        </p>

        <div className="field">
          <label>Companies that pay you</label>
          {companies.length === 0
            ? <p className="authsub">None yet on this device.</p>
            : <ul data-companies>{companies.map(c => <li key={c}><code>{c}</code></li>)}</ul>}
        </div>
        <form className="acctnew" onSubmit={e => { e.preventDefault(); add(); }}>
          <input value={adding} onChange={e => setAdding(e.target.value)}
            placeholder="Add a company's address" />
          <button type="submit" disabled={busy || adding.trim() === ''}>Add</button>
        </form>

        {err && <div className="err">{err}</div>}

        <button type="button" className="primary" disabled={busy || companies.length === 0}
          onClick={open}>
          {busy ? 'Waiting for your wallet' : 'Open my wallet and show my payslips'}
        </button>
        <p className="authsub">
          Your wallet asks you to approve each company address, including any address the
          company used before.
        </p>

        {slips !== null && (
          slips.length === 0
            ? (unopened === 0 && (
                <p className="authsub" data-no-payslips>
                  No payslips were found for you at these company addresses.
                </p>))
            : <table data-payslips>
                <thead><tr>
                  <th>Period</th><th>Amount</th><th>Paid</th><th>On the chain</th><th>Company address</th>
                </tr></thead>
                <tbody>
                  {slips.map(s => {
                    const w = paymentWords(s);
                    return (
                      <tr key={s.runId} data-payslip={s.runId}>
                        <td>{s.period}</td>
                        <td>{amountOf(s)}</td>
                        <td>{w.paid}</td>
                        <td>{w.onChain}</td>
                        <td title={s.issuedBy ?? ''}>{short(s.issuedBy)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
        )}
        {slips !== null && slips.length > 0 && (
          <p className="authsub">
            This lists your payslips. Money that reached you shows in your wallet's private
            balance.
          </p>
        )}
        {unopened > 0 && (
          <div className="err" data-unopened>
            {unopened} payslip{unopened === 1 ? '' : 's'} sent to you did not open with the key from
            your wallet, so {unopened === 1 ? 'it is' : 'they are'} not shown. Ask the company that
            pays you to check {unopened === 1 ? 'it' : 'them'}.
          </div>
        )}

        <button type="button" className="ghost" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
