/**
 * THE RULES THE STAGENET LAUNCHER REFUSES BY, IN A FILE THAT BRINGS NOTHING UP.
 *
 * The launcher brings two wallets up, which takes a seed, a proof server, a
 * sync and minutes, and then serves a product that can spend a fee. Every
 * refusal it makes before that would otherwise be reachable only by arranging
 * all of it, so the refusals live here and are pinned without a wallet.
 */
import type { CreatePreconditions } from './create-company-rules.js';
import { refuseIncompleteSetup } from './create-company-rules.js';
import { pageStartsFor } from './serve-rules.js';

/** The one network this launcher serves. */
export const SERVED_NETWORK = 'stagenet';

/**
 * Settings the development script declares that this launcher does NOT carry.
 *
 * **`ALLOW_SIMULATED_COMPANY_ADDRESS` IS THE ONE, AND IT IS LEFT BEHIND ON
 * PURPOSE.** It lets a person unlock a company whose address this machine
 * invented. Every company this launcher can create has an address a chain
 * assigned, so the setting buys nothing here and would only widen what a
 * server that can spend will accept.
 */
export const POSTURE_NOT_CARRIED: readonly string[] = ['ALLOW_SIMULATED_COMPANY_ADDRESS'];

/** What the served product and its two pages cannot run without. */
export const POSTURE_REQUIRED: readonly string[] = [
  'APP_ORIGIN', 'WALLET_ORIGIN', 'VITE_WALLET_ORIGIN',
];

/**
 * The development posture, read off the development script's own command line.
 *
 * **READ, NOT RESTATED.** The origins the server checks signatures against and
 * the origin the page opens the wallet at are declared once, in the script a
 * developer runs; a second copy here would agree until somebody edited one.
 * Only the leading `NAME=VALUE` assignments count, and a name assigned nothing
 * does not count as set.
 */
export function postureFrom(devScript: string): Record<string, string> {
  const lead = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/.exec(devScript)?.[0] ?? '';
  const out: Record<string, string> = {};
  for (const a of lead.split(/\s+/).filter(Boolean)) {
    const eq = a.indexOf('=');
    const name = a.slice(0, eq);
    const value = a.slice(eq + 1);
    if (value.length === 0) continue;
    if (POSTURE_NOT_CARRIED.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * **WHETHER TWO SEED FILES WOULD BRING UP ONE WALLET.** Compared after the
 * differences that do not change which wallet a seed makes - surrounding space,
 * letter case and a leading `0x` - so a copy that differs only in those is still
 * caught. Two seeds that differ in any other way are two wallets.
 */
export function seedsAreOneParty(first: string, second: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^0x/, '');
  return norm(first) === norm(second);
}

/**
 * Everything knowable before a wallet is brought up, refused at once.
 *
 * **EVERY MISSING PIECE IS NAMED, NOT THE FIRST.** A launcher that stops at the
 * first is a launcher somebody runs five times, each run minutes of waiting for
 * a wallet to sync before the next refusal arrives.
 */
export function refuseToServe(input: {
  readonly network: string;
  readonly present: CreatePreconditions;
  readonly posture: Record<string, string>;
  /** True when both seed files are on this machine and would bring up one wallet. */
  readonly oneSeedForBoth: boolean;
}): string | null {
  const reasons: string[] = [];
  if (input.network !== SERVED_NETWORK) {
    reasons.push(
      `this launcher serves ${SERVED_NETWORK} and nothing else, and this machine is set to `
      + `"${input.network}". A server that can spend is a thing to start on one network on `
      + 'purpose, not on whichever one a setting happened to name');
  }
  const missingPosture = POSTURE_REQUIRED.filter(n => !input.posture[n]);
  if (missingPosture.length > 0) {
    reasons.push(
      `the development script no longer declares ${missingPosture.join(', ')}. Without them `
      + 'the server refuses every wallet sign-in and the page has no wallet to open, so '
      + 'nobody could reach the button this launcher exists for');
  }
  if (missingPosture.length === 0) {
    const plan = pageStartsFor(input.posture);
    if ('refusals' in plan) {
      reasons.push(
        'the development script\'s origins cannot be started as they are: ' + plan.refusals.join('; '));
    }
  }
  if (input.oneSeedForBoth) {
    reasons.push(
      'the wallet that pays and the company wallet have the same seed on this machine, so they '
      + 'would be one wallet. They are meant to be two parties - one pays the fees, the other '
      + 'balances and signs the company\'s own part of each transaction - and with one seed both '
      + 'jobs fall to one wallet while everything else reports two. Give the company wallet a seed '
      + 'of its own');
  }
  const setup = refuseIncompleteSetup(input.present);
  if (reasons.length === 0 && setup === null) return null;
  const head = reasons.length === 0
    ? ''
    : 'the product cannot be served with wallets from this machine:\n\n  '
      + reasons.join(';\n\n  ') + '.\n\nNothing has been brought up and nothing has been spent.';
  return [head, setup ?? ''].filter(Boolean).join('\n\n');
}
