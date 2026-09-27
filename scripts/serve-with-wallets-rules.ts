/**
 * THE RULES THE STAGENET LAUNCHER REFUSES BY, IN A FILE THAT BRINGS NOTHING UP.
 *
 * The launcher brings up the wallet that pays, which takes a seed, a proof server, a
 * sync and minutes, and then serves a product that can spend a fee. Every
 * refusal it makes before that would otherwise be reachable only by arranging
 * all of it, so the refusals live here and are pinned without a wallet.
 */
import type { CreatePreconditions } from './create-company-rules.js';
import { refuseIncompleteSetup, PRECONDITIONS } from './create-company-rules.js';
import { pageStartsFor } from './serve-rules.js';
import type { ParameterOutcome } from '../src/server/proving-parameters.js';
import { PAIR_NETWORK } from '../src/midnight/network.js';

/**
 * The one network this launcher serves, which is the one both products are
 * compiled for.
 *
 * **IT IS NOT A SECOND NAME.** It used to be a string literal here, and a
 * literal that happens to match the constant is a literal that stops matching
 * the day the pair moves - leaving a launcher that refuses the only network its
 * own wallet can sign on.
 */
export const SERVED_NETWORK: string = PAIR_NETWORK;

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
 * **WHAT THIS LAUNCHER NEEDS: EVERYTHING THE COMPANY CREATOR DOES EXCEPT A
 * COMPANY WALLET.** It brings no company wallet up. Every transaction the
 * product sends moves no coins, so the company's side is one that holds nothing;
 * a company's money comes from its own signer's wallet, with the request that
 * needs it.
 */
export const SERVED_PRECONDITIONS: readonly (keyof CreatePreconditions)[] =
  PRECONDITIONS.filter(p => p !== 'companySeed');

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
  readonly present: Omit<CreatePreconditions, 'companySeed'>;
  readonly posture: Record<string, string>;
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
  const setup = refuseIncompleteSetup(input.present, SERVED_PRECONDITIONS);
  if (reasons.length === 0 && setup === null) return null;
  const head = reasons.length === 0
    ? ''
    : 'the product cannot be served with wallets from this machine:\n\n  '
      + reasons.join(';\n\n  ') + '.\n\nNothing has been brought up and nothing has been spent.';
  return [head, setup ?? ''].filter(Boolean).join('\n\n');
}

/**
 * **WHAT THE PAGE WILL PROVE WITH, SAID BEFORE IT IS SERVED.**
 *
 * The files a device proves with are fetched and checked before the page is
 * offered, so a person does not meet a missing one halfway through a deposit.
 * What could not be put in place is said here in plain words, with what it
 * breaks and what fixes it; the page is still served, because everything that
 * does not prove works without them.
 *
 * `inPlace` is false when anything a device will prove with is missing.
 */
export function parametersBeforeServing(o: ParameterOutcome, paramsDir: string): { inPlace: boolean; lines: string[] } {
  const lines: string[] = [];
  for (const f of o.fetched) lines.push(`fetched ${f.name} (${f.bytes} bytes) from ${f.from}, checked against its published digest`);
  for (const a of o.setAside) lines.push(`${a.from} was not the published file; it was renamed to ${a.to} and replaced`);
  const network = o.unread.filter((u) => u.startsWith('shielded ') && u.includes('(network)'));
  const other = o.unread.filter((u) => !network.includes(u));
  const problems: string[] = [];
  for (const m of o.missing) {
    problems.push(
      `${m.name} is not here and could not be fetched: ${m.why}. These will fail when the page proves them: `
      + `${m.circuits.join(', ')}. Let this machine reach the source named, or set MIDNIGHT_PARAM_SOURCE to one `
      + 'that serves it, then close this window and start it again');
  }
  if (network.length > 0) {
    problems.push(
      `the network's own shielded circuits could not be read from ${paramsDir}/zswap/9, so every private deposit `
      + 'and private payment will fail when the page proves it. Nothing fetches them yet: they come from the proof '
      + 'server\'s own cache. Put them in place, then close this window and start it again');
  }
  for (const u of other) problems.push(`${u}, so the page cannot prove this circuit until that is fixed`);
  if (problems.length === 0) {
    lines.push('every circuit the page proves has its proving parameters here, checked');
    return { inPlace: true, lines };
  }
  lines.push('THE PAGE WILL BE SERVED, BUT NOT EVERYTHING IT PROVES WITH IS IN PLACE:');
  for (const p of problems) lines.push(`  - ${p}.`);
  return { inPlace: false, lines };
}
