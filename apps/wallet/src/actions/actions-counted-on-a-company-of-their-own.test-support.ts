/*
 * The wallet actions that each need a company of their own to be counted on: a recovery of the company's records, which
 * is raised only where this device's read of the records stops before the head the chain holds; a new vault's creation,
 * after the founding seat has given its vault keys;
 * a vault's retirement, raised on a vault started as the product starts it; and a one-off payment, left open for the
 * approvals it waits for. Each is counted at the company's first
 * size and at twice it, as `countedAtBothSizes` counts every action.
 */
import { beforeAll } from 'vitest';
import { acmeChain, ORIGIN } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { readerCodeFrom } from './own-wallet-double.test-support.js';
import { ADA, BO, store, vaultStateOnTheChain } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { aCompanyOf, runIntent, runUpkeep, type Company, type IntentCount } from './company-harness.test-support.js';
import { ON_THEIR_OWN_ACTION_PINS, ON_THEIR_OWN_CARRIED_PINS } from './action-count-pins.test-support.js';
import { countedAtBothSizes } from './action-counts.test-support.js';
import { runsOfThisCountFile } from './actions-each-count-file-runs.test-support.js';

/** The actions counted here, each on a company of its own. */
export const COUNTED_ALONE: readonly string[] = ['recovery', 'create-vault', 'retire-vault', 'one-off-payment', 'grant-read'];

/* The parts of a recovery's file the raise told, as an approval or a carrying out of it is asked with them. */
const FILE_FIELDS = ['proposal', 'salt', 'latest', 'lastRecovery', 'resumesFrom', 'root', 'seq'] as const;

let landedAlone = 0;
/*
 * Stops the company's records for its devices: the founding and second seats' devices first read the records up to the
 * head the chain holds, through the upkeep each one's wallet does; then an anchor lands on the chain that no device filed
 * with the service, so no device can check the batch it names.
 */
const recordsStoppedIn = async (company: Company): Promise<void> => {
  await runUpkeep(company, ADA.person);
  await runUpkeep(company, BO.person);
  landedAlone += 1;
  acmeChain.landAt((0xe0 + landedAlone).toString(16).repeat(32));
};

/*
 * A recovery raised from the founding seat's own wallet on a company whose records are stopped, counted; then approved
 * and carried out from the second seat's own wallet. The second seat's upkeep then files the header it kept of the
 * recovery with the service again, and the founding seat's reads past it, so the company can grow after it; at twice the
 * size that is the company's second recovery, which the second seat follows from the first one it checked.
 */
const recovered = async (company: Company): Promise<IntentCount> => {
  await recordsStoppedIn(company);
  const latest = String(Math.floor(Date.now() / 1000) + 86_400);
  const raised = await runIntent('recovery', { name: 'recovery', fields: { ...company.fields, step: 'raise', latest } } as never, company, ADA.person);
  const file = Object.fromEntries(FILE_FIELDS.map((k) => [k, String(raised.told[k])]));
  const approved = await runIntent('approve-proposal', { name: 'approve-proposal', fields: { ...company.fields, kind: 'recovery', ...file } } as never, company, BO.person);
  if (approved.told['state'] !== 'carried-out') throw new Error(`the recovery approved was ${String(approved.told['state'])}, not carried out`);
  await runUpkeep(company, BO.person);
  await runUpkeep(company, ADA.person);
  return raised;
};

/* The founding seat's wallet holds the company as the one it created, as the wallet that created the company does. */
const heldAsCreated = (company: Company): void => {
  company.wallet(ADA.person).pins.set(company.fields.company, { account: company.fields.account, created: true, from: 'created' });
};

/*
 * The founding seat gives its vault keys from its own wallet, so the roster holds its keys and directory entry before a
 * vault is created: each creation counted after it is the one every later creation is, which offers nothing.
 */
const keysGivenByTheFoundingSeat = async (company: Company): Promise<void> => {
  heldAsCreated(company);
  await runIntent('give-vault-keys', { name: 'give-vault-keys', fields: company.fields } as never, company, ADA.person);
};

/*
 * A new vault created from the founding seat's own wallet: built, deployed through the service and read back as deployed,
 * then its adoption raised. The account asks more approvals than the raise counts, so the action ends waiting for them.
 */
const vaultCreated = async (company: Company): Promise<IntentCount> => {
  heldAsCreated(company);
  const made = await runIntent('create-vault', { name: 'create-vault', fields: company.fields } as never, company, ADA.person);
  if (made.told['round'] !== 'adoption') throw new Error(`the new vault ${String(made.told['vault'])} was left at ${JSON.stringify(made.told)}, not waiting for its adoption's approvals`);
  return made;
};

/*
 * The indexer as a wallet reads a contract's state at it over HTTP: each vault the test's chain holds, as it holds it.
 * Every other fetch goes where it went before.
 */
