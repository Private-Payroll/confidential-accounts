import React, { useState } from 'react';
import { assets, formatAmount } from '../core/assets.js';
import { payslipKeypairFrom } from '../core/payslip-key-derive.js';
import type { OpenedPayslip } from '../core/payslip-open.js';
import * as keyring from './keyring.js';
import { shownError } from './shown-error.js';
import { WALLET_ORIGIN } from './Auth.js';
import { askWalletToUnlockAndWhereItReads, type HeldAddresses } from './wallet-unlock.js';
import { openWalletDialog } from './wallet-sign-in.js';
import { walletInThisPage } from './wallet-frame.js';
import { US_TO_A_WALLET } from './Join.js';
import {
  fetchMyPayslips, payslipAddressesFor, paymentsOnTheChain, readTheChain, PageOutOfDate,
  type Fetch, type OnTheChain, type MyPayslips,
} from './my-payslips.js';
import { payslipReader, type ChainReader } from './payslip-worker-client.js';
import { listHolds, type WalletIndexer } from 'midnight-identity/profile/unlock';

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

/**
 * **THE WORDS FOR ONE PAYSLIP, WHEN THE CHAIN WAS ASKED ABOUT IT.** A run
 * written by a rehearsal ledger moved no money and says so whatever else is
 * known; otherwise what this device read of the company's record of completed
 * payments is what is said, and without an answer the run's own facts are.
 * "Not yet" appears only when that record was read, does not hold this
 * payment, and the payment can still be made.
 *
 * **"RECORDED AS PAID", NOT "PAID".** The record is the company's account
 * saying the payment was made; the money reaching the payee is shown by their
 * own wallet, and `PAID_MEANS` says so under the table.
 */
export function paidWords(
  p: Pick<OpenedPayslip, 'status' | 'settledAt' | 'wiring'>, chain: OnTheChain | undefined,
): { paid: string; onChain: string } {
  if (p.wiring === 'simulated' || chain === undefined) return paymentWords(p);
  if (chain === 'paid') return { paid: 'Recorded as paid', onChain: 'Yes' };
  if (chain === 'not-yet') return { paid: 'Not yet', onChain: 'Not yet' };
  return { paid: 'Cannot tell', onChain: 'Not known' };
}

/** What a row says about payment. */
export type PaymentWords = ReturnType<typeof paidWords>;

/** The sentence under the table, word for word as it was ruled. */
export const PAID_MEANS = 'Paid means the company\'s account records your payment as made. Check that the '
  + 'amount reached your wallet\'s private balance.';

/**
 * The words for every slip, keyed by run: the company's record read by this
 * device once per company for the slips that carry a receipt, and the run's
 * own facts for the rest. Every slip handed in has an entry.
 */
