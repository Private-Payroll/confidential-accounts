/**
 * **A COMPANY'S VAULTS, AS ITS SIGNERS' DEVICES CREATE, HAND OVER AND FUND
 * THEM.**
 *
 * Nothing a device sends here carries a secret: the device builds and proves a
 * vault's transactions; the depositor's own wallet puts in and signs for any
 * coin; this service reads what arrives, refuses anything that is not exactly
 * what the route is for, and pays only the network fee. It builds and signs no
 * transaction itself. What it answers about a vault's rules is read from the
 * chain each time it is asked.
 *
 *   GET  /api/accounts/:id/vault-keys                   the committee holding the account on the chain, and who can read the records
 *   GET  /api/accounts/:id/vaults                       the company's vaults, and who holds each on chain
 *   POST /api/accounts/:id/vaults                       a vault deployed with a temporary key
 *   POST /api/accounts/:id/vaults/:vault/handover       that vault handed to the company's committee
 *   POST /api/accounts/:id/vaults/:vault/start/account  a step of its start on the account: the adoption round or the
 *                                                       first secret run approved, or the adoption carried out (each is
 *                                                       raised with its record, through the proposals route)
 *   POST /api/accounts/:id/vaults/:vault/start/secret   its first secret set under the approved run
 *   POST /api/accounts/:id/vaults/:vault/start/copy     one signer's sealed copy of that secret written
 *   GET  /api/accounts/:id/vaults/:vault/chain          what the chain holds for one vault
 *   POST /api/accounts/:id/vaults/:vault/deposit        a deposit the depositor's wallet has paid for
 *   POST /api/accounts/:id/vaults/:vault/public-deposit a public deposit the depositor's wallet has paid for
 *   GET  /api/accounts/:id/vaults/:vault/payout-state   the chain as one block saw it, for a payout to be built on
 *   GET  /api/accounts/:id/vaults/:vault/events/:tx     what one transaction created, for a note's place to be read
 *   GET  /api/accounts/:id/vaults/:vault/created/:out   which of the vault's transactions created one output
 *   POST /api/accounts/:id/vaults/:vault/payout         a private payment out of the vault
 *   GET  /api/accounts/:id/authority                    who holds the account's and every vault's rules
 *   GET  /api/accounts/:id/call-state                   the account as one block saw it, for a raise or an approval to be built on
 *   GET  /api/accounts/:id/committee-change             the contracts not holding the committee the account holds on the chain
 *   POST /api/accounts/:id/committee-change/signatures  signatures on contracts' committee updates, kept
 *   GET  /api/accounts/:id/committee-change/signatures  every signature kept, handed back
 *   POST /api/accounts/:id/committee-change/send        one contract's update sent, on a device's request
 *
 * **WHO HOLDS A CONTRACT'S RULES STOPS NO MONEY.** Whether money goes into a
 * vault, and whether the fee on a payment out is paid, is
 * `refusalToPutMoneyIn`, which reads no committee: a vault is the company's by
 * the account it is pinned to and by this service's record of its creation.
 * What these routes cannot stop: anybody paying their own fee can call a
 * vault's deposit directly.
 *
 * **FOR A CHANGE OF WHO HOLDS THE CONTRACTS THIS SERVICE IS A STORE AND A
 * RELAY.** It keeps and hands back each contract's signatures, checking only
 * their shape, that each verifies under the committee holding that contract
 * on the chain, and the counter the chain holds; it sends an update only when
 * a device asks, and pays the fee only once the signatures that verify reach
 * that committee's threshold on the chain. It holds no copy of who the super
 * admins are and has no committee of its own: the only committee it reads is
 * the one holding the company's account on the chain.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount, CompanyVault, AccountDeploy } from '../core/types.js';
import type { CompanyVaultKeyIndex } from '../core/vault-keys.js';
import type { Ledger, VaultTxArrival } from '../core/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { readContractAuthority, type AuthorityRead } from '../midnight/ledger.js';
import { sameCommittee, type Committee } from '../midnight/vault-committee.js';
import { publicHoldingsOf, PublicBalanceUnreadable } from '../midnight/public-balance.js';
import { authorityView, type ContractAuthorityView, type PlaceSignature } from '../midnight/company-authority.js';
import { contractsOwingAChange, type ContractOwingAChange } from '../midnight/committee-change.js';
import type { CollectedCommitteeSignatures } from '../core/store.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { joinedBy, superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import {
  circuitsRefusal, readVaultDeploy, refusalForCommitteeChange, refusalForDeposit, refusalForHandover, refusalForMerge, refusalForPayout,
  refusalForPublicDeposit, refusalForPublicPayout, refusalForSecretCopy, refusalForSetNonceSecret, refusalForStartAccountCall,
  refusalToPutMoneyIn, vaultIsTheCompanys, type ContractAnswer, type FundingFacts, type VaultStartingLedger,
} from '../wiring/vault-submission.js';

const HEX64 = /^[0-9a-f]{64}$/u;
const fold = (h: string): string => h.trim().toLowerCase().replace(/^0x/u, '');

/** A proven transaction on this wire: base64, and never more than the product's proven limit. */
export const VAULT_TX_LIMIT = 1_000_000;

/** What these routes read about one vault from the chain. */
export interface VaultChain {
  /** The vault's contract state as the indexer serves it, or null when there is none. */
  contractState(vault: Hex): Promise<unknown | null>;
  /** The state's bytes, as a device reads them back. */
  serialize(state: unknown): Uint8Array;
  /** The vault's note commitments now, lower-case hex. */
  notesOf(state: unknown): readonly Hex[];
  /**
   * **EVERY VAULT THE COMPANY'S ACCOUNT LISTS ON THE CHAIN, ADOPTED OR
   * RETIRED**: the account's own record of which vaults are the company's.
   * Throws when the chain could not be asked. Absent where this deployment
   * reads no chain, and then no vault is taken as the company's.
   */
  accountVaults?(account: Hex): Promise<readonly string[]>;
  /**
   * **RETURNS ONLY WHEN THE STATE IS A LEDGER OF THE SHAPE THIS BUILD'S VAULT
   * HAS**, and refuses, saying how it differs, when it is not. A field is read
   * off a ledger by its position, so a vault of another shape answers the
   * question about its notes out of whichever field is in that place. Absent
   * where this deployment cannot tell, and then the notes are not vouched for.
   */
  ledgerIsThisBuilds?(state: unknown): Promise<void>;
  /** What the vault's ledger holds, read through the vault's own compiled ledger. */
  startingLedgerOf(state: unknown): VaultStartingLedger;
  /** Every output the chain has ever created for the vault. */
  everCreated(vault: Hex): Promise<ReadonlySet<string>>;
  /**
   * **ONE BLOCK'S VIEW OF EVERYTHING A PRIVATE PAYMENT IS BUILT ON**: the vault's
   * state, the chain's commitment tree and parameters as that block holds them,
   * and the account's state at the same block, which the vault's call reads.
   * Each value is its bytes. Absent where this deployment reads no chain.
   */
  payoutState?(vault: Hex, account: Hex): Promise<PayoutState | null>;
  /**
   * **ONE BLOCK'S VIEW OF THE COMPANY ACCOUNT, FOR A PROPOSAL TO BE RAISED OR
   * APPROVED ON**: the account's state and the ledger parameters as that block
   * holds them. Each value is its bytes. Absent where this deployment reads no
   * chain.
   */
  accountCallState?(account: Hex): Promise<AccountCallState | null>;
  /**
   * **WHAT ONE TRANSACTION CREATED**, as the chain's own events say: the only
   * place a note's position in the commitment tree is read from.
   */
  eventsOf?(transactionHash: Hex): Promise<readonly ServedEventOnTheWire[]>;
  /**
   * **THE TRANSACTION IN THIS VAULT'S OWN HISTORY WHOSE EVENTS CARRY AN OUTPUT
   * WITH THIS COMMITMENT, OWNED BY THIS VAULT**, with those events; `null` when
   * none does yet. For a note whose sender could not name its transaction.
   * Absent where this deployment reads no chain.
   */
  createdBy?(vault: Hex, commitment: string): Promise<{ transactionHash: Hex; events: readonly ServedEventOnTheWire[] } | null>;
}

