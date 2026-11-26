/**
 * **WHAT EVERY COMPANY VAULT ROUTE READS, AND HOW IT SENDS.** The company and
 * its vault as this service's record and the chain hold them, whether money
 * may go into a vault (`whyNotFunded`), the transaction a request carries, and
 * the one way a route sends it (`send`). Made once per router by
 * `companyVaultRoutes`, and handed to each group of routes.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount, CompanyVault } from '../core/types.js';
import type { VaultTxArrival } from '../core/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { feeAnswerCodeOf } from '../midnight/sponsor.js';
import { readContractAuthority, type AuthorityRead } from '../midnight/ledger.js';
import type { Committee } from '../midnight/vault-committee.js';
import { VAULT } from '../../packages/web-shared/src/vault-standing.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { circuitsRefusal, refusalToPutMoneyIn, type ContractAnswer, type FundingFacts } from '../wiring/vault-submission.js';
import type { CompanyVaultDeps } from './company-vaults.js';

export const HEX64 = /^[0-9a-f]{64}$/u;
export const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');

/** A proven transaction on this wire: base64, and never more than the product's proven limit. */
export const VAULT_TX_LIMIT = 1_000_000;

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * **ONE WORD FOR WHERE A VAULT STANDS, FROM WHAT THE CHAIN SAID AND WHY MONEY
 * MAY NOT GO IN.** `held-by-committee` is the word for a vault money may go
 * into and out of, whoever holds its rules: the gate reads no committee. A
 * refusal is named by what stands in the way: the vault's start, the account,
 * a chain that could not be asked, or the vault itself.
 */
export type AccountNotReady = 'not-handed-over' | 'not-vouched' | 'unknown';

export function vaultState(
  read: ContractAnswer | AuthorityRead,
  refused: { heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true } | null,
): string {
  if (refused === null) return VAULT.held;
  /* The company's in every other way, and not yet adopted with its first secret: creating it again finishes it. */
  if (refused.notStarted === true) return VAULT.startOwed;
  /* An account still exactly as deployed is a step somebody has not taken yet; any other refusal about the
   * account - other keys, more than one change, circuits this build did not compile - is an alarm. */
  if (refused.accountNotReady === 'not-handed-over') return VAULT.accountNotHandedOver;
  if (refused.accountNotReady === 'not-vouched') return VAULT.accountNotFundable;
  if (refused.accountNotReady === 'unknown') return VAULT.unknown;
  /*
   * **WHAT THE CHAIN SAID IS READ HERE AND NOT INFERRED FROM THE REFUSAL.** A
   * vault the chain could not be asked about is not a vault this service has
   * decided something about, whatever else the refusal carries.
   */
  if (read.state !== 'answered' && read.state !== 'read') return read.state === 'absent' ? VAULT.notOnChain : VAULT.unknown;
  if (!refused.heldByOthers) return VAULT.notFundable;
  return VAULT.heldByOtherKeys;
}

/** The signed-in person, as the sign-in in front of these routes set them. */
export const personOf = (req: express.Request): string => (req as { userId?: string }).userId!;