const fetchBefore = globalThis.fetch.bind(globalThis);
const STATE_ASKED = /^query \(\$address: HexEncoded!\) \{ contract\(address: \$address\) \{ state \} \}$/u;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const asked = typeof init?.body === 'string' ? (() => { try { return JSON.parse(init.body as string) as { query?: unknown; variables?: { address: string } }; } catch { return null; } })() : null;
  if (asked === null || typeof asked.query !== 'string' || !STATE_ASKED.test(asked.query)) return fetchBefore(url, init);
  const variables = asked.variables!;
  const state = await vaultStateOnTheChain(variables.address);
  return new Response(JSON.stringify({ data: { contract: state === null ? null : { state } } }), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/* The company's proposals the service holds that were not among `before`, as the second seat's approval names them. */
const proposalsFiledSince = (company: Company, before: ReadonlySet<string>): string => {
  const now = store.listProposals(company.fields.record).map((p) => String(p.id)).filter((id) => !before.has(id));
  if (now.length !== 1) throw new Error(`the start filed ${now.length} proposals, not one`);
  return now[0]!;
};
const proposalsNow = (company: Company): ReadonlySet<string> => new Set(store.listProposals(company.fields.record).map((p) => String(p.id)));

/*
 * A vault started as the product starts it: created from the founding seat's wallet, its adoption approved and carried
 * out from the second seat's; then its first secret's run raised from the founding seat's wallet, and approved, set and
 * every sealed copy of it written from the second seat's. Hands back the vault.
 */
const vaultStarted = async (company: Company): Promise<string> => {
  let before = proposalsNow(company);
  const made = await vaultCreated(company);
  const vault = String(made.told['vault']);
  const approve = async (kind: string, proposal: string) => {
    const done = await runIntent('approve-proposal', { name: 'approve-proposal', fields: { ...company.fields, kind, vault, proposal } } as never, company, BO.person);
    if (done.told['state'] !== 'carried-out') throw new Error(`the ${kind} approved was ${JSON.stringify(done.told)}, not carried out`);
  };
  await approve('adopt-vault', proposalsFiledSince(company, before));
  before = proposalsNow(company);
  const raised = await runIntent('create-vault', { name: 'create-vault', fields: { ...company.fields, vault } } as never, company, ADA.person);
  if (raised.told['round'] !== 'first-secret') throw new Error(`the vault ${vault} was left at ${JSON.stringify(raised.told)}, not waiting for its first secret's approvals`);
  await approve('vault-secret', proposalsFiledSince(company, before));
  return vault;
};

/* A started vault's retirement raised from the founding seat's own wallet; the account asks more approvals than the raise counts. */
const retireRaised = async (company: Company): Promise<IntentCount> => {
  const vault = await vaultStarted(company);
  return runIntent('retire-vault', { name: 'retire-vault', fields: { ...company.fields, vault } } as never, company, ADA.person);
};

/*
 * A reader of its own at each size given the accountant's read from the founding seat's wallet, by the code the reader's
 * own wallet signs; the company asks two approvals, so the change to its readers waits for a second seat's signature.
 */
const readGranted = async (company: Company, at: 0 | 1): Promise<IntentCount> => {
  const person = `usr_reader${at + 1}`;
  const code = readerCodeFrom(150 + at, { company: company.fields.company, account: company.fields.account, person, origin: ORIGIN });
  const given = await runIntent('grant-read', { name: 'grant-read', fields: { ...company.fields, code, role: 'accountant' } } as never, company, ADA.person);
  if (given.told['state'] !== 'waiting-for-signers') throw new Error(`the read given was left at ${JSON.stringify(given.told)}, not waiting for a second seat`);
  return given;
};

/**
 * Counts the one action of the ones counted here that the count file at `url` lists, on a company of its own, at its
 * first size and at twice it. Call it where the file's tests are declared, once.
 */
export function countedOnACompanyOfItsOwn(url: string): void {
  const listed = runsOfThisCountFile(url);
  if (listed.length !== 1) throw new Error(`a count file of an action counted on a company of its own lists one action, not ${listed.join(', ')}`);
  const name = listed[0]!;
  const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
  const every: Readonly<Record<string, (at: 0 | 1) => Promise<IntentCount>>> = {
    recovery: () => recovered(company), 'create-vault': () => vaultCreated(company),
    'retire-vault': () => retireRaised(company), 'one-off-payment': () => company.oneOffRaised(),
    'grant-read': (at) => readGranted(company, at),
  };
  if (!Object.hasOwn(every, name)) throw new Error(`no action counted on a company of its own is named ${name}`);
  if (name === 'create-vault') beforeAll(() => keysGivenByTheFoundingSeat(company), 160_000);
  countedAtBothSizes(company, { [name]: every[name]! }, { people: 6, vendors: 4, vaults: 4, proposals: 2 }, { reads: ON_THEIR_OWN_ACTION_PINS, carried: ON_THEIR_OWN_CARRIED_PINS }, [
    { name: 'ON_THEIR_OWN_ACTION_PINS', about: 'The actions counted each on a company of its own, on the company at its first size.', of: 'reads', only: COUNTED_ALONE },
    { name: 'ON_THEIR_OWN_CARRIED_PINS', about: 'The records the service\'s answers to each step of an action counted on a company of its own carried, on the company at its first size.', of: 'carried', only: COUNTED_ALONE },
  ]);
}