/** The chain as one block saw it, for a private payment to be built on. Every value is the bytes, as base64. */
export interface PayoutState {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}

/** The company account as one block saw it, for a governed call to be built on. Base64 of the bytes. */
export interface AccountCallState {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/** One zswap event of one transaction, with its position as a decimal string. */
export interface ServedEventOnTheWire {
  readonly transactionHash: string;
  readonly details: { readonly tag: string; readonly commitment?: string; readonly contract?: string; readonly mtIndex?: string };
}

export interface CompanyVaultDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: {
    getAccount(id: string): SealedAccount | null;
    putCompanyVault(v: CompanyVault): void;
    getCompanyVault(vault: string): CompanyVault | null;
    /** The company account's deploy as its founding signer's browser sent it, when it was created that way. */
    getAccountDeploy(accountId: string): AccountDeploy | null;
    listCompanyVaults(accountId: string): CompanyVault[];
    /** The company's records keys and filing keys with nobody's name on them, made from the sealed roster. */
    getVaultKeyIndex(accountId: string): CompanyVaultKeyIndex | null;
    /** The signatures one company keeps for one contract's committee updates, at the counter they were signed against. */
    getCommitteeSignatures(accountId: string, address: string): CollectedCommitteeSignatures | null;
    putCommitteeSignatures(c: CollectedCommitteeSignatures): void;
    /** Every contract's kept signatures for one company. */
    listCommitteeSignatures(accountId: string): CollectedCommitteeSignatures[];
  };
  /** The company's account contract address, its approval threshold, how many seats it holds and every vault's own, as the chain holds them. */
  readonly company: (accountId: string) => Promise<{
    address: Hex; threshold: number; seats: number; vaultThresholds: ReadonlyArray<{ vault: Hex; threshold: number }>;
  } | null>;
  readonly ledger: Pick<Ledger, 'sendVault'>;
  readonly chain: VaultChain;
  /** Every vault circuit's verifying key, as this build compiled it. */
  readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
  /** The company account's deployed circuits and their verifying keys, as this build compiled them. */
  readonly account: {
    readonly circuits: readonly string[];
    readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
    /** The public half of the temporary key this deployment once created accounts under, so a seat it holds is named as this service's. */
    readonly temporaryKey?: { tag: string; value: string };
  };
  readonly readers: { proven(bytes: Uint8Array): Promise<unknown>; finished(bytes: Uint8Array): Promise<unknown> };
  /**
   * Puts one contract's committee update together from the signatures its
   * committee's wallets made, counting only those that verify under the
   * committee holding it on the chain, and proves it once they reach that
   * committee's threshold. It takes no key. Absent where this deployment sends
   * nothing, and then a committee change is refused by name.
   */
  readonly committeeChange?: (input: {
    read: AuthorityRead; to: Committee; signatures: readonly PlaceSignature[]; label: string;
  }) => Promise<{
    have: number; required: number; indexesSigned: number[]; counted: readonly PlaceSignature[]; proven: Uint8Array | null;
  }>;
  readonly now?: () => Date;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

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
  if (refused === null) return 'held-by-committee';
  /* The company's in every other way, and not yet adopted with its first secret: creating it again finishes it. */
  if (refused.notStarted === true) return 'start-owed';
  /* An account still exactly as deployed is a step somebody has not taken yet; any other refusal about the
   * account - other keys, more than one change, circuits this build did not compile - is an alarm. */
  if (refused.accountNotReady === 'not-handed-over') return 'account-not-handed-over';
  if (refused.accountNotReady === 'not-vouched') return 'account-not-fundable';
  if (refused.accountNotReady === 'unknown') return 'unknown';
  /*
   * **WHAT THE CHAIN SAID IS READ HERE AND NOT INFERRED FROM THE REFUSAL.** A
   * vault the chain could not be asked about is not a vault this service has
   * decided something about, whatever else the refusal carries.
   */
  if (read.state !== 'answered' && read.state !== 'read') return read.state === 'absent' ? 'not-on-chain-yet' : 'unknown';
  if (!refused.heldByOthers) return 'not-fundable';
  return 'held-by-other-keys';
}

/** The signed-in person, as the sign-in in front of these routes set them. */
const personOf = (req: express.Request): string => (req as { userId?: string }).userId!;

