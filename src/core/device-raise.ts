/**
 * **WHAT A PAGE THAT RAISES A PAYROLL PROPOSAL ON ITS OWN DEVICE TELLS THE
 * SERVICE, AND THE ONE PLACE BOTH SIDES READ IT FROM.**
 *
 * A raise built on a signer's device has its private payments checked against
 * the vault's notes there, because the notes are opened nowhere else. The
 * service cannot repeat that check; what it can do is refuse a raise or a send
 * that does not come from a page it knows performs it, and refuse one whose
 * payments are not the ones the page checked. Two values carry that:
 *
 *   the version   of this exchange, sent with every raise and every send. A page
 *                 that names no version, or another one, is a page that may not
 *                 check anything - one loaded before the check existed, or not a
 *                 page at all - and is told to reload.
 *   the digest    of the payments the page checked: each one's kind, token and
 *                 amount, in the order the service handed them over. Nothing
 *                 about who is paid, and nothing about the vault's notes or
 *                 balance: only what the service itself handed over, so the
 *                 service can compute the same digest over what it is about to
 *                 raise or send and refuse a mismatch.
 *
 * Both are imported by the page and by the service from here, so the two can
 * never be written differently.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * **THE VERSION OF THE DEVICE-RAISE EXCHANGE.** Raised whenever what a page must
 * do before a device raise or send changes, so that a page still running the
 * earlier code is refused rather than trusted.
 */
export const DEVICE_RAISE_VERSION = 1 as const;

/** One payment as it was checked: its payee's kind, its token and its amount. */
export type PaymentChecked = readonly [kind: string, token: string, amount: string | bigint];

const DOMAIN = 'device-raise/payments-checked/1\n';

/**
 * **THE DIGEST OF THE PAYMENTS A DEVICE CHECKED, OR THAT THE SERVICE IS ABOUT
 * TO RAISE OR SEND.** Order matters: the payments are in the order the run's
 * tree is built in, and two runs paying the same amounts to different people in
 * a different order are different runs. An amount is taken as a whole number
 * and written without leading zeroes, so a string and a bigint of one amount
 * digest the same; anything that is not a whole number is refused rather than
 * digested.
 */
export function paymentsCheckedDigest(payments: Iterable<PaymentChecked>): string {
  const rows: string[][] = [];
  for (const [kind, token, amount] of payments) {
    const whole = typeof amount === 'bigint' ? amount : /^[0-9]+$/u.test(amount) ? BigInt(amount) : null;
    if (whole === null || whole < 0n) {
      throw new Error(`a payment amount of ${String(amount)} is not a whole number, so the payments cannot be compared.`);
    }
    rows.push([String(kind), String(token).toLowerCase(), whole.toString()]);
  }
  return bytesToHex(sha256(utf8ToBytes(DOMAIN + JSON.stringify(rows))));
}

/** A digest as the wire carries it: sixty-four lower-case hexadecimal characters. */
export const DIGEST_SHAPE = /^[0-9a-f]{64}$/u;

/*
 * **THE REFUSALS, WORDED SO THE REFUSAL LOG KEEPS THEM.** The log hides any run
 * of twelve or more short words as a possible recovery phrase, so each sentence
 * here breaks its runs with punctuation or a short word; a test holds them to it.
 */

/** A device raise that does not say what it checked. */
export const RAISE_NAMES_NOTHING_CHECKED = 'this raise does not say which payments the device checked, so it cannot be '
  + 'told apart from one that checked nothing. Reload the page and try again. Nothing was written down.';

/** A device raise whose payments are not the ones the service would raise now. */
export const RAISE_IS_NOT_WHAT_WAS_CHECKED = 'the run changed after this device checked it against the vault: what it '
  + 'would raise now is not what was checked. Raise it again, so the device checks what will be raised. '
  + 'Nothing was written down.';

/** A device send whose payments are not the proposal written down. */
export const SEND_IS_NOT_WHAT_WAS_CHECKED = 'the proposal written down for this run is not what this device checked '
  + 'against the vault just now. Send it again, so the device checks what will be sent. Nothing was sent.';

/**
 * **THE SENTENCE A PAGE THAT IS NOT THE CURRENT VERSION IS REFUSED WITH.** It
 * says what resolves it: reloading the page loads the version that checks the
 * vault on the device.
 */
export const reloadThePage = (named: unknown, nothing: 'Nothing was written down.' | 'Nothing was sent.'): string =>
  `this page is out of date: it ${named === undefined ? 'names no version' : `names version ${String(JSON.stringify(named)).slice(0, 40)}`} `
  + `of the raise it is sending, and this service accepts version ${DEVICE_RAISE_VERSION}, which checks on this `
  + `device that the vault can pay before anything is written down or sent. Reload the page and try again. ${nothing}`;