export async function wordsForSlips(
  slips: OpenedPayslip[], reader: ChainReader | null, indexer: WalletIndexer | null,
  confirmed: (slip: OpenedPayslip) => boolean, nowSeconds?: number,
): Promise<Map<string, PaymentWords>> {
  const chain = await paymentsOnTheChain(slips, reader, indexer, confirmed, nowSeconds);
  return new Map(slips.map(s => [s.runId, paidWords(s, chain.get(s.runId))]));
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
 * What the wallet hands back for one company address: its key, where it reads
 * the chain, and its digests of the addresses it holds (`null` when it gave none).
 */
export type Release = (address: string) => Promise<{
  key: Uint8Array; indexer: WalletIndexer | null; held?: HeldAddresses | null;
}>;

/** What one company's addresses gave up, before the chain is asked about any of it. */
export interface OpenedAtCompany {
  found: OpenedPayslip[];
  /** Slips sent for a key that did not open them. */
  notOpened: number;
  /** Slips that opened and named a company address other than the one asked for. */
  refused: number;
  /** One line per address that could not be opened. */
  missed: string[];
  /** Where the wallet reads the chain, as it named it with the first key it gave. */
  indexer: WalletIndexer | null;
  /**
   * Whether the wallet confirmed it holds the address a slip was paid to,
   * checked against what it said with the key that opened that slip. `false`
   * for every slip it said nothing about.
   */
  confirmed: (slip: OpenedPayslip) => boolean;
}

/**
 * **EVERY ADDRESS OPENED, EACH ON ITS OWN.** One the wallet refuses, or one
 * that is not answered, does not hide the payslips of every other. A service
 * that says this page is out of date stops the whole of it, because every
 * other address would be told the same.
 *
 * @param opened how one address's slips are fetched and opened; injectable so
 *   the whole of this can be driven without a wallet or a service.
 */
export async function openAddresses(
  addresses: Iterable<string>, release: Release,
  opened: (keys: ReturnType<typeof payslipKeypairFrom>, address: string) => Promise<MyPayslips>
    = (keys, address) => fetchMyPayslips(keys, address),
): Promise<OpenedAtCompany> {
  const found: OpenedPayslip[] = [];
  let notOpened = 0;
  let refused = 0;
  const missed: string[] = [];
  let indexer: WalletIndexer | null = null;
  const heldWith = new Map<OpenedPayslip, HeldAddresses | null>();
  for (const address of addresses) {
    try {
      const released = await release(address);
      indexer ??= released.indexer;
      const mine = await opened(payslipKeypairFrom(released.key), address);
      for (const slip of mine.opened) heldWith.set(slip, released.held ?? null);
      found.push(...mine.opened);
      notOpened += mine.unopened;
      refused += mine.refused;
    } catch (e) {
      if (e instanceof PageOutOfDate) throw e;
      missed.push(`${short(address)}: ${shownError(e, 'opening payslips for one company address')}`);
    }
  }
  found.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  const confirmed = (slip: OpenedPayslip): boolean => {
    const held = heldWith.get(slip);
    const paidTo = slip.payslip.paidTo;
    return held !== undefined && held !== null && typeof paidTo === 'string'
      && listHolds(held.digests, held.scope, paidTo);
  };
  return { found, notOpened, refused, missed, indexer, confirmed };
}

/**
 * **EVERY ADDRESS OPENED, AND WHETHER EACH SLIP WAS PAID READ BY THIS DEVICE.**
 * The indexer is the one the wallet named with its key. The reader is this
 * page's own worker, so whether a slip was paid is read from the company's
 * contract through that indexer and is never asked of this application's
 * service.
 */
export async function openAndRead(
  addresses: Iterable<string>, release: Release,
  opened?: (keys: ReturnType<typeof payslipKeypairFrom>, address: string) => Promise<MyPayslips>,
  reader: ChainReader = payslipReader(),
): Promise<{ found: OpenedPayslip[]; words: Map<string, PaymentWords>; notOpened: number; missed: string[] }> {
  const got = await openAddresses(addresses, release, opened);
  return {
    found: got.found, words: await wordsForSlips(got.found, reader, got.indexer, got.confirmed),
    notOpened: got.notOpened, missed: got.missed,
  };
}

/* ------------------------------------------------------------------ */
/* the words this view shows, each exactly as it was approved           */
/* ------------------------------------------------------------------ */

/** While this device reads the company's record of completed payments. */
export const checkingTheChain = (company: string): string => `Checking the chain for ${company}…`;

/** When the wallet named no indexer, or the read failed. */
export const COULD_NOT_READ_THE_CHAIN = 'We could not read the chain for this company, so we cannot say '
  + 'whether you were paid. Check your wallet\'s private balance.';

/** When slips opened and named a company address they were not opened for. */
export const withheldSlips = (n: number): string =>
  `${n} payslip(s) named a company address you did not open them for, so they are not shown. `
  + 'Tell the company that pays you.';

/* ------------------------------------------------------------------ */
/* one company that pays you                                            */
/* ------------------------------------------------------------------ */

/** What the view needs from outside itself. Each is replaced in a test; the page uses the defaults. */
export interface EmployerViewDeps {
  /**
   * Opens the wallet, in the click, and gives back how to ask it for one
   * address's key and how to put it away.
   */
  askTheWallet: () => { release: Release; done: () => void };
  /** Every address this company's payslips were sealed under. */
  addressesOf: (company: string) => Promise<string[]>;
  /** One address's slips, fetched and opened on this device. */
  opened: (keys: ReturnType<typeof payslipKeypairFrom>, address: string) => Promise<MyPayslips>;
  /** This page's own reader of the company's contract. */
  reader: () => ChainReader;
}

/** Every request says who this tab was prepared for, so a sign-in changed in another tab is refused. */
const asWhoThisTabIsFor: Fetch = (url, init) => {
  const who = keyring.currentUser();
  return fetch(url, {
    ...init,
    headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}), ...(who ? { 'x-signed-in-as': who.id } : {}) },
  });
};

const theWallet = (): { release: Release; done: () => void } => {
  if (!WALLET_ORIGIN) {
    throw new Error('this site cannot open your wallet, because it was set up without your '
      + 'wallet\'s address. Tell the company that pays you.');
  }
  const walletOrigin = WALLET_ORIGIN;
  /* Opened in the click, before any round trip, as every wallet ask here is. */
  const host = walletInThisPage(window);
  const dialog = openWalletDialog(host, walletOrigin);
  const stopShowing = keyring.showWaitingFor(dialog);
  dialog.moreThanOneAsk();
  return {
    release: (address) => askWalletToUnlockAndWhereItReads(host, walletOrigin, {
      company: address,
      atOrigin: window.location.origin,
      name: US_TO_A_WALLET.name,
      rdns: US_TO_A_WALLET.rdns,
    }, dialog),
    done: () => { dialog.giveUp(); stopShowing(); },
  };
};

