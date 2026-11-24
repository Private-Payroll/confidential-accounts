/*
 * The rule each read that names its records is held to as the company grows, over what it asked by kind (counted by
 * `askedByKind` beside the carried rule): what the company holds when a run ends, and the reads meant to ask more
 * records as it grows, each with what it asks one more record for each one more of.
 */
import { CO, openOnTheChain, policiesSetOnTheChain, store, vaultsAdoptedOnTheChain } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { peopleRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { openRecord } from '../../../../src/core/sealed-records.js';
import { keyOf } from '../../../../src/core/company-key.js';
import type { SealedProposal } from '../../../../src/core/types.js';
import type { Company, IntentCount } from './company-harness.test-support.js';
import { askedByKind } from './records-carried.test-support.js';

/** The reads that name the records they ask: of vault records, of company records, of the newest versions and of proofs. */
export const NAMES_ITS_RECORDS = /\/(vault-records\/read|records\/read|manifest\/newest|manifest\/tree\/proofs)$/u;
export const bodyOf = (body: string | undefined): Record<string, unknown> => (body === undefined ? {} : JSON.parse(body) as Record<string, unknown>);
export const askedIn = (body: string | undefined): readonly Record<string, unknown>[] => {
  const asked = bodyOf(body)['records'];
  return Array.isArray(asked) ? asked as Record<string, unknown>[] : [];
};

/* The kinds of change a change to the company's governance raises, each of which a raise opens the open proposals of. */
const GOVERNED_KINDS = ['add-signer', 'remove-signer', 'set-threshold', 'set-vault-threshold', 'set-spending-policy', 'set-policy-bar'] as const;
type OpenOfAKind = `open ${(typeof GOVERNED_KINDS)[number]}`;

/** How many of each kind of record a read may ask every one of the company holds when a run ends. */
export type CompanyHeld = Readonly<Record<'vaults' | 'people' | 'people changed' | 'proposals' | 'runs' | 'policies' | OpenOfAKind, number>>;

/* The kind of change an open proposal raises, opened with the company's key; one this key does not open is of no kind named. */
const kindOfProposal = (company: Company, p: SealedProposal): string => {
  try {
    return openRecord<{ readonly kind: string }>('proposals', CO, p.sealed, keyOf(company.companyKey, p.keyEpoch)).kind;
  } catch (e) {
    return `not opened: ${String(e)}`;
  }
};

/** The spending policies the company holds: each named by an entry in its records. */
export const policiesHeld = (): number =>
  new Set(store.manifestOf(CO).entries.filter((e) => e.store === 'company' && e.kind === 'spending-policy').map((e) => e.id)).size;

/**
 * What the company holds when a run ends, what the run set up first and filed included: the vaults it was grown to and
 * those its account adopted on the chain (a vault deployed whose adoption still waits holds no records of its own yet,
 * and the upkeep files only an adopted vault's), the person records (people and vendors) the service holds and those of
 * them changed since their first version, its proposals, those of them the chain holds open by each kind of governance
 * change (the ones a change raised can find open), its runs, and the vaults it holds a spending policy set on, on the
 * chain (a policy raised and not yet carried out is not read by the re-seal that grows with policies).
 */
export const heldBy = async (company: Company): Promise<CompanyHeld> => {
  const people = await peopleRecords.peopleOf(CO);
  const proposals = store.listProposals(CO);
  const onTheChain = new Set(openOnTheChain().map((o) => o.id));
  const open = proposals.filter((p) => onTheChain.has(String(p.chainId).toLowerCase())).map((p) => kindOfProposal(company, p));
  return {
    vaults: new Set([...company.vaults(), ...vaultsAdoptedOnTheChain()].map((v) => v.toLowerCase())).size,
    people: people.length, 'people changed': people.filter((p) => p.version > 1).length,
    proposals: proposals.length, runs: store.listRuns(CO).length,
    policies: policiesSetOnTheChain(),
    ...Object.fromEntries(GOVERNED_KINDS.map((k) => [`open ${k}`, open.filter((x) => x === k).length])) as Record<OpenOfAKind, number>,
  };
};

const VAULT_RECORD_KINDS = ['pool', 'deposit-journal', 'payment-journal', 'nonce-secret'] as const;
const readRoute = (path: string): string => `POST /api/accounts/:record/${path}`;
const EACH_VAULT = 'the upkeep files each vault\'s own records again, so it reads each one, its newest version and its proof: one of each kind for each vault';

type Dim = keyof CompanyHeld;
/*
 * A read meant to ask more records as the company grows, by route and kind: for each action whose counts need it, what
 * it asks one more record for each one more of, and why. Every other read, and the same read of every other action,
 * asks the same records of each kind at every size.
 */
interface Grows { readonly for: Readonly<Record<string, readonly Dim[]>>; readonly why: string }
const each = (actions: readonly string[], dims: readonly Dim[]): Readonly<Record<string, readonly Dim[]>> => Object.fromEntries(actions.map((a) => [a, dims]));
/* The actions whose upkeep reads each vault's records, its newest versions and their proofs. */
const VAULT_READERS: readonly string[] = [
  'admit-person', 'admit-signer', 'approve-proposal', 'change-person', 'change-role', 'change-threshold', 'choose-company-service', 'create-vault',
  'give-vault-keys', 'grant-read', 'invite', 'one-off-payment', 'raise-run', 'raise-waiting-signer', 'reissue-invitation', 'remove-signer',
  'repair-company-key', 'retire-vault', 'rotate-vault-secrets', 'set-policy-bar', 'set-recovery-window', 'set-spending-policy',
  'upkeep-after-an-admission', 'withdraw-waiting-signer',
];
/* The changes raised through the company's records, each with the kind of open proposal it opens to find one it already is. */
const OWN_KIND: Readonly<Record<string, readonly Dim[]>> = {
  'change-threshold': ['open set-threshold'], 'change-role': ['open remove-signer'], 'remove-signer': ['open remove-signer'],
  'set-spending-policy': ['open set-spending-policy'], 'raise-waiting-signer': ['open add-signer'],
};
/* The actions whose upkeep seals the spending policies again: the versions of each and their newest, and for the upkeep after an admission their proofs. */
const POLICY_READERS: readonly string[] = [
  'admit-person', 'admit-signer', 'change-person', 'change-role', 'change-threshold', 'give-vault-keys', 'invite', 'raise-run', 'raise-waiting-signer',
  'remove-signer', 'set-spending-policy', 'upkeep-after-an-admission', 'withdraw-waiting-signer',
];
const FOR_EACH_VAULT: Grows = { for: each(VAULT_READERS, ['vaults']), why: EACH_VAULT };
export const ASKED_GROWS_WITH: Readonly<Record<string, Grows>> = Object.freeze({
  ...Object.fromEntries(VAULT_RECORD_KINDS.flatMap((k): (readonly [string, Grows])[] => [
    [`${readRoute('vault-records/read')} asks vault record ${k}`, FOR_EACH_VAULT],
    [`${readRoute('manifest/newest')} asks record ${k}`, FOR_EACH_VAULT],
    [`${readRoute('manifest/tree/proofs')} asks record ${k}`, FOR_EACH_VAULT],
  ])),
  [`${readRoute('manifest/newest')} asks record proposal`]: {
    for: OWN_KIND,
    why: 'a change raised opens every open proposal of its own kind, to find one it already is, and the one call that proves what its step read asks each of them again',
  },
  ...Object.fromEntries(['records/read', 'manifest/newest', 'manifest/tree/proofs'].map((r): readonly [string, Grows] => [`${readRoute(r)} asks record spending-policy`, {
    for: each(r === 'manifest/tree/proofs' ? ['upkeep-after-an-admission'] : POLICY_READERS, ['policies']), why: 'the upkeep seals every spending policy again to the signers who stay, so it reads every version of each, its newest and its proof, in one call for all of them',
  }])),
  [`${readRoute('manifest/newest')} asks record run`]: { for: each(['change-person'], ['runs']), why: 'each run the list carries is checked against its newest entered version' },
  [`${readRoute('manifest/newest')} asks record person`]: { for: each(['admit-person', 'change-person', 'raise-run', 'repair-company-key'], ['people']), why: 'each person record the people list carries is checked against its newest entered version' },
  [`${readRoute('records/read')} asks record person`]: {
    for: each(['admit-person', 'change-person', 'raise-run'], ['people changed']), why: 'a person admitted or changed reads, in one call, every version of each person record changed since its first',
  },
});

/** A read of an action, by its step and route as `askedByKind` names them. */
export interface ReadOfAnAction { readonly action: string; readonly step: number; readonly route: string }
/*
 * The one read of each action named here that may ask one more proposal for each one more the company holds, of any
 * kind: the step view's check that what the step read is still held, which asks again, in one call, every record the
 * step read, the proposals list's every proposal among them.
 */
export const ASKED_WITH_EVERY_PROPOSAL: { readonly why: string; readonly reads: readonly ReadOfAnAction[] } = Object.freeze({
  why: 'the step view checks, in one call, that every record its step read is still held, and its step read the list of every proposal',
  reads: Object.entries({
    'give-vault-keys': [2], 'upkeep-after-an-admission': [2], 'rotate-vault-secrets': [3], 'repair-company-key': [3, 4], 'approve-proposal': [3, 4],
    'raise-run': [3, 4], 'one-off-payment': [3, 6], 'admit-person': [4], 'admit-signer': [4], 'change-person': [4], 'choose-company-service': [4],
    'grant-read': [4], 'invite': [4], 'raise-waiting-signer': [4], 'retire-vault': [4], 'set-recovery-window': [4], 'withdraw-waiting-signer': [4],
    'change-threshold': [5], 'create-vault': [5], 'remove-signer': [5], 'set-policy-bar': [5], 'set-spending-policy': [5], 'change-role': [6],
  }).flatMap(([action, steps]) => steps.map((step) => ({ action, step, route: readRoute('manifest/newest') }))),
});

/* The row of `ASKED_GROWS_WITH` a read named as `askedByKind` names it falls under, and its step and route. */
const readOf = (at: string): { readonly row: string; readonly step: number; readonly route: string; readonly kind: string } => {
  const [, step, route, kind] = /^step (\d+): (.*) call \d+ asks (.*)$/u.exec(at)!;
  return { row: `${route!} asks ${kind!}`, step: Number(step), route: route!, kind: kind! };
};
/*
 * What a read of `action` may grow with, each named by the grant that allows it: every proposal, for the read
 * `ASKED_WITH_EVERY_PROPOSAL` names at its step and route; what its row grants the action, for every other read.
 */
const grantsOf = (action: string, at: string): { readonly grant: string; readonly dim: Dim }[] => {
  const { row, step, route, kind } = readOf(at);
  const everyProposal = kind === 'record proposal' && ASKED_WITH_EVERY_PROPOSAL.reads.some((r) => r.action === action && r.step === step && r.route === route);
  if (everyProposal) return [{ grant: `${route} at step ${step} asks every proposal, for ${action}`, dim: 'proposals' }];
  return (ASKED_GROWS_WITH[row]?.for[action] ?? []).map((dim) => ({ grant: `${row}, for ${action}`, dim }));
};

/* The grants the counts of this file could use, as what they name grew between an action's two runs, and those they used. */
const grants = { testable: new Set<string>(), used: new Set<string>() };
/** Each grant a count of this file ran an action whose company grew by what it names, and no read of it used. */
export const grantsLeftUnused = (): string[] => [...grants.testable].filter((g) => !grants.used.has(g)).sort();
/* Notes each grant of `action` that its two runs can test: the company grew by what it names between them. */
const noteTestable = (action: string, held: readonly [CompanyHeld, CompanyHeld]): void => {
  const grew = (d: Dim): boolean => held[1][d] !== held[0][d];
  for (const [row, g] of Object.entries(ASKED_GROWS_WITH)) if ((g.for[action] ?? []).some(grew)) grants.testable.add(`${row}, for ${action}`);
  for (const r of ASKED_WITH_EVERY_PROPOSAL.reads) if (r.action === action && grew('proposals')) grants.testable.add(`${r.route} at step ${r.step} asks every proposal, for ${action}`);
};

/**
 * Each read of `action` whose records asked of a kind differ between two runs of it, by step, route, call and kind: the
 * same at both, or, for a read granted to `action` by `ASKED_GROWS_WITH` or `ASKED_WITH_EVERY_PROPOSAL`, more by one for
 * each one more the company holds of a kind the grant names (`held`, as each run ended: a run that sets up more the
 * first time than the next is held to what its counted step read). Each grant used is noted, as is each its runs could test.
 */
export const askedDiffering = (
  action: string, before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, held: readonly [CompanyHeld, CompanyHeld],
  labels: readonly [string, string] = ['at the first size', 'at twice it'],
): string[] => {
  noteTestable(action, held);
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((at) => {
    const [n, twice] = [before.get(at) ?? 0, after.get(at) ?? 0];
    if (twice === n) return [];
    const options = grantsOf(action, at).map((o) => ({ ...o, held: n + held[1][o.dim] - held[0][o.dim] }));
    const hit = options.find((o) => o.held === twice);
    if (hit !== undefined) { grants.used.add(hit.grant); return []; }
    return [`${action} ${at}: ${n} ${labels[0]}, ${twice} ${labels[1]}, where ${[n, ...options.map((o) => o.held)].join(' or ')} are held`];
  });
};

/** `askedDiffering` over what two runs of `action` asked, from their logs. */
export const askedOtherThan = (
  action: string, was: Pick<IntentCount, 'log'>, now: Pick<IntentCount, 'log'>, held: readonly [CompanyHeld, CompanyHeld],
  labels: readonly [string, string] = ['at the first size', 'at twice it'],
): string[] => askedDiffering(action, askedByKind(was), askedByKind(now), held, labels);

/** What one run asked by kind, with what the company held when it ended, as one pinned row: each held count named `held <kind>`. */
export const askedAsPinned = (c: Pick<IntentCount, 'log'>, held: CompanyHeld): Readonly<Record<string, number>> => ({
  ...Object.fromEntries(askedByKind(c)), ...Object.fromEntries(Object.entries(held).map(([k, n]) => [`held ${k}`, n])),
});
/** What a pinned row of `askedAsPinned` says the run asked by kind, and what the company held when it ended. */
export const pinnedAsked = (row: Readonly<Record<string, number>>): { readonly asked: ReadonlyMap<string, number>; readonly held: CompanyHeld } => ({
  asked: new Map(Object.entries(row).filter(([k]) => !k.startsWith('held '))),
  held: Object.fromEntries(Object.entries(row).filter(([k]) => k.startsWith('held ')).map(([k, n]) => [k.slice('held '.length), n])) as CompanyHeld,
});
