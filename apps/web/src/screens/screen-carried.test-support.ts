/*
 * The records the service's answers to a screen's calls carried, and the records its reads asked. Each call is logged as it was
 * answered with the records its answer carried, each named, held to the rule the wallet's counts hold an answer to: a list
 * carries every record of its kind the service holds, each once; a read carries only the records it asked, each once, and a read
 * of every version of a company record carries exactly the versions the service has filed of it. What each read asked is counted
 * by route, call and kind, and held as the company grows to the same number, or to one more for each one more of what its kind
 * grows with, so a page that asks more records of one kind at a larger company is named; a press is held to the kinds it asks.
 */

import {
  askedByKind,
  carriedNotAsHeld,
  recordsCarried
} from '../../../wallet/src/actions/records-carried.test-support.js';
import type { CompanyHeld } from './company-harness.test-support.js';

/**
 * One call to the service as it was answered: the route it matched, its path and body, the records its answer carried, each
 * named, and how the answer broke the rule what it carries is held to, or null.
 */
export interface Called {
  readonly route: string;
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
  readonly records: readonly string[];
  readonly notAsHeld: string | null;
}

/** A call and the service's answer to it, logged with the records the answer carried. */
export const calledAs = async (
  route: string,
  method: string,
  path: string,
  body: string | undefined,
  answer: { readonly status: number; readonly body: unknown }
): Promise<Called> => {
  const records = answer.status < 300 ? recordsCarried(method, path, body, answer.body) : [];
  return { route, method, path, body, records, notAsHeld: await carriedNotAsHeld(method, path, body, records) };
};

/** Each call whose answer broke the rule what it carries is held to, named by where it was made, its route and how. */
export const carriedNotAsHeldIn = (where: string, calls: readonly Called[]): string[] =>
  calls.flatMap((c) => (c.notAsHeld === null ? [] : [`${where}: ${c.route} ${c.notAsHeld}`]));

/* The kind of an asked record as a page's counts name it: a company record by its kind, a vault's record by its name, the directory by itself. */
const kindOf = (name: string): string => {
  const [what, a, b] = name.split(' ');
  return what === 'vault' ? `vault ${b}` : what === 'record' ? `record ${a}` : name;
};
/* The records each read of a call log asked, by route, call and kind, as the wallet's counts count them. */
const askedEachCall = (calls: readonly Called[]): Map<string, number> => askedByKind({ log: calls }, kindOf);
/* The records the reads of a call log asked, by route and kind, whichever call asked them. */
const askedByRoute = (calls: readonly Called[]): Map<string, number> => {
  const by = new Map<string, number>();
  for (const [at, n] of askedEachCall(calls)) {
    const key = at.replace(/ call \d+ asks /u, ' asks ');
    by.set(key, (by.get(key) ?? 0) + n);
  }
  return by;
};
/* What a key of `askedEachCall` or `askedByRoute` names as the kind asked. */
const kindIn = (at: string): string => at.slice(at.indexOf(' asks ') + ' asks '.length);

/*
 * The kinds of record a page's reads are meant to ask more of as the company grows, each with what it asks one more record
 * for each one more of (one or more ways, each a sum of what the company holds), and why. Every other kind is asked the same
 * at every size. The wallet's actions hold theirs by the action (`ASKED_GROWS_WITH`); a page is held by the kind it asks.
 */
type Grown = keyof CompanyHeld;
const EACH_VAULT = {
  with: [['vaults']],
  why: "a page reads each vault's name and each vault's own records, their newest versions and their proofs, one of each for each vault"
} as const;
export const PAGE_ASKED_GROWS_WITH: Readonly<
  Record<
    string,
    { readonly with: readonly (readonly Grown[])[]; readonly why: string; readonly pages?: readonly string[] }
  >
> = Object.freeze({
  ...Object.fromEntries(
    ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'].flatMap((k) => [
      [`record ${k}`, EACH_VAULT],
      [`vault ${k}`, EACH_VAULT]
    ])
  ),
  'record vault-info': EACH_VAULT,
  'record person': {
    with: [['people']],
    why: 'a page that shows the people checks each person record the people list carries against its newest entered version'
  },
  'record vendor': {
    with: [['vendors']],
    why: 'a page that shows the vendors reads each vendor record and checks it against its newest entered version'
  },
  'record spending-policy': {
    with: [['policies']],
    why: 'a page that shows the spending policies in force reads each policy record the chain holds a commitment for and checks it against its newest entered version',
    pages: ['policies']
  }
});

/**
 * Each record kind a read of a call log asked differently at the company grown than at its first size (`was`, `now`), by
 * route, call and kind: the same number at both, or, for a kind `PAGE_ASKED_GROWS_WITH` names, one more for each one more the company holds
 * of what it names (`held`, as each opening ended), on the pages it names when it names them (`page`); a kind asked at
 * only one of the sizes is named too.
 */
export const askedBeyondWhatGrew = (
  where: string,
  wasCalls: readonly Called[],
  nowCalls: readonly Called[],
  held: readonly [CompanyHeld, CompanyHeld],
  labels: readonly [string, string],
  page?: string
): string[] => {
  const [was, now] = [askedEachCall(wasCalls), askedEachCall(nowCalls)];
  return [...new Set([...was.keys(), ...now.keys()])].flatMap((k) => {
    const [n, m] = [was.get(k) ?? 0, now.get(k) ?? 0];
    if (n === m) return [];
    const row = PAGE_ASKED_GROWS_WITH[kindIn(k)];
    const granted = row !== undefined && (row.pages === undefined || (page !== undefined && row.pages.includes(page)));
    const ways = (granted ? row.with : []).map((sum) => n + sum.reduce((d, g) => d + held[1][g] - held[0][g], 0));
    if (n > 0 && m > 0 && ways.includes(m)) return [];
    return [`${where}: ${k} ${n} ${labels[0]}, ${m} ${labels[1]}, where ${[n, ...ways].join(' or ')} are held`];
  });
};

/**
 * Each kind of record a press asked at the first size and not at the grown one, or at the grown one and not at the first, named
 * by where it was counted, the route, the kind and both counts. A press files records of its own (a vault, its proposals), so
 * the company it reads is not the first size's company grown evenly, and the number asked of a kind is held to the kinds only.
 */
export const askedKindsChanged = (
  where: string,
  wasCalls: readonly Called[],
  nowCalls: readonly Called[],
  labels: readonly [string, string]
): string[] => {
  const [was, now] = [askedByRoute(wasCalls), askedByRoute(nowCalls)];
  return [...new Set([...was.keys(), ...now.keys()])]
    .filter((k) => ((was.get(k) ?? 0) === 0) !== ((now.get(k) ?? 0) === 0))
    .map((k) => `${where}: ${k} ${was.get(k) ?? 0} ${labels[0]}, ${now.get(k) ?? 0} ${labels[1]}`);
};
