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

/** How long the pages have to start answering before the launcher gives up and says which did not. */
export const PAGES_START_WITHIN_MS = 180_000;

/** What is known about the pages while the launcher waits for them. */
export interface PagesSoFar {
  /** Every page started, by the label a person reads. */
  readonly labels: readonly string[];
  /** The pages that have answered at their origin. */
  readonly answered: readonly string[];
  /** The pages whose process has ended, and how. */
  readonly ended: readonly { readonly label: string; readonly code: number | null; readonly signal: string | null }[];
  /** How long it has waited so far. */
  readonly waitedMs: number;
}

/**
 * **READY ONLY WHEN EVERY PAGE'S ORIGIN ANSWERS AND NO PAGE IT STARTED HAS
 * ENDED, AND A PAGE THAT ENDED IS NAMED.** A page that stops on start - its
 * port taken, its configuration broken - would otherwise leave a launcher
 * saying READY over an address where nothing is served, and a person opening
 * it would meet a browser error with no reason given. That the answer comes
 * from this launcher's own page, and not from something already on the port,
 * is `somethingAlreadyServes`'s question, asked before any page is started.
 *
 * `wait` means ask again. A page that ended is a refusal even if it had
 * answered before, because what it answered is no longer being served.
 */
export function pagesVerdict(s: PagesSoFar, limitMs: number = PAGES_START_WITHIN_MS):
  { ready: true } | { wait: true } | { refusal: string } {
  if (s.ended.length > 0) {
    const how = s.ended.map((e) => `${e.label} stopped (${e.signal ? `signal ${e.signal}` : `exit ${e.code}`})`);
    return {
      refusal: `${how.join('; ')}, so nothing was offered as ready. `
        + 'What resolves it: the page\'s own lines above say why it stopped - most often another process '
        + 'is already serving on its port; stop that one, then run this again.',
    };
  }
  const missing = s.labels.filter((l) => !s.answered.includes(l));
  if (missing.length === 0) return { ready: true };
  if (s.waitedMs < limitMs) return { wait: true };
  return {
    refusal: `${missing.join(' and ')} did not answer within ${Math.round(limitMs / 1000)} seconds of being started, `
      + 'so nothing was offered as ready. What resolves it: read the page\'s own lines above for an error; '
      + 'if there is none, the machine is slow to start it - run this again.',
  };
}

/** Asks one origin whether a page answers there: true for a success status, false for anything else or no answer. */
export type AnswersAt = (origin: string) => Promise<boolean>;

/** The one thing the wait needs from a started page's process: to hear when it ends. */
export interface EndsOnce {
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * **ASKED BEFORE ANY PAGE IS STARTED: DOES SOMETHING ALREADY ANSWER WHERE A
 * PAGE IS ABOUT TO BE SERVED?** If it does, the page this launcher starts
 * cannot take the port, and the answer the wait then hears would be that other
 * process's - so READY would be printed over a page this launcher does not
 * serve, on the origin the server trusts for sign-in. Refused instead, naming
 * the origin, with nothing started.
 */
export async function somethingAlreadyServes(
  starts: readonly { readonly label: string; readonly origin: string }[], answersAt: AnswersAt,
): Promise<string | null> {
  const taken: string[] = [];
  for (const s of starts) if (await answersAt(s.origin)) taken.push(`${s.origin} (${s.label})`);
  if (taken.length === 0) return null;
  return `something is already serving at ${taken.join(' and ')}, before this launcher started its own page `
    + 'there, so no page was started and nothing was offered as ready. What resolves it: stop whatever is '
    + 'serving there - another launcher, the development server, or a page left running - then run this again.';
}

/**
 * **WAITS UNTIL EVERY PAGE STARTED ANSWERS AT ITS ORIGIN, WATCHING EACH PAGE'S
 * PROCESS AS IT GOES**, and throws `pagesVerdict`'s words when one ended or the
 * wait ran out. `started` is in the order of `starts`. A page that answers is
 * asked once more a pass later, so a process that answers and then dies at
 * once is caught here rather than after READY.
 */
export async function waitForThePages(o: {
  readonly starts: readonly { readonly label: string; readonly origin: string }[];
  readonly started: readonly EndsOnce[];
  readonly answersAt: AnswersAt;
  readonly pause?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly limitMs?: number;
}): Promise<void> {
  const pause = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const ended: { label: string; code: number | null; signal: string | null }[] = [];
  o.started.forEach((child, i) => child.once('exit', (code, signal) => {
    ended.push({ label: o.starts[i]!.label, code, signal: signal ?? null });
  }));
  const answered = new Set<string>();
  const from = now();
  let readyOnce = false;
  for (;;) {
    for (const s of o.starts) {
      if (!answered.has(s.label) && await o.answersAt(s.origin)) answered.add(s.label);
    }
    const v = pagesVerdict({
      labels: o.starts.map((s) => s.label), answered: [...answered], ended, waitedMs: now() - from,
    }, o.limitMs);
    if ('refusal' in v) throw new Error(v.refusal);
    if ('ready' in v) {
      if (readyOnce) return;
      readyOnce = true;
    }
    await pause(1000);
  }
}