export const onThisPage: EmployerViewDeps = {
  askTheWallet: theWallet,
  addressesOf: (company) => payslipAddressesFor(company, asWhoThisTabIsFor),
  opened: (keys, address) => fetchMyPayslips(keys, address, asWhoThisTabIsFor),
  reader: payslipReader,
};

/**
 * **A COMPANY THAT PAYS YOU, AS YOU SEE IT: YOUR PAYSLIPS FROM IT AND NOTHING
 * ELSE.** No roster, no runs, no approvals; nothing a signer sees.
 *
 * The wallet is asked for its key for this company, and for every address the
 * company's payslips were sealed under before, the payslip key is worked out
 * from it here, and the slips sealed to that key are fetched and opened on this
 * device. They are shown as soon as they are open; whether each was paid is
 * read afterwards, from the company's own contract, and filled in when that
 * read finishes. The key is not sent, not saved and not shown; closing the tab
 * forgets it.
 */
export function EmployerView({ company, onBack, deps = onThisPage }: {
  company: string; onBack: () => void; deps?: EmployerViewDeps;
}) {
  const [slips, setSlips] = useState<OpenedPayslip[] | null>(null);
  const [words, setWords] = useState<Map<string, PaymentWords>>(() => new Map());
  const [unopened, setUnopened] = useState(0);
  const [refused, setRefused] = useState(0);
  const [missedAny, setMissedAny] = useState(false);
  const [checking, setChecking] = useState(false);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = async () => {
    setErr(''); setBusy(true); setSlips(null); setUnopened(0); setRefused(0); setUnread(false); setMissedAny(false);
    let wallet: { release: Release; done: () => void } | null = null;
    try {
      wallet = deps.askTheWallet();
      /* Every address this company's slips were sealed under, so a company
       * that has moved still opens the slips from before it did. */
      const named = await deps.addressesOf(company).catch((e) => {
        if (e instanceof PageOutOfDate) throw e;
        return [] as string[];
      });
      const got = await openAddresses(new Set([company, ...named]), wallet.release, deps.opened);
      wallet.done(); wallet = null;
      /* Shown now, with what the run itself says; the chain is read next. */
      setSlips(got.found);
      setWords(new Map(got.found.map(s => [s.runId, paymentWords(s)])));
      setUnopened(got.notOpened);
      setRefused(got.refused);
      setMissedAny(got.missed.length > 0);
      if (got.missed.length > 0) {
        setErr('Payslips for these company addresses could not be opened, so none from them are '
          + `shown: ${got.missed.join('; ')}`);
      }
      if (got.found.some(s => s.receipt)) {
        setChecking(true);
        const read = await readTheChain(got.found, deps.reader(), got.indexer, got.confirmed);
        setWords(new Map(got.found.map(s => [s.runId, paidWords(s, read.chain.get(s.runId))])));
        setUnread(read.couldNotRead);
      }
    } catch (e) {
      setErr(shownError(e, 'opening your payslips'));
    } finally {
      wallet?.done();
      setChecking(false);
      setBusy(false);
    }
  };

  return (
    <div className="authwrap" data-employer-view>
      <div className="authcard wide">
        <div className="authmark">CA</div>
        <h1>Your payslips</h1>
        <p className="authsub"><code data-company>{company}</code></p>
        <p className="authsub">
          The key that opens your payslips is worked out on this device from your wallet. It is
          not sent to us or saved here, and nobody else holds it, including the company.
        </p>

        {err && <div className="err" data-error>{err}</div>}

        <button type="button" className="primary" disabled={busy} onClick={open}>
          {busy && !checking ? 'Waiting for your wallet' : 'Open my wallet and show my payslips'}
        </button>
        <p className="authsub">
          Your wallet asks you to approve each company address, including any address the
          company used before.
        </p>

        {checking && <p className="authsub" data-checking>{checkingTheChain(short(company))}</p>}
        {unread && <div className="err" data-could-not-read>{COULD_NOT_READ_THE_CHAIN}</div>}

        {slips !== null && (
          slips.length === 0
            ? (unopened === 0 && refused === 0 && !missedAny && (
                <p className="authsub" data-no-payslips>
                  No payslips were found for you at these company addresses.
                </p>))
            : <PayslipTable slips={slips} words={words} />
        )}
        {refused > 0 && <div className="err" data-withheld>{withheldSlips(refused)}</div>}
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

/** The payslips, one row each, with the words already worked out for each, and what "paid" means under them. */
export function PayslipTable({ slips, words }: {
  slips: OpenedPayslip[]; words: Map<string, PaymentWords>;
}) {
  return (
    <>
      <table data-payslips>
        <thead><tr>
          <th>Period</th><th>Amount</th><th>Paid</th><th>On the chain</th><th>Company address</th>
        </tr></thead>
        <tbody>
          {slips.map(s => {
            const w = words.get(s.runId) ?? paymentWords(s);
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
      <p className="authsub" data-paid-means>{PAID_MEANS}</p>
    </>
  );
}