export function companyVaultRoutes(deps: CompanyVaultDeps): express.Router {
  const r = express.Router();
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
      res.status(nothing ? 422 : 502).json({
        nothingWasSent: nothing, error: (e as { message?: string })?.message ?? 'unknown error',
      });
      return null;
    }
  };

  /* ---- keys ---- */

  /* A signer's vault keys are offered, and folded into the roster, through `signerRoutes`. */

  /*
   * **THE COMMITTEE HOLDING THE ACCOUNT ON THE CHAIN, AND THE READERS, WITH
   * NOBODY'S NAME ON EITHER.** The committee is a chain read, which a new vault
   * is born held by, and only the step that creates a vault reads it; the
   * readers are the records keys the sealed roster names, and a device checks
   * them against its roster alone, never by the committee.
   */
  r.get('/api/accounts/:id/vault-keys', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    const index = deps.store.getVaultKeyIndex(account.id);
    const readers = index !== null && company !== null && index.signerCount === company.seats ? [...index.readers] : [];
    res.json({ committee, why, readers });
  });

  /* ---- vaults ---- */

  r.get('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const account = accountOf(req);
    const company = await deps.company(account.id);
    const out = [];
    const accountFacts = company === null ? undefined : await accountFactsOf(account.id, company.address);
    for (const v of deps.store.listCompanyVaults(account.id)) {
      const refused: { why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true; vaultRead?: ContractAnswer } | null =
        company === null
          ? { why: NO_COMPANY, heldByOthers: false, accountNotReady: 'unknown' }
          : await whyNotFunded(v.vault, company.address, undefined, accountFacts);
      out.push({
        vault: v.vault,
        deployedAt: v.deployedAt,
        /* Where the vault stands, from the read the gate was given. */
        state: vaultState(refused?.vaultRead ?? { state: 'answered' }, refused),
        why: refused?.why ?? null,
      });
    }
    res.json({ rows: out });
  });

  r.post('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /*
     * **NO VAULT UNTIL THE COMPANY'S ACCOUNT IS FINISHED**: created from
     * its founding signer's browser and recorded here, and running every one of
     * this build's circuits, which it does only once its second step has landed.
     * A vault adopted by an account that is not yet this build's would be pinned
     * to rules nobody here has read.
     */
    const accountNow = await accountFactsOf(account.id, company.address);
    if (!accountNow.bornHeld) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'this company\'s account was not created held by its committee from its first transaction, so no vault is '
          + 'made for it: money put into a vault pays out on this account. Nothing was sent.',
      });
      return;
    }
    if (accountNow.circuits !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'this company\'s account is not finished being created yet, so no vault is made for it. Finish creating '
          + 'the company first. Nothing was sent.',
      });
      return;
    }
    const verifierKeys = await deps.verifierKeys();
    let vault: Hex | null = null;
    const sent = await send(res, account.id, 'deploying a vault', 'proven-moving-nothing', bytes, (tx) => {
      const verdict = readVaultDeploy(tx, {
        account: company.address, holders: committee, verifierKeys, startingLedgerOf: deps.chain.startingLedgerOf,
      });
      if ('refusal' in verdict) return verdict.refusal;
      vault = verdict.vault as Hex;
      if (deps.store.getCompanyVault(vault) !== null) return 'a vault at that address is already recorded. Nothing was sent.';
      return null;
    });
    /* Recorded whenever a submission was attempted, including one that may have landed,
     * because a vault nobody recorded is one nobody would ever hand over. */
    if (vault !== null && (sent !== null || res.statusCode === 502)) {
      /* Born held: the reader above read the deploy as held from its first transaction by exactly the committee holding the
       * company's account on the chain. The
       * deploy itself is kept, so a signer's device can read the vault as it was deployed before it is adopted. */
      deps.store.putCompanyVault({
        accountId: account.id, vault, deployedAt: now().toISOString(),
        deployRef: sent?.ref ?? 'unknown', intended: { committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold },
        bornHeld: true, deploy: Buffer.from(bytes).toString('base64'),
      });
    }
    if (sent === null) return;
    res.status(201).json({ vault, txRef: sent.ref, state: 'deploy-sent' });
  });

  r.post('/api/accounts/:id/vaults/:vault/handover', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    /* The vault is handed to the committee holding the company's account on the chain now, and to nothing else. */
    const { committee, why } = await accountCommittee(account);
    if (committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const read = await authorityOf(record.vault);
    if (read.state !== 'read') {
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be asked who holds this vault (${read.why}). Nothing was sent.` });
      return;
    }
    const sent = await send(res, account.id, 'handing a vault to the company\'s committee', 'proven-moving-nothing', bytes,
      (tx) => refusalForHandover(tx, { vault: record.vault, to: committee, onChain: read.authority }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, state: 'handover-sent' });
  });

  r.get('/api/accounts/:id/vaults/:vault/chain', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    let state: unknown;
    try {
      state = await deps.chain.contractState(record.vault);
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this vault: ${(e as Error)?.message ?? e}` });
      return;
    }
    if (state === null || state === undefined) {
      res.json({ vault: record.vault, onChain: false });
      return;
    }
    /*
     * **NOBODY WHO HOLDS A CONTRACT IS READ HERE.** This view carries the
     * vault's state and its notes, and never the vault's or the account's
     * maintenance authority. It does not say whether money may go in or out:
     * a device answers that itself, from the chain its own wallet reads. The
     * service refuses a deposit or a payment on its own gate when it is asked
     * to send one.
     */
    /*
     * **WHETHER THE NOTES BELOW WERE READ OFF A LEDGER OF THIS BUILD'S SHAPE**,
     * said beside them. A signer's device compares its own record of the notes
     * with them, and does so only when they were.
     */
    /* Whether the vault is started: adopted, its first secret approved and every sealed copy written. */
    let started = false;
    try {
      started = deps.chain.startingLedgerOf(state).started;
    } catch { /* a state that is not a vault's is not started */ }
    let notesFromThisBuild = false;
    let notesWhy: string | undefined;
    if (deps.chain.ledgerIsThisBuilds === undefined) {
      notesWhy = 'this service is not set up to check how a vault is laid out, so it does not vouch for which notes '
        + 'the vault holds. Whoever runs the service turns that check on';
    } else {
      try {
        await deps.chain.ledgerIsThisBuilds(state);
        notesFromThisBuild = true;
      } catch (e) {
        notesWhy = (e as Error)?.message ?? String(e);
      }
    }
    let everCreated: string[];
    try {
      everCreated = [...await deps.chain.everCreated(record.vault)];
    } catch (e) {
      res.status(503).json({ error: `the vault's history could not be read in full: ${(e as Error)?.message ?? e}` });
      return;
    }
    /*
     * **WHAT THE VAULT HOLDS IN PUBLIC MONEY, OFF THE SAME STATE**, which the
     * indexer serves as its latest action left it, so a public deposit shows as soon
     * as its state does. Read here because the page does not carry the
     * ledger. Every token is listed with its amount as a decimal string; a
     * balance this service cannot read is said in words and never sent as an
     * empty list, because an empty list means the vault holds none.
     */
    let publicBalances: Array<{ token: string; amount: string }> | undefined;
    let publicBalancesWhy: string | undefined;
    try {
      publicBalances = publicHoldingsOf(state).map((h) => ({ token: h.token, amount: h.amount.toString() }));
    } catch (e) {
      /* Only the reader's own refusal is passed on in its words; anything else is said plainly. */
      publicBalancesWhy = e instanceof PublicBalanceUnreadable
        ? e.message
        : 'this service could not read what the vault holds in public money';
    }
    res.json({
      vault: record.vault,
      onChain: true,
      state: toBase64(deps.chain.serialize(state)),
      ...(publicBalances === undefined ? { publicBalancesWhy } : { publicBalances }),
      notes: deps.chain.notesOf(state),
      notesFromThisBuild,
      ...(notesWhy === undefined ? {} : { notesWhy }),
      everCreated,
      /* The deploy the vault's address was made from, for a signer's device to read the vault as it was born. */
      deployed: record.deploy ?? null,
      started,
    });
  });

  r.post('/api/accounts/:id/vaults/:vault/deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD ABOVE. */
    const refusal = await whyNotFunded(record.vault, company.address);
    if (refusal !== null) {
      res.status(409).json({ nothingWasSent: true, error: refusal.why });
      return;
    }
    const sent = await send(res, account.id, 'a deposit into a vault', 'finished-by-the-depositor', bytes,
      (tx) => refusalForDeposit(tx, { vault: record.vault }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /*
   * **A PUBLIC DEPOSIT, BEHIND THE SAME GATE AS A PRIVATE ONE.** The page names
   * the token and the amount it asked the vault to receive, and the transaction
   * is refused unless it is exactly that, into this vault, paid for by the
   * depositor's own public money.
   */
  r.post('/api/accounts/:id/vaults/:vault/public-deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const asked = z.object({
      tx: z.string().min(1).max(VAULT_TX_LIMIT),
      token: z.string().regex(HEX64),
      amount: z.string().regex(/^[1-9][0-9]{0,38}$/u),
    }).strict().safeParse(req.body);
    if (!asked.success) {
      res.status(400).json({
        nothingWasSent: true,
        error: 'this request does not say which public token and how much of it goes into the vault, with the '
          + 'transaction that puts it there. Nothing was sent and no money moved. Reload the page and try again; if it '
          + 'happens again, the service needs attention.',
      });
      return;
    }
    const bytes = new Uint8Array(Buffer.from(asked.data.tx, 'base64'));
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD ABOVE. */
    const refusal = await whyNotFunded(record.vault, company.address);
    if (refusal !== null) {
      res.status(409).json({ nothingWasSent: true, error: refusal.why });
      return;
    }
    const sent = await send(res, account.id, 'a public deposit into a vault', 'finished-by-the-depositor', bytes,
      async (tx) => refusalForPublicDeposit(tx, {
        vault: record.vault, token: asked.data.token, amount: BigInt(asked.data.amount),
        addressOf: (await import('@midnightntwrk/ledger-v9')).addressFromKey as (owner: unknown) => string,
      }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /* ---- a vault's start ---- */

  /*
   * **A VAULT IS STARTED FROM THE DEVICE THAT CREATED IT, AND THIS SERVICE PAYS
   * ONLY THE FEE.** The company's account adopts it, the first secret run is
   * raised and approved, the secret is set and each signer's sealed copy is
   * written; every one of those is built and proved on a signer's device, and
   * read here before it is paid for. Only for a vault that is this company's as
   * the chain and this service's record show it now (`vaultIsTheCompanys`),
   * whoever holds its rules. None moves money, and none lets money in on its
   * own: the deposit door still asks the whole gate.
   *
   * **NOTHING IS SENT TWICE.** A step sent and not yet shown by the chain is
   * held here, by the vault, the step and, for an approval, the person, for as
   * long as it could still land; only a refusal that says nothing was sent
   * frees it. In this process only: the chain's own refusals stand behind it.
   */
  const startSent = new Map<string, number>();
  const startStillPending = (key: string): boolean => {
    const at = startSent.get(key);
    return at !== undefined && now().getTime() - at < HANDOVER_LIFETIME_MS;
  };

  /** The vault and its company, for a vault that is the company's as the chain and the record show it now; or the refusal, sent. */
  const startable = async (req: express.Request, res: express.Response) => {
    const record = theVault(req, res);
    if (record === null) return null;
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return null;
    }
    const refused = await whyNotFunded(record.vault, company.address,
      undefined, undefined, 'this vault is not started from here', vaultIsTheCompanys);
    if (refused !== null) {
      res.status(409).json({ nothingWasSent: true, error: refused.why });
      return null;
    }
    return { record, account, company };
  };

  /** Sends one step once, holding it until it could no longer land, and answers with the reference. */
  const sendStep = async (
    res: express.Response, key: string, accountId: string, what: string, bytes: Uint8Array,
    check: (tx: unknown) => string | null,
  ) => {
    if (startStillPending(key)) {
      res.status(409).json({
        nothingWasSent: true,
        error: `${what} was sent and the chain has not shown it yet, and the chain would refuse a second copy once the first `
          + 'lands. Nothing was sent; wait for the first, then create the vault again to carry on.',
      });
      return;
    }
    startSent.set(key, now().getTime());
    const sent = await send(res, accountId, what, 'proven-moving-nothing', bytes, check);
    if (sent === null) {
      if (res.statusCode !== 502) startSent.delete(key);
      return;
    }
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  };

  r.post('/api/accounts/:id/vaults/:vault/start/account', ...guard, async (req, res) => {
    const body = z.object({
      tx: z.string().min(1).max(VAULT_TX_LIMIT),
      step: z.enum(['adoption', 'secret-run']),
      call: z.enum(['approve', 'adopt']),
    }).strict().safeParse(req.body);
    if (!body.success || (body.data.step === 'secret-run' && body.data.call === 'adopt')) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not a step of a vault\'s start on the company\'s account. Nothing was sent.' });
      return;
    }
    const at = await startable(req, res);
    if (at === null) return;
    const { step, call } = body.data;
    /* Carrying out happens once per vault; an approval once per person. */
    const key = `${at.record.vault}:${step}:${call}${call === 'approve' ? `:${personOf(req)}` : ''}`;
    const what = step === 'adoption'
      ? (call === 'approve' ? 'approving the adoption of this vault' : 'adopting this vault')
      : 'approving this vault\'s first secret';
    await sendStep(res, key, at.account.id, what, new Uint8Array(Buffer.from(body.data.tx, 'base64')),
      (tx) => refusalForStartAccountCall(tx, { account: at.company.address, circuit: call }));
  });

  r.post('/api/accounts/:id/vaults/:vault/start/secret', ...guard, async (req, res) => {
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const at = await startable(req, res);
    if (at === null) return;
    /* A first secret, and only while the vault holds none: the chain read now, never a record kept here. */
    let held: string | null = null;
    try {
      held = deps.chain.startingLedgerOf(await deps.chain.contractState(at.record.vault)).nonceCommitment;
    } catch (e) {
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be read for this vault (${(e as Error)?.message ?? e}). Nothing was sent.` });
      return;
    }
    if (!/^0+$/u.test(held)) {
      res.status(409).json({ nothingWasSent: true, error: 'this vault already holds a secret, so a first one is not set again. Nothing was sent.' });
      return;
    }
    await sendStep(res, `${at.record.vault}:secret`, at.account.id, 'setting this vault\'s first secret', bytes,
      (tx) => refusalForSetNonceSecret(tx, { vault: at.record.vault, account: at.company.address }));
  });

  r.post('/api/accounts/:id/vaults/:vault/start/copy', ...guard, async (req, res) => {
    const body = z.object({ tx: z.string().min(1).max(VAULT_TX_LIMIT), place: z.number().int().min(0).max(1023) }).strict()
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not one sealed copy of a vault\'s secret, by its place. Nothing was sent.' });
      return;
    }
    const at = await startable(req, res);
    if (at === null) return;
    let started: boolean;
    try {
      started = deps.chain.startingLedgerOf(await deps.chain.contractState(at.record.vault)).started;
    } catch (e) {
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be read for this vault (${(e as Error)?.message ?? e}). Nothing was sent.` });
      return;
    }
    if (started) {
      res.status(409).json({ nothingWasSent: true, error: 'every sealed copy of this vault\'s secret is already written. Nothing was sent.' });
      return;
    }
    await sendStep(res, `${at.record.vault}:copy:${body.data.place}`, at.account.id,
      'writing a sealed copy of this vault\'s secret', new Uint8Array(Buffer.from(body.data.tx, 'base64')),
      (tx) => refusalForSecretCopy(tx, { vault: at.record.vault }));
  });

  /* ---- a private payment out ---- */

  /*
   * **WHAT A PAYMENT OUT IS BUILT ON, AND NOTHING THAT OPENS A NOTE.** The
   * device holds the pool and chooses the note; this answers only what the
   * chain holds, all of it read at one block, so the vault's call and the
   * account's answer to it are built on the same moment.
   */
  r.get('/api/accounts/:id/vaults/:vault/payout-state', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const company = await deps.company(record.accountId);
    if (company === null) {
      res.status(409).json({ error: 'this company has no contract on the chain this service can read, so nothing can be paid out.' });
      return;
    }
    if (deps.chain.payoutState === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain, so nothing can be paid out.' });
      return;
    }
    try {
      const state = await deps.chain.payoutState(record.vault, company.address);
      if (state === null) {
        res.status(409).json({ error: 'the chain does not hold this vault and this company\'s account at one block yet. Try again shortly.' });
        return;
      }
      res.json({ vault: record.vault, account: company.address, ...state });
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this payment: ${(e as Error)?.message ?? e}` });
    }
  });

  /*
   * **WHAT A RAISE OR AN APPROVAL IS BUILT ON: THE ACCOUNT AS THE CHAIN HOLDS
   * IT, AND NOTHING A SIGNER HOLDS.** The device composes its own half; this
   * answers only public state, read at one block, and the account's address.
   */
  r.get('/api/accounts/:id/call-state', ...guard, async (req, res) => {
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ error: 'this company has no contract on the chain this service can read, so no round can be raised or approved on it yet.' });
      return;
    }
    if (deps.chain.accountCallState === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain, so no round can be raised or approved from a device.' });
      return;
    }
    try {
      const state = await deps.chain.accountCallState(company.address);
      if (state === null) {
        res.status(409).json({ error: 'the chain does not show this company\'s account yet. Try again shortly.' });
        return;
      }
      res.json({ account: company.address, ...state });
    } catch (e) {
      res.status(503).json({ error: `the chain could not be read for this company: ${(e as Error)?.message ?? e}` });
    }
  });

  r.get('/api/accounts/:id/vaults/:vault/events/:tx', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const tx = fold(String(req.params.tx));
    if (!HEX64.test(tx)) {
      res.status(400).json({ error: 'a transaction is named by its hash, sixty-four hex characters.' });
      return;
    }
    if (deps.chain.eventsOf === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain.' });
      return;
    }
    try {
      res.json({ events: await deps.chain.eventsOf(tx as Hex) });
    } catch (e) {
      /* The reader's own name travels, because "not yet" and "never" are different answers to a person waiting. */
      res.status(503).json({ error: (e as Error)?.message ?? String(e), kind: (e as Error)?.name ?? 'Error' });
    }
  });

  /*
   * **WHICH OF THIS VAULT'S TRANSACTIONS CREATED ONE OUTPUT, ASKED BY THE
   * OUTPUT'S COMMITMENT.** A device that sent a deposit or a payment and never
   * learned its transaction's hash asks here once the output has landed. Only
   * this vault's own transactions are read, and only an output this vault owns
   * answers; the device judges the events itself before it records anything.
   * The commitment is what the chain publishes for the output, and nothing a
   * device holds that opens the note is asked for.
   */
  r.get('/api/accounts/:id/vaults/:vault/created/:commitment', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const commitment = fold(String(req.params.commitment));
    if (!HEX64.test(commitment)) {
      res.status(400).json({ error: 'an output is named by its commitment, sixty-four hex characters.' });
      return;
    }
    if (deps.chain.createdBy === undefined) {
      res.status(503).json({ error: 'this deployment reads no chain.' });
      return;
    }
    try {
      const found = await deps.chain.createdBy(record.vault, commitment);
      res.json(found === null ? { found: false } : { found: true, transactionHash: found.transactionHash, events: found.events });
    } catch (e) {
      res.status(503).json({ error: (e as Error)?.message ?? String(e), kind: (e as Error)?.name ?? 'Error' });
    }
  });

  /*
   * **THE FEE ON A PRIVATE PAYMENT OUT, AND NOTHING ELSE.** Whether the company
   * approved it, whether its window is open and whether this person was already
   * paid are the account's to decide inside the same transaction; what is read
   * here is that it moves only this vault's own money, to one person, and needs
   * nothing from the fee payer but DUST.
   *
   * **AND ONLY OUT OF A VAULT THIS SERVICE CAN VOUCH FOR, READ FROM THE CHAIN
   * NOW** - the same gate as money going in: born held as this service's record
   * says, running this build's circuits, pinned to this company's account, and
   * so is the account. A vault whose circuits are not this build's may pay out
   * by rules this service never compiled, and this service does not pay the fee
   * for that. Who holds the vault's rules is not asked.
   */
  r.post('/api/accounts/:id/vaults/:vault/payout', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return;
    }
    /*
     * **THE SAME GATE, ASKED IN THIS DOOR'S OWN WORDS.** A person paying money
     * out is told why this payment is not paid for, never about money going in.
     */
    const unvouched = await whyNotFunded(
      record.vault, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: unvouched.why,
      });
      return;
    }
    const sent = await send(res, account.id, 'a private payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPayout(tx, { vault: record.vault, account: company.address }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /*
   * **THE FEE ON A MERGE OF THE VAULT'S OWN NOTES, BEHIND THE SAME GATE.** A
   * merge moves nothing out of the vault and needs no approval; the device
   * planned it, wrote it down and built it on what it read itself. What is
   * read here is only that it reshapes this vault's own coins into one the
   * vault keeps, and that the vault is one this service can vouch for.
   */
  r.post('/api/accounts/:id/vaults/:vault/merge', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return;
    }
    const unvouched = await whyNotFunded(
      record.vault, company.address, undefined, undefined,
      'this service pays no fee for a merge of this vault\'s notes');
    if (unvouched !== null) {
      res.status(409).json({ nothingWasSent: true, error: unvouched.why });
      return;
    }
    const sent = await send(res, account.id, 'a merge of a vault\'s notes', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForMerge(tx, { vault: record.vault }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /*
   * **THE FEE ON A PUBLIC PAYMENT OUT, BEHIND THE SAME GATE.** The vault releases
   * its own public money to one public address; the account decides the rest
   * inside the transaction, exactly as for a private payment. What differs is
   * only what the transaction may carry, and `refusalForPublicPayout` says it.
   */
  r.post('/api/accounts/:id/vaults/:vault/public-payout', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was sent.` });
      return;
    }
    const unvouched = await whyNotFunded(
      record.vault, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: unvouched.why,
      });
      return;
    }
    const sent = await send(res, account.id, 'a public payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPublicPayout(tx, { vault: record.vault, account: company.address }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /* ---- who holds the company's rules ---- */

  /*
   * **WHO HOLDS EACH SEAT IS NOT ANSWERED HERE.** This service keeps no record of
   * which key is whose; a device names each committee key from the seats it
   * believes, and says which is its own from its own wallet.
   */
  const NO_HOLDERS: ReadonlyMap<string, string> = new Map();

  /* How long a transaction sent from here could still land: its time to live. */
  const HANDOVER_LIFETIME_MS = 30 * 60_000;

  /*
   * **EVERY VAULT THE COMPANY'S ACCOUNT LISTS ON THE CHAIN**, adopted or
   * retired: the account's own record of its vaults, and the only thing that
   * makes a vault the company's here. Neither the account a vault's deployer
   * pinned it to, nor this service's list of vaults, nor its record of how
   * each was created decides it. Empty when the chain could not be asked.
   */
  const listedVaults = async (companyAddress: Hex): Promise<string[]> => {
    if (deps.chain.accountVaults === undefined) return [];
    try {
      return [...new Set((await deps.chain.accountVaults(companyAddress)).map(fold))].filter((v) => HEX64.test(v) && v !== fold(companyAddress));
    } catch { return []; }
  };

  /*
   * **EVERY CONTRACT OF THE COMPANY, WITH WHO HOLDS EACH ON THE CHAIN NOW**: the
   * account, and every vault it lists on the chain. For a screen to show and a
   * device to check; a change of who holds them names its own contracts.
   */
  const companyContracts = async (_account: SealedAccount, companyAddress: Hex) => {
    const out: { contract: 'account' | 'vault'; read: AuthorityRead; bornHeld: boolean }[] = [
      { contract: 'account', read: await authorityOf(companyAddress), bornHeld: true },
    ];
    for (const v of await listedVaults(companyAddress)) out.push({ contract: 'vault', read: await authorityOf(v as Hex), bornHeld: true });
    return out;
  };

  /**
   * **WHETHER A CONTRACT IS OFFERED A CHANGE ON THE SETTINGS SCREEN, AND THE
   * SENTENCE BESIDE IT**, from the same list the change view is built from, so
   * the screen never offers what the view would not list.
   */
  const changeOffered = (committee: Committee | null, owed: readonly ContractOwingAChange[]) => {
    if (committee === null) {
      return { possible: false, why: 'No committee holds this company\'s account on the chain yet, so there is nothing to change its vaults to.' };
    }
    const vaultsBehind = owed.filter((c) => c.contract === 'vault').length;
    if (owed.length === 0) {
      return {
        possible: false,
        why: 'No change is waiting. Every contract listed above that could be read is held by the committee that holds '
          + 'the company\'s account.',
      };
    }
    return {
      possible: true,
      why: `${vaultsBehind} vault${vaultsBehind === 1 ? ' is' : 's are'} still held by the super admins from before they last `
        + 'changed. Until a vault is changed, the keys of the super admins who left can still change its rules. Payments '
        + 'into and out of it go on as before. The super admins who hold each one now sign the change in their own '
        + 'wallets, and once enough have signed, a device sends it.',
    };
  };

  r.get('/api/accounts/:id/authority', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    const serviceKey = deps.account.temporaryKey ?? null;
    const contracts: ContractAuthorityView[] = [];
    const listed = company === null ? [] : await companyContracts(account, company.address);
    for (const c of listed) contracts.push(authorityView(c.contract, c.read, committee, NO_HOLDERS, serviceKey));
    res.json({
      company: company === null ? null : { address: company.address, label: account.companyLabel ?? null },
      committee,
      why,
      contracts,
      change: changeOffered(
        committee,
        company === null || committee === null ? [] : contractsOwingAChange(listed, committee).owed),
    });
  });

  /* ---- a change of who holds the company's contracts ---- */

  /*
   * **THE SIGNATURES KEPT FOR ONE CONTRACT'S UPDATE TO `to`, AT `counter`.**
   * Signatures kept for a counter the chain has moved past are never handed on:
   * they can never count again.
   */
  const keptRecord = (accountId: string, address: string, counter: bigint): CollectedCommitteeSignatures | null => {
    const kept = deps.store.getCommitteeSignatures(accountId, address);
    return kept !== null && kept.counter === counter.toString() && Array.isArray(kept.proposed) ? kept : null;
  };
  const keptFor = (accountId: string, address: string, counter: bigint, to: Committee): PlaceSignature[] =>
    (keptRecord(accountId, address, counter)?.proposed.find((p) => sameCommittee(p.to as Committee, to))?.signatures ?? [])
      .map((x) => ({ index: x.index, signature: { tag: x.signature.tag, value: x.signature.value } }));
  /** Keeps `counted` as the signatures for `to` at `counter`, and whether an update at that counter was sent. */
  const keep = (accountId: string, address: string, counter: bigint, to: Committee, counted: readonly PlaceSignature[], sentAt?: string | null) => {
    const before = keptRecord(accountId, address, counter);
    const others = (before?.proposed ?? []).filter((p) => !sameCommittee(p.to as Committee, to));
    deps.store.putCommitteeSignatures({
      accountId, address: fold(address), counter: counter.toString(),
      proposed: [...others, {
        to: { committee: to.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: to.threshold },
        signatures: counted.map((c) => ({ index: c.index, signature: { tag: c.signature.tag, value: c.signature.value } })),
      }],
      sentAt: sentAt === undefined ? before?.sentAt ?? null : sentAt,
    });
  };

  /*
   * **WHICH OF THIS COMPANY'S CONTRACTS AN ADDRESS IS, READ FROM THE CHAIN**:
   * its account, or a vault the account itself lists (`listedVaults`). The
   * account a vault's deployer pinned it to is the deployer's claim, so it
   * decides nothing here.
   */
  const contractOf = async (companyAddress: string, address: string): Promise<{ contract: 'account' | 'vault'; label: string } | string> => {
    if (fold(address) === fold(companyAddress)) return { contract: 'account', label: 'the company\'s account' };
    return (await listedVaults(companyAddress as Hex)).includes(fold(address))
      ? { contract: 'vault', label: `vault ${address}` }
      : 'this company has no contract at that address: the company\'s account does not list a vault there on the chain.';
  };

  /*
   * **ONE REQUEST AT A TIME PER CONTRACT.** Two devices asking at once would
   * otherwise both read the same signatures, each write back what it read, and
   * both send. In this process only; the counter kept with the signatures
   * stands behind it across processes.
   */
  const inTurn = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = inTurn.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.then(() => undefined, () => undefined);
    inTurn.set(key, settled);
    void settled.then(() => { if (inTurn.get(key) === settled) inTurn.delete(key); });
    return mine;
  };

  /*
   * **THE VAULTS NOT HOLDING THE COMMITTEE THAT HOLDS THE COMPANY'S ACCOUNT ON
   * THE CHAIN.** Read from the chain each time: the committee holding the
   * account, which is the only committee offered here, and for each vault the
   * committee holding it, the counter an update is signed against and the
   * places on that committee whose signatures are kept. Nothing taken from a
   * change in progress is offered.
   */
  r.get('/api/accounts/:id/committee-change', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    if (company === null || committee === null) {
      res.json({
        company: company?.address ?? null, label: account.companyLabel ?? null,
        to: null, why, contracts: [], notChangeable: [],
      });
      return;
    }
    const { owed, notChangeable } = contractsOwingAChange(await companyContracts(account, company.address), committee);
    res.json({
      company: company.address,
      /* The company's label, from the same record as the address: what the signer's wallet derives its key from. */
      label: account.companyLabel ?? null,
      to: committee,
      why: null,
      contracts: owed.map((c) => ({
        contract: c.contract,
        address: c.address,
        counter: c.counter.toString(),
        now: c.now,
        signedIndexes: keptFor(account.id, c.address, c.counter, committee).map((x) => x.index),
        required: c.now.threshold,
      })),
      notChangeable,
    });
  });

  const KEY = z.object({ tag: z.string().min(1).max(32), value: z.string().regex(/^[0-9a-f]{1,256}$/u) }).strict();
  const TO = z.object({ committee: z.array(KEY).min(1).max(64), threshold: z.number().int() }).strict();
  const PLACE = z.object({ index: z.number().int().min(0).max(1023), signature: KEY }).strict();

  /*
   * **SIGNATURES ON CONTRACTS' COMMITTEE UPDATES, AS WALLETS MADE THEM, KEPT.**
   * For each contract named: that it is the company's on the chain, the
   * counter the chain holds it at, and each signature verifying, at the place
   * it names, under the committee holding it on the chain, over
   * `committeeUpdateOf`'s bytes for `to`. What verifies is kept; nothing is
   * sent. No role, seat or signer is read, and `to` is whatever committee the
   * signatures are over, refused only by the one install rule.
   */
  r.post('/api/accounts/:id/committee-change/signatures', ...guard, async (req, res) => {
    const body = z.object({
      to: TO,
      signatures: z.array(z.object({
        address: z.string().regex(HEX64), counter: z.string().regex(/^[0-9]{1,20}$/u), index: z.number().int().min(0).max(1023), signature: KEY,
      }).strict()).min(1).max(64),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'these are not signatures on a change of a contract\'s committee. Nothing was kept or sent.' });
      return;
    }
    const to: Committee = body.data.to;
    const notInstallable = whyNotInstallable(to);
    if (notInstallable !== null) {
      res.status(409).json({ nothingWasSent: true, error: `these signatures are on a committee that cannot be installed: ${notInstallable} Nothing was kept or sent.` });
      return;
    }
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was kept or sent.` });
      return;
    }
    const assemble = deps.committeeChange;
    if (assemble === undefined) {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not check or send committee changes, so nothing was kept.' });
      return;
    }
    const results: Array<Record<string, unknown>> = [];
    const byAddress = new Map<string, typeof body.data.signatures>();
    for (const sig of body.data.signatures) byAddress.set(sig.address, [...(byAddress.get(sig.address) ?? []), sig]);
    for (const [address, given] of byAddress) {
      await oneAtATime(address, async () => {
        const which = await contractOf(company.address, address);
        if (typeof which === 'string') { results.push({ address, state: 'refused', nothingWasSent: true, error: which }); return; }
        const read = await authorityOf(address as Hex);
        if (read.state !== 'read') {
          results.push({ address, state: 'refused', nothingWasSent: true, error: `the chain could not be asked who holds ${which.label} (${read.why}).` });
          return;
        }
        if (given.some((g) => g.counter !== read.authority.counter.toString())) {
          results.push({
            address, state: 'refused', nothingWasSent: true,
            error: `${which.label} has been changed since these signatures were made, so they no longer count. Sign again.`,
          });
          return;
        }
        let assembled: Awaited<ReturnType<NonNullable<CompanyVaultDeps['committeeChange']>>>;
        try {
          assembled = await assemble({
            read, to, label: which.label,
            signatures: [...keptFor(account.id, address, read.authority.counter, to), ...given.map((g) => ({ index: g.index, signature: g.signature }))],
          });
        } catch (e) {
          results.push({ address, state: 'refused', nothingWasSent: true, error: (e as Error)?.message ?? String(e) });
          return;
        }
        keep(account.id, address, read.authority.counter, to, assembled.counted);
        results.push({ address, state: 'kept', have: assembled.have, required: assembled.required, indexesSigned: assembled.indexesSigned });
      });
    }
    res.json({ results });
  });

  /* **EVERY SIGNATURE KEPT FOR THIS COMPANY'S CONTRACTS, HANDED BACK**, for each device to count only where it verifies. */
  r.get('/api/accounts/:id/committee-change/signatures', ...guard, (req, res) => {
    const kept = deps.store.listCommitteeSignatures(accountOf(req).id);
    res.json({
      signatures: kept.filter((k) => Array.isArray(k.proposed)).flatMap((k) => k.proposed.flatMap((p) => p.signatures.map((x) => ({
        address: k.address, counter: k.counter, index: x.index, signature: x.signature, to: p.to,
      })))),
    });
  });

  const CHANGE = z.object({
    company: z.string().min(1).max(256),
    salt: z.string().regex(HEX64),
    change: z.object({
      kind: z.literal('super-admins'),
      from: TO,
      committee: z.array(KEY).min(1).max(64),
      threshold: z.number().int(),
      contracts: z.array(z.object({
        contract: z.enum(['account', 'vault']), address: z.string().regex(HEX64), counter: z.string().regex(/^[0-9]{1,20}$/u),
      }).strict()).min(1).max(256),
    }).strict(),
    joined: z.array(z.object({ key: KEY, signature: z.string().regex(/^[0-9a-f]{128}$/u) }).strict()).max(64),
  }).strict();

  /*
   * **ONE CONTRACT'S UPDATE SENT, ON A DEVICE'S REQUEST, AND ONLY WHEN THE CHAIN
   * WOULD TAKE IT.** Sent only:
   *
   *   - with a change of the super admins (`change`), when `to` is the
   *     committee it installs, the contract is one it names, and every key `to`
   *     puts on this contract - every key of it the committee holding the
   *     contract on the chain does not hold - signed the change's bytes with its
   *     own key; and, for a vault, once the account reads current on the chain:
   *     holding `to` at a counter past the one the change was raised at;
   *   - without one, only to the committee holding the company's account on the
   *     chain now, which no key enters the company by;
   *   - once per counter: an update at a counter this service already sent is
   *     not sent again while it could still land, kept with the signatures so a
   *     restart or a second process sees it too;
   *   - and only once the signatures that verify, the kept and the given, reach
   *     the threshold of the committee holding the contract on the chain: the
   *     one count the chain makes, read before any fee is paid.
   *
   * No role, seat or signer is read, and nothing here decides which committee
   * the super admins may choose.
   */
  r.post('/api/accounts/:id/committee-change/send', ...guard, async (req, res) => {
    const body = z.object({
      address: z.string().regex(HEX64),
      counter: z.string().regex(/^[0-9]{1,20}$/u),
      to: TO,
      signatures: z.array(PLACE).max(64).optional(),
      change: CHANGE.optional(),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not a request to send one contract\'s committee update. Nothing was sent.' });
      return;
    }
    const { address, change } = body.data;
    const to: Committee = body.data.to;
    const refuse = (status: number, error: string) => { res.status(status).json({ nothingWasSent: true, error: `${error} Nothing was sent.` }); };
    const notInstallable = whyNotInstallable(to);
    if (notInstallable !== null) { refuse(409, `the committee asked for cannot be installed: ${notInstallable}`); return; }
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) { refuse(409, NO_COMPANY); return; }
    const assemble = deps.committeeChange;
    if (assemble === undefined || typeof deps.ledger.sendVault !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send committee changes, so nothing was sent.' });
      return;
    }
    await oneAtATime(address, async () => {
      const which = await contractOf(company.address, address);
      if (typeof which === 'string') { refuse(409, which); return; }
      const read = await authorityOf(address as Hex);
      if (read.state !== 'read') { refuse(503, `the chain could not be asked who holds ${which.label} (${read.why}).`); return; }
      if (body.data.counter !== read.authority.counter.toString()) {
        refuse(409, `${which.label} is at counter ${read.authority.counter} on the chain, not ${body.data.counter}, so an update signed `
          + 'at that counter would be refused: after its fee when its signatures still verify under the committee holding it now, '
          + 'with no fee when they do not. Read the chain again and sign at its counter.');
        return;
      }
      if (change !== undefined) {
        const installs: Committee = { committee: change.change.committee, threshold: change.change.threshold };
        if (!sameCommittee(installs, to)) { refuse(409, 'the committee asked for is not the one this change installs.'); return; }
        const first = change.change.contracts[0]!;
        if (first.contract !== 'account' || fold(first.address) !== fold(company.address)) {
          refuse(409, 'this change does not name the company\'s account first.');
          return;
        }
        if (!change.change.contracts.some((c) => fold(c.address) === fold(address))) {
          refuse(409, `this change does not name ${which.label}.`);
          return;
        }
        const L = await import('@midnightntwrk/ledger-v9');
        const bytes = superAdminChangeBytes(change.company, company.address, change.salt, change.change);
        const holders = read.authority.committee;
        const joins = to.committee.filter((k) => !holders.some((h) => fold(h.tag) === fold(k.tag) && fold(h.value) === fold(k.value)));
        const unsigned = joins.filter((k) => !change.joined.some((j) => fold(j.key.tag) === fold(k.tag) && fold(j.key.value) === fold(k.value)
          && joinedBy(L as never, bytes, k, j.signature)));
        if (unsigned.length > 0) {
          refuse(409, `${unsigned.length} key${unsigned.length === 1 ? '' : 's'} this update puts on ${which.label} ${unsigned.length === 1 ? 'has' : 'have'} `
            + 'not signed the change with its own key, so the update is not sent: a key nobody holds is never put on a contract.');
          return;
        }
        if (which.contract === 'vault') {
          const accountNow = await authorityOf(company.address);
          const current = accountNow.state === 'read' && accountNow.authority.counter > BigInt(first.counter)
            && sameCommittee({ committee: accountNow.authority.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: accountNow.authority.threshold }, to);
          if (!current) {
            refuse(409, 'the company\'s account does not yet hold this committee on the chain, and a vault\'s update is sent only once it does. '
              + 'Send the account\'s update first.');
            return;
          }
        }
      } else {
        const held = await accountCommittee(account);
        if (held.committee === null || !sameCommittee(held.committee, to)) {
          refuse(409, 'without a change of the super admins, a contract is changed only to the committee holding the company\'s '
            + 'account on the chain now, and that is not the committee asked for.');
          return;
        }
      }
      const record = keptRecord(account.id, address, read.authority.counter);
      if (record?.sentAt != null && now().getTime() - Date.parse(record.sentAt) < HANDOVER_LIFETIME_MS) {
        refuse(409, `an update of ${which.label} at this counter was sent and the chain has not shown it yet, and once the first lands `
          + 'the chain refuses a second: with no fee when the first changed who holds it, after its fee when it did not. Wait for the '
          + 'first, then read the chain again.');
        return;
      }
      let assembled: Awaited<ReturnType<NonNullable<CompanyVaultDeps['committeeChange']>>>;
      try {
        assembled = await assemble({
          read, to, label: which.label,
          signatures: [...keptFor(account.id, address, read.authority.counter, to), ...(body.data.signatures ?? [])],
        });
      } catch (e) { refuse(409, (e as Error)?.message ?? String(e)); return; }
      if (assembled.proven === null) {
        keep(account.id, address, read.authority.counter, to, assembled.counted);
        refuse(409, `${assembled.have} of the ${assembled.required} signatures the committee holding ${which.label} on the chain needs `
          + 'verify, and the chain refuses an update short of that before it takes it.');
        return;
      }
      /* Marked sent before it goes, so a second request, here or in another process, is refused rather than paid. */
      keep(account.id, address, read.authority.counter, to, assembled.counted, now().toISOString());
      try {
        const sent = await deps.ledger.sendVault!(account.id, `changing the committee holding ${which.label}`,
          'proven-moving-nothing', assembled.proven,
          (tx) => refusalForCommitteeChange(tx, { address, to, onChain: read.authority, contract: which.contract }),
          deps.readers.proven);
        res.json({ state: 'sent', txRef: sent.ref, have: assembled.have, required: assembled.required });
      } catch (e) {
        const nothing = saysNothingWasSent(e);
        /* Only a refusal that says nothing was sent frees the counter for another send; one that may have landed does not. */
        if (nothing) keep(account.id, address, read.authority.counter, to, assembled.counted, null);
        res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: (e as Error)?.message ?? String(e) });
      }
    });
  });

  return r;
}