/** What the company vault routes read and how they send, for one router. */
export function companyVaultReads(deps: CompanyVaultDeps) {
  const now = deps.now ?? (() => new Date());
  const guard = [deps.signedIn, express.json({ limit: '4mb' }), deps.member];

  const accountOf = (req: express.Request): SealedAccount => {
    const a = deps.store.getAccount(String(req.params.id));
    if (!a) throw new Error('account not found');
    return a;
  };

  const NO_COMPANY = 'this company has no contract on the chain this service can read, so it has no vaults yet.';
  const ABSENT = 'the chain answered and holds no contract state at this address yet.';

  /*
   * **THE COMMITTEE HOLDING THE COMPANY'S ACCOUNT, AS THE CHAIN HOLDS IT NOW.**
   * The one committee a new vault is born held by and a vault is handed over
   * to: read from the chain each time, never one this service makes, keeps or
   * takes from a change in progress. Null, with why, when the chain does not
   * answer for the account, when the account is still held by this service's
   * own temporary key, or when what holds it is not a committee the one install
   * rule allows. No signer, roster or index is read.
   */
  const accountCommittee = async (account: SealedAccount) => {
    const company = await deps.company(account.id);
    if (company === null) return { company: null, committee: null, why: NO_COMPANY };
    const read = await authorityOf(company.address);
    if (read.state !== 'read') {
      return { company, committee: null, why: `the chain could not be asked who holds this company's account (${read.why}).` };
    }
    const held: Committee = {
      committee: read.authority.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: read.authority.threshold,
    };
    const service = deps.account.temporaryKey;
    if (service !== undefined && held.committee.some((k) => fold(k.tag) === fold(service.tag) && fold(k.value) === fold(service.value))) {
      return { company, committee: null, why: 'this company\'s account is still held by the temporary key this service created it with, so no committee holds it yet.' };
    }
    const notInstallable = whyNotInstallable(held);
    if (notInstallable !== null) {
      return { company, committee: null, why: `what holds this company's account on the chain is not a committee a vault is held by: ${notInstallable}` };
    }
    return { company, committee: held, why: null };
  };

  const theVault = (req: express.Request, res: express.Response): CompanyVault | null => {
    const vault = fold(String(req.params.vault));
    const record = HEX64.test(vault) ? deps.store.getCompanyVault(vault) : null;
    if (!record || record.accountId !== String(req.params.id)) {
      res.status(404).json({ nothingWasSent: true, error: 'this company has no vault at that address.' });
      return null;
    }
    return record;
  };

  const authorityOf = (vault: Hex): Promise<AuthorityRead> =>
    readContractAuthority((a) => deps.chain.contractState(a as Hex), vault);

  /*
   * **WHETHER THIS SERVICE'S RECORD HOLDS A CONTRACT AS BORN HELD**: the account
   * when its founding signer's browser created it here and the address is the
   * one recorded then, a vault when the route that read its deploy as held by
   * the company's committee recorded it. Never read from the chain.
   */
  const accountBornHeld = (accountId: string, address: string): boolean => {
    const d = deps.store.getAccountDeploy(accountId);
    return d !== null && fold(d.address) === fold(address);
  };
  const vaultBornHeld = (vault: string): boolean => deps.store.getCompanyVault(vault)?.bornHeld === true;

  /*
   * **WHAT THE CHAIN SAYS ABOUT THE COMPANY'S ACCOUNT RIGHT NOW.** Whether it
   * answered for the account's state, and its circuits, each read afresh and
   * never from a record kept here; who holds its rules is never read. Read once
   * per request and handed to every vault the request answers for, because the
   * account is the same account for all of them.
   */
  const accountFactsOf = async (
    accountId: string, companyAddress: Hex,
  ): Promise<{ read: ContractAnswer; circuits: string | null; bornHeld: boolean }> => {
    let state: unknown;
    try {
      state = await deps.chain.contractState(companyAddress);
    } catch (e) {
      return {
        read: { state: 'unreachable', why: `the chain could not be asked: ${(e as Error)?.message ?? e}` },
        circuits: null,
        bornHeld: accountBornHeld(accountId, companyAddress),
      };
    }
    if (state === null || state === undefined) {
      return { read: { state: 'absent', why: ABSENT }, circuits: null, bornHeld: accountBornHeld(accountId, companyAddress) };
    }
    const keys = await deps.account.verifierKeys();
    return {
      read: { state: 'answered' },
      circuits: circuitsRefusal(
        state, keys,
        'no money goes in, because this company\'s account is not the one this service\'s build compiled',
        deps.account.circuits, 'the account\'s'),
      bornHeld: accountBornHeld(accountId, companyAddress),
    };
  };

  /*
   * **WHETHER MONEY MAY GO INTO THIS VAULT.** Every fact is read from the chain
   * here, but for this service's record of each contract's creation, and the
   * answer itself is `refusalToPutMoneyIn`, which reads no committee. Only the
   * contracts' states are asked for, never who holds their rules. This route
   * reads; it does not decide.
   */
  const whyNotFunded = async (
    vault: Hex, companyAddress: string, state?: unknown,
    accountFacts?: { read: ContractAnswer; circuits: string | null; bornHeld: boolean },
    what = 'no money goes into this vault',
    /* The narrower question a vault's start waits on: the vault alone, never a door carrying money. */
    asFar: typeof refusalToPutMoneyIn = refusalToPutMoneyIn,
  ): Promise<{ why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true; vaultRead: ContractAnswer } | null> => {
    let now = state;
    let vaultRead: ContractAnswer = { state: 'answered' };
    if (now === undefined) {
      try {
        now = await deps.chain.contractState(vault);
      } catch (e) {
        /*
         * **A READ THAT WENT UNANSWERED IS A FACT THE GATE IS GIVEN, NOT A
         * REFUSAL WRITTEN HERE.** The vault is put to the gate as a chain that
         * could not be asked, and the caller is handed that read back: a screen
         * then shows a question that could not be answered, not an alarm about
         * the vault.
         */
        vaultRead = { state: 'unreachable', why: `the chain could not be asked: ${(e as Error)?.message ?? e}` };
        now = null;
      }
    }
    if (vaultRead.state === 'answered' && (now === null || now === undefined)) vaultRead = { state: 'absent', why: ABSENT };
    let pinned: string | null;
    let started = false;
    try {
      const start = deps.chain.startingLedgerOf(now);
      pinned = start.account;
      started = start.started;
    } catch {
      pinned = null;
    }
    const acc = accountFacts ?? await accountFactsOf(deps.store.getCompanyVault(vault)?.accountId ?? '', companyAddress as Hex);
    const vaultKeys = await deps.verifierKeys();
    const facts: FundingFacts = {
      label: vault,
      what,
      vault: vaultRead,
      vaultCircuits: circuitsRefusal(now, vaultKeys, 'this vault is not funded'),
      pinnedAccount: pinned,
      started,
      companyAccount: companyAddress,
      account: acc.read,
      accountCircuits: acc.circuits,
      bornHeld: { vault: vaultBornHeld(vault), account: acc.bornHeld },
    };
    const refused = asFar(facts);
    return refused === null ? null : { ...refused, vaultRead };
  };

  /*
   * **THE GATE A ROUTE ASKS BEFORE MONEY GOES INTO OR OUT OF A VAULT**: the vault's company as the chain holds it, and
   * `whyNotFunded` read now, in the door's own words (`what`). Answers the account and the company, or sends the 409
   * refusal and answers null.
   */
  const fundable = async (req: express.Request, res: express.Response, record: CompanyVault, what?: string) => {
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return null;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD. */
    const refused = await whyNotFunded(record.vault, company.address, undefined, undefined, what);
    if (refused !== null) {
      res.status(409).json({ nothingWasSent: true, error: refused.why });
      return null;
    }
    return { account, company };
  };

  const txFrom = (req: express.Request, res: express.Response): Uint8Array | null => {
    const body = z.object({ tx: z.string().min(1).max(VAULT_TX_LIMIT) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this request carries no transaction to send. Nothing was sent.' });
      return null;
    }
    return new Uint8Array(Buffer.from(body.data.tx, 'base64'));
  };

  const send = async (
    res: express.Response, accountId: string, what: string, arrival: VaultTxArrival, bytes: Uint8Array,
    check: (tx: unknown) => string | null | Promise<string | null>,
  ) => {
    if (typeof deps.ledger.sendVault !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send transactions, so nothing was sent.' });
      return null;
    }
    try {
      return await deps.ledger.sendVault(accountId, what, arrival, bytes, check,
        arrival === 'finished-by-the-depositor' ? deps.readers.finished : deps.readers.proven);
    } catch (e: unknown) {
      const nothing = saysNothingWasSent(e);
      /* A code rides only on a nothing-sent answer: a 502 may have landed, and no page may say otherwise. */
      const code = nothing ? feeAnswerCodeOf(e) : null;
      res.status(nothing ? 422 : 502).json({
        nothingWasSent: nothing, error: (e as { message?: string })?.message ?? 'unknown error', ...(code ? { code } : {}),
      });
      return null;
    }
  };

  /* How long a transaction sent from here could still land: its time to live. */
  const HANDOVER_LIFETIME_MS = 30 * 60_000;

  return {
    deps, now, guard, accountOf, NO_COMPANY, accountCommittee, theVault, authorityOf, accountFactsOf, whyNotFunded, fundable,
    txFrom, send, HANDOVER_LIFETIME_MS,
  };
}

export type CompanyVaultReads = ReturnType<typeof companyVaultReads>;
