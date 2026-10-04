/**
 * **A COMPANY'S VAULTS, AS ITS SIGNERS' DEVICES CREATE, HAND OVER AND FUND
 * THEM.**
 *
 * Nothing a device sends here carries a secret: the device builds and proves a
 * vault's transactions; the depositor's own wallet puts in and signs for any
 * coin; this service reads what arrives, refuses anything that is not exactly
 * what the route is for, and pays only the network fee. **The one transaction
 * this service builds and signs itself is a company account's handover**, with
 * the temporary key it deployed the account under, and it reads that one as it
 * reads a stranger's before paying for it. What it answers about a vault's rules is read from
 * the chain each time it is asked.
 *
 *   PUT  /api/accounts/:id/vault-keys                   a signer's three public vault keys
 *   GET  /api/accounts/:id/vault-keys                   the committee, and who can read the records
 *   GET  /api/accounts/:id/vaults                       the company's vaults, and who holds each on chain
 *   POST /api/accounts/:id/vaults                       a vault deployed with a temporary key
 *   POST /api/accounts/:id/vaults/:vault/handover       that vault handed to the company's committee
 *   POST /api/accounts/:id/vaults/:vault/start/account  a step of its start on the account: the adoption round or the
 *                                                       first secret run raised or approved, or the adoption carried out
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
 *   POST /api/accounts/:id/authority/handover           the company account handed to the committee
 *
 * **AND THESE ROUTES CARRY NO MONEY INTO ANY VAULT UNTIL THE CHAIN SHOWS THE
 * COMPANY ACCOUNT HELD BY THE COMMITTEE TOO.** A vault pays out on its
 * account's approval, so whoever holds the account's rules decides every
 * vault's payouts, whoever holds the vault's. What these routes cannot stop:
 * anybody paying their own fee can call a vault's deposit directly.
 *
 * **A VAULT IS NEVER REPORTED CREATED UNTIL THE CHAIN SAYS ITS COMMITTEE HOLDS
 * IT.** A deploy whose handover has not landed is reported as a handover owed,
 * naming the vault, and no deposit into it is carried.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount, CompanyVault, AccountDeploy } from '../core/types.js';
import type { CompanyVaultKeyIndex, SignedVaultKeys } from '../core/vault-keys.js';
import { NoSeatToGiveKeysFor, VaultKeysAlreadyGiven, VaultKeysNotYours } from '../core/account.js';
import type { Ledger, VaultTxArrival } from '../core/ledger.js';
import { saysNothingWasSent } from '../core/jobs.js';
import { readContractAuthority, type AuthorityRead } from '../midnight/ledger.js';
import { committeeOf, sameCommittee, whyNoCommittee, whyOneKeyCouldActAlone, type Committee } from '../midnight/vault-committee.js';
import { publicHoldingsOf, PublicBalanceUnreadable } from '../midnight/public-balance.js';
import { authorityView, everySignerNeeded, type ContractAuthorityView, type SeatSignature } from '../midnight/company-authority.js';
import { contractsOwingAChange, type ContractOwingAChange } from '../midnight/committee-change.js';
import type { CollectedCommitteeSignatures } from '../core/store.js';
import {
  circuitsRefusal, committeeHoldsTheVault, readVaultDeploy, refusalForCommitteeChange, refusalForDeposit, refusalForHandover, refusalForPayout,
  refusalForPublicDeposit, refusalForPublicPayout, refusalForSecretCopy, refusalForSetNonceSecret, refusalForStartAccountCall,
  refusalToPutMoneyIn, type FundingFacts, type VaultStartingLedger,
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
    /** The company's vault keys with nobody's name on them, made from the sealed roster. */
    getVaultKeyIndex(accountId: string): CompanyVaultKeyIndex | null;
    /** The signatures collected so far for a committee change of one contract. */
    getCommitteeSignatures(address: string): CollectedCommitteeSignatures | null;
    putCommitteeSignatures(c: CollectedCommitteeSignatures): void;
  };
  /**
   * Writes one signer's signed vault keys into their own entry in the sealed
   * roster. It needs the viewing key, and it refuses keys not signed by that
   * entry's own signing key.
   */
  readonly giveVaultKeys: (accountId: string, viewingKey: string, userId: string, given: SignedVaultKeys) => 'given' | 'already-given';
  /** The company's account contract address, its approval threshold and every vault's own, as the chain holds them. */
  readonly company: (accountId: string) => Promise<{
    address: Hex; threshold: number; vaultThresholds: ReadonlyArray<{ vault: Hex; threshold: number }>;
  } | null>;
  readonly ledger: Pick<Ledger, 'sendVault'>;
  readonly chain: VaultChain;
  /** Every vault circuit's verifying key, as this build compiled it. */
  readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
  /** The company account's deployed circuits and their verifying keys, as this build compiled them. */
  readonly account: {
    readonly circuits: readonly string[];
    readonly verifierKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
    /**
     * Builds and proves the account's handover, signed by this service's
     * temporary key. Absent when this deployment keeps no such key, and then
     * the handover is refused by name.
     */
    readonly handover?: (input: { read: AuthorityRead; to: Committee; strictestBar: number }) => Promise<Uint8Array>;
    /** The public half of that temporary key, so a seat it holds is named as this service's. */
    readonly temporaryKey?: { tag: string; value: string };
  };
  readonly readers: { proven(bytes: Uint8Array): Promise<unknown>; finished(bytes: Uint8Array): Promise<unknown> };
  /**
   * Puts one contract's committee change together from the signatures its
   * signers' wallets made, checking each, and proves it once enough have
   * signed. It takes no key. Absent where this deployment sends nothing, and
   * then a committee change is refused by name.
   */
  readonly committeeChange?: (input: {
    read: AuthorityRead; to: Committee; strictestBar: number; signatures: readonly SeatSignature[]; label: string;
  }) => Promise<{ have: number; required: number; seatsSigned: number[]; proven: Uint8Array | null }>;
  readonly now?: () => Date;
}

/**
 * The committee a company's vault must be held by, from the keys its seated
 * signers gave. **Read from an index with no names in it**, made from the sealed
 * roster: the committee is a set, sorted by value, so nothing here needs to know
 * which key is whose. An index made when the company had a different number of
 * signers is not this company's committee, and says so.
 */
export function companyCommittee(
  account: SealedAccount, threshold: number, index: CompanyVaultKeyIndex | null,
): { committee: Committee | null; why: string | null } {
  const given = index !== null && index.signerCount === account.signerCount ? index.committeeKeys : [];
  const keys = [...given, ...Array.from({ length: Math.max(0, account.signerCount - given.length) }, () => null)];
  const why = whyNoCommittee({ keys, threshold, signerCount: account.signerCount });
  return why === null
    ? { committee: committeeOf(keys, threshold, account.signerCount), why: null }
    : { committee: null, why };
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/**
 * **ONE WORD FOR WHERE A VAULT STANDS, FROM WHAT THE CHAIN SAID AND WHY MONEY
 * MAY NOT GO IN.** `handover-owed` only when the vault is exactly as it was
 * deployed - one key, never changed - because that is the only state the
 * "finish" button can move. A vault held by any other set of keys, including a
 * committee the company had before a signer joined or left, is
 * `held-by-other-keys`: nothing on this screen can finish that, and saying
 * otherwise would send a person to press a button the service will refuse.
 */
export type AccountNotReady = 'not-handed-over' | 'not-vouched' | 'unknown';

export function vaultState(
  read: AuthorityRead,
  refused: { heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true } | null,
): string {
  if (refused === null) return 'held-by-committee';
  /* Held by the committee in every other way, and not yet adopted with its first secret: creating it again finishes it. */
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
  if (read.state !== 'read') return read.state === 'absent' ? 'not-on-chain-yet' : 'unknown';
  if (!refused.heldByOthers) return 'not-fundable';
  /* A vault is born held by the company's committee, so one held by anything else has nothing owed to it: it is not the company's. */
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

  /*
   * The strictest approval bar a contract enforces, which its committee may not sit below: a vault's own
   * threshold, or the company's; for the account, the highest of the company's and every vault's.
   */
  const strictestBarOf = (
    company: { threshold: number; vaultThresholds: ReadonlyArray<{ vault: Hex; threshold: number }> },
    vault: string | null,
  ): number => vault === null
    ? Math.max(company.threshold, ...company.vaultThresholds.map((v) => v.threshold))
    : company.vaultThresholds.find((v) => fold(v.vault) === fold(vault))?.threshold ?? company.threshold;

  const committeeNow = async (account: SealedAccount) => {
    const company = await deps.company(account.id);
    if (company === null) {
      return { company: null, committee: null, why: 'this company has no contract on the chain this service can read, so it has no vaults yet.' };
    }
    const found = companyCommittee(account, company.threshold, deps.store.getVaultKeyIndex(account.id));
    return { company, ...found };
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
   * **WHAT THE CHAIN SAYS ABOUT THE COMPANY'S ACCOUNT RIGHT NOW.** Its
   * authority and its circuits, each read afresh and never from a record kept
   * here. Read once per request and handed to every vault the request answers
   * for, because the account is the same account for all of them.
   */
  const accountFactsOf = async (
    accountId: string, companyAddress: Hex,
  ): Promise<{ read: AuthorityRead; circuits: string | null; bornHeld: boolean }> => {
    const read = await authorityOf(companyAddress);
    let state: unknown;
    try {
      state = await deps.chain.contractState(companyAddress);
    } catch (e) {
      return {
        read: { state: 'unreachable', address: companyAddress, why: (e as Error)?.message ?? String(e) },
        circuits: null,
        bornHeld: accountBornHeld(accountId, companyAddress),
      };
    }
    const keys = await deps.account.verifierKeys();
    return {
      read,
      circuits: circuitsRefusal(
        state, keys,
        'no money goes in, because this company\'s account is not the one this service\'s build compiled',
        deps.account.circuits, 'the account\'s'),
      bornHeld: accountBornHeld(accountId, companyAddress),
    };
  };

  /*
   * **WHETHER MONEY MAY GO INTO THIS VAULT.** Every fact is read from the chain
   * here and the answer itself is `refusalToPutMoneyIn`, which is the same
   * function the operator tools ask. This route reads; it does not decide.
   */
  const whyNotFunded = async (
    vault: Hex, read: AuthorityRead, committee: Committee, companyAddress: string, state?: unknown,
    accountFacts?: { read: AuthorityRead; circuits: string | null; bornHeld: boolean },
    what = 'no money goes into this vault',
    /* The narrower question a device's handover waits on: the vault alone, never a door carrying money. */
    asFar: typeof refusalToPutMoneyIn = refusalToPutMoneyIn,
  ): Promise<{ why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true; vaultRead: AuthorityRead } | null> => {
    let now = state;
    let vaultRead = read;
    if (now === undefined) {
      try {
        now = await deps.chain.contractState(vault);
      } catch (e) {
        /*
         * **A READ THAT WENT UNANSWERED IS A FACT THE GATE IS GIVEN, NOT A
         * REFUSAL WRITTEN HERE.** The rules read a moment ago are not what the
         * chain says now, so the vault is put to the gate as a chain that could
         * not be asked, and the caller is handed that read back: a screen then
         * shows a question that could not be answered, not an alarm about the
         * vault.
         */
        vaultRead = { state: 'unreachable', address: vault, why: `the chain could not be asked: ${(e as Error)?.message ?? e}` };
        now = null;
      }
    }
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
      committee,
      heldHere: deps.account.temporaryKey === undefined ? [] : [deps.account.temporaryKey],
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

  r.put('/api/accounts/:id/vault-keys', ...guard, async (req, res) => {
    const body = z.object({
      viewingKey: z.string().min(1),
      committeeKey: z.object({ tag: z.literal('schnorr'), value: z.string().regex(HEX64) }),
      recordsKey: z.string().regex(HEX64),
      signature: z.string().regex(/^[0-9a-f]{128}$/u),
      recordsKeyStatement: z.string().regex(/^[0-9a-f]{128}$/u).optional(),
      recordsKeySeat: z.string().regex(HEX64).optional(),
    }).strict().refine((b) => (b.recordsKeyStatement === undefined) === (b.recordsKeySeat === undefined)).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'these are not the two public keys, and your signature over them, that a signer gives for a company\'s vaults.' });
      return;
    }
    const account = accountOf(req);
    const { viewingKey, ...given } = body.data;
    try {
      const done = deps.giveVaultKeys(account.id, viewingKey, personOf(req), given as SignedVaultKeys);
      res.status(done === 'given' ? 201 : 200).json({ given: true });
    } catch (e) {
      if (e instanceof VaultKeysAlreadyGiven) { res.status(409).json({ error: e.message }); return; }
      if (e instanceof VaultKeysNotYours || e instanceof NoSeatToGiveKeysFor) { res.status(403).json({ error: e.message }); return; }
      throw e;
    }
  });

  /*
   * **THE COMMITTEE AND THE READERS, WITH NOBODY'S NAME ON EITHER.** Which key
   * is whose is in the sealed roster, and a device reads it there and refuses
   * any key this answer carries that the roster does not name.
   */
  r.get('/api/accounts/:id/vault-keys', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { committee, why } = await committeeNow(account);
    const index = deps.store.getVaultKeyIndex(account.id);
    const readers = index !== null && index.signerCount === account.signerCount ? [...index.readers] : [];
    res.json({ committee, why, readers });
  });

  /* ---- vaults ---- */

  r.get('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    const out = [];
    const accountFacts = company === null || committee === null ? undefined : await accountFactsOf(account.id, company.address);
    for (const v of deps.store.listCompanyVaults(account.id)) {
      const read = await authorityOf(v.vault);
      const refused: { why: string; heldByOthers: boolean; accountNotReady?: AccountNotReady; notStarted?: true; vaultRead?: AuthorityRead } | null =
        company === null || committee === null
          ? { why: why ?? 'this company has no committee yet.', heldByOthers: true }
          : await whyNotFunded(v.vault, read, committee, company.address, undefined, accountFacts);
      out.push({
        vault: v.vault,
        deployedAt: v.deployedAt,
        /* Where the vault stands, from the read the gate was given. */
        state: vaultState(refused?.vaultRead ?? read, refused),
        why: refused?.why ?? null,
      });
    }
    res.json({ rows: out });
  });

  r.post('/api/accounts/:id/vaults', ...guard, async (req, res) => {
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
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
      /* Born held: the reader above read the deploy as held by exactly this committee from its first transaction. The
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
    const { committee, why } = await committeeNow(account);
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
    const account = accountOf(req);
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
    const { company, committee, why } = await committeeNow(account);
    const read = await authorityOf(record.vault);
    /* Whether the COMMITTEE HOLDS THIS VAULT is one answer, and a device's handover waits on it; whether money
     * may go in also needs the company account held by the committee, and is a second one. */
    /*
     * **TWO QUESTIONS, AND KEEPING THEM APART IS DELIBERATE.** Whether the
     * committee holds this vault is what a device's handover waits on, and it
     * is answered by the committee alone. Whether money may go in is the whole
     * gate, the account included, and every door that carries money asks that
     * one.
     */
    /*
     * **IN WORDS TRUE OF BOTH DIRECTIONS.** A device reads this view before a
     * deposit and before a payment out, and the service refuses both on this
     * same gate, so a person paying out is never told only about money going in.
     */
    const either = 'no money goes into or out of this vault';
    const refusal = company === null || committee === null
      ? why
      : (await whyNotFunded(
        record.vault, read, committee, company.address, state, undefined, either, committeeHoldsTheVault))?.why ?? null;
    const notFundable = refusal !== null || company === null || committee === null
      ? null
      : (await whyNotFunded(record.vault, read, committee, company.address, state, undefined, either))?.why ?? null;
    /*
     * **WHETHER THE NOTES BELOW WERE READ OFF A LEDGER OF THIS BUILD'S SHAPE**,
     * said beside them. A signer's device compares its own record of the notes
     * with them, and does so only when they were.
     */
    /* Whether the vault is started: adopted, its first secret approved and every sealed copy written. */
    let started = false;
    try {
      started = deps.chain.startingLedgerOf(state).started;
    } catch { /* a state that is not a vault's is not started, and the gate above already says why */ }
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
      authority: read.state === 'read'
        ? { committee: read.authority.committee, threshold: read.authority.threshold, counter: String(read.authority.counter), shape: read.authority.shape }
        : null,
      committee,
      heldByCommittee: refusal === null,
      /* The deploy the vault's address was made from, for a signer's device to read the vault as it was born. */
      deployed: record.deploy ?? null,
      started,
      fundable: refusal === null && notFundable === null,
      why: refusal ?? notFundable,
    });
  });

  r.post('/api/accounts/:id/vaults/:vault/deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD ABOVE. */
    const refusal = await whyNotFunded(record.vault, await authorityOf(record.vault), committee, company.address);
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
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /* READ FROM THE CHAIN, NOW, AND NEVER FROM THE RECORD ABOVE. */
    const refusal = await whyNotFunded(record.vault, await authorityOf(record.vault), committee, company.address);
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
   * read here before it is paid for. Only for a vault this company's committee
   * holds, read from the chain now. None moves money, and none lets money in
   * on its own: the deposit door still asks the whole gate.
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

  /** The vault, its company and its committee, for a vault this company's committee holds now; or the refusal, sent. */
  const startable = async (req: express.Request, res: express.Response) => {
    const record = theVault(req, res);
    if (record === null) return null;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return null;
    }
    const refused = await whyNotFunded(record.vault, await authorityOf(record.vault), committee, company.address,
      undefined, undefined, 'this vault is not started from here', committeeHoldsTheVault);
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
        error: `${what} was sent and the chain has not shown it yet, and a second copy would be refused after its fee `
          + 'was paid. Nothing was sent; wait for the first, then create the vault again to carry on.',
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
      call: z.enum(['propose', 'approve', 'adopt']),
    }).strict().safeParse(req.body);
    if (!body.success || (body.data.step === 'secret-run' && body.data.call === 'adopt')) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not a step of a vault\'s start on the company\'s account. Nothing was sent.' });
      return;
    }
    const at = await startable(req, res);
    if (at === null) return;
    const { step, call } = body.data;
    /* Raising and carrying out happen once per vault; an approval once per person. */
    const key = `${at.record.vault}:${step}:${call}${call === 'approve' ? `:${personOf(req)}` : ''}`;
    const what = step === 'adoption'
      ? (call === 'propose' ? 'raising the adoption of this vault' : call === 'approve' ? 'approving the adoption of this vault'
        : 'adopting this vault')
      : (call === 'propose' ? 'raising this vault\'s first secret' : 'approving this vault\'s first secret');
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
   * NOW** - the same answer a device waits on before it opens the vault's
   * record: held by the company's committee, changed once, running this build's
   * circuits, pinned to this company's account. A vault whose rules somebody
   * else changed may pay out by rules this service never compiled, and this
   * service does not pay the fee for that. The funding rules for money going in
   * are asked exactly as they are above and are not changed.
   */
  r.post('/api/accounts/:id/vaults/:vault/payout', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    /*
     * **THE SAME GATE, ASKED IN THIS DOOR'S OWN WORDS.** A person paying money
     * out is told why this payment is not paid for, never about money going in.
     */
    const unvouched = await whyNotFunded(
      record.vault, await authorityOf(record.vault), committee, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: `${unvouched.why} Where the cause is that a signer joined or left, or the threshold changed, since `
          + 'the vault was handed over, the signers who hold it now sign the change in Settings, and payments out of '
          + 'it are paid for again once the chain shows it.',
      });
      return;
    }
    const sent = await send(res, account.id, 'a private payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPayout(tx, { vault: record.vault, account: company.address }));
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
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const unvouched = await whyNotFunded(
      record.vault, await authorityOf(record.vault), committee, company.address, undefined, undefined,
      'this service pays no fee for a payment out of this vault');
    if (unvouched !== null) {
      res.status(409).json({
        nothingWasSent: true,
        error: `${unvouched.why} Where the cause is that a signer joined or left, or the threshold changed, since `
          + 'the vault was handed over, the signers who hold it now sign the change in Settings, and payments out of '
          + 'it are paid for again once the chain shows it.',
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
   * which key is whose; the device names each seat's holder from the sealed
   * roster it opens, and says which seat is its own from its own wallet.
   */
  const NO_HOLDERS: ReadonlyMap<string, string> = new Map();

  /*
   * **A HANDOVER SENT AND NOT YET SHOWN BY THE CHAIN IS NOT SENT AGAIN.** Every
   * copy would be built against the same counter, and the chain charges the fee
   * for each one it then refuses. Kept for as long as the handover could still
   * land, and in this process only: a restart forgets it, and the chain's own
   * counter still refuses a second one that arrives after the first landed.
   */
  const handoversSent = new Map<string, number>();
  /*
   * **NOT WHILE ONE SIGNER COULD ACT ALONE AND ANOTHER COULD LEAVE.** A signer removed from the company keeps their
   * seat on every contract until the committee on it is changed, and at a threshold of one that one person could
   * sign a change to the rules every vault of the company pays out by before the others do.
   */
  const whyNotYet = (to: Committee): string | null => {
    const alone = whyOneKeyCouldActAlone(to);
    return alone === null ? null : `this company's committee is not installed: ${alone}. Nothing was sent.`;
  };
  const HANDOVER_LIFETIME_MS = 30 * 60_000;
  const handoverStillPending = (accountId: string): boolean => {
    const at = handoversSent.get(accountId);
    return at !== undefined && now().getTime() - at < HANDOVER_LIFETIME_MS;
  };

  /**
   * **WHETHER A COMMITTEE CHANGE IS OFFERED ON THE SETTINGS SCREEN, AND THE
   * SENTENCE BESIDE IT**, from the same list the change itself is built from,
   * so the screen never offers what the change route would refuse or hides what
   * it would build. A born-held contract still held by its founding signer's
   * one key is behind like any other once a second signer is seated.
   */
  const changeOffered = (committee: Committee | null, owed: readonly ContractOwingAChange[]) => {
    if (committee === null) {
      return { possible: false, why: 'This company has no complete committee yet, so there is nothing to change its contracts to.' };
    }
    const accountBehind = owed.some((c) => c.contract === 'account');
    const vaultsBehind = owed.filter((c) => c.contract === 'vault').length;
    const named = [
      accountBehind ? 'the company account' : '',
      vaultsBehind > 0 ? `${vaultsBehind} vault${vaultsBehind === 1 ? '' : 's'}` : '',
    ].filter((x) => x !== '').join(' and ');
    if (owed.length === 0) {
      return {
        possible: false,
        why: 'No change is waiting. Every contract listed above that could be read is held by the company\'s '
          + 'committee as it stands now.',
      };
    }
    const alone = whyOneKeyCouldActAlone(committee);
    if (alone !== null) {
      return { possible: false, why: `${named.charAt(0).toUpperCase()}${named.slice(1)} cannot be changed yet: ${alone}.` };
    }
    return {
      possible: true,
      why: `${named.charAt(0).toUpperCase()}${named.slice(1)} ${owed.length === 1 ? 'is' : 'are'} still held by the `
        + 'committee from before the company\'s signers or threshold changed. '
        + (accountBehind
          ? 'Until the company account is changed, no money goes into or out of any vault. '
          : 'Until a vault is changed, no money goes into or out of that vault. ')
        + 'Anyone who has left keeps their seat until then. The signers who hold each one now sign the change in '
        + 'their own wallets. Once enough have signed, it is sent.',
    };
  };

  r.get('/api/accounts/:id/authority', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    const serviceKey = deps.account.temporaryKey ?? null;
    const contracts: ContractAuthorityView[] = [];
    if (company !== null) {
      contracts.push(authorityView('account', await authorityOf(company.address), committee, NO_HOLDERS, serviceKey));
      for (const v of deps.store.listCompanyVaults(account.id)) {
        contracts.push(authorityView('vault', await authorityOf(v.vault), committee, NO_HOLDERS, serviceKey));
      }
    }
    const accountRow = contracts[0];
    /* An account born held was never held by anybody else, so it has nothing to hand over; it is changed instead. */
    const born = company !== null && accountBornHeld(account.id, company.address);
    const handover = company === null || committee === null
      ? { possible: false, why: why ?? 'this company has no committee yet.' }
      : born
        ? { possible: false, why: 'the company\'s account was created held by its committee, so there is nothing to hand over.' }
      : accountRow?.heldByTheCompany
        ? { possible: false, why: 'the company\'s account is already held by its committee.' }
        : accountRow?.read === 'read' && accountRow.shape === 'one-key' && accountRow.changes === '0'
          ? !deps.account.handover
            ? { possible: false, why: 'this deployment keeps no temporary key for company accounts, so it cannot hand one over.' }
            : whyNotYet(committee) !== null
              ? { possible: false, why: whyNotYet(committee) }
            : handoverStillPending(account.id)
              ? { possible: false, why: 'the handover was sent and the chain has not shown it yet. Wait for it before sending another.' }
              : { possible: true, why: null }
          : { possible: false, why: accountRow?.why ?? 'the chain could not be asked who holds this company\'s account.' };
    res.json({
      company: company === null ? null : {
        address: company.address, label: account.companyLabel ?? null,
        threshold: company.threshold, signerCount: account.signerCount,
      },
      committee,
      why,
      everySignerNeeded: company === null ? null : everySignerNeeded(account.signerCount, company.threshold),
      contracts,
      handover: {
        ...handover,
        /* Said beside the button, because a handover cannot be undone from this screen. */
        permanent: 'Once handed over, the account is held by the company\'s committee as it stands now. When a '
          + 'signer joins or leaves, or the threshold changes, the account and every vault must be changed to match. '
          + 'Enough of the signers who hold each one now sign that change in their own wallets. Until the account is '
          + 'changed, no money goes into or out of any vault; until a vault is changed, none goes into or out of that '
          + 'vault. A signer who has left keeps their seat until then, so with '
          + `${Math.max(0, (company?.threshold ?? 1) - 1)} of the signers who stay they could change the rules every `
          + 'vault pays out by.',
      },
      /*
       * A change is a replacement signed by the committee that holds the
       * contract now, each signature made in its holder's wallet. It is offered
       * whenever a contract born held carries a committee that is not the
       * company's, from the same list the change route builds from.
       */
      change: changeOffered(
        company === null ? null : committee,
        company === null || committee === null ? [] : contractsOwingAChange(await companyContracts(account, company.address), committee).owed),
    });
  });

  r.post('/api/accounts/:id/authority/handover', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why} Nothing was sent.` });
      return;
    }
    const build = deps.account.handover;
    if (build === undefined) {
      res.status(503).json({
        nothingWasSent: true,
        error: 'this deployment keeps no temporary key for company accounts, so it cannot hand this one over. Nothing was sent.',
      });
      return;
    }
    const alone = whyNotYet(committee);
    if (alone !== null) {
      res.status(409).json({ nothingWasSent: true, error: alone });
      return;
    }
    /* The committee the pressing device checked, and nothing else, is the one installed. */
    const checked = z.object({
      committee: z.object({
        committee: z.array(z.object({ tag: z.string(), value: z.string() })),
        threshold: z.number(),
      }),
    }).safeParse(req.body);
    if (!checked.success || !sameCommittee(checked.data.committee, committee)) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'the committee your device checked is not the one this service would install now, so nothing was '
          + 'built. Nothing was sent; read the settings again and check it again.',
      });
      return;
    }
    if (handoverStillPending(account.id)) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'the handover was sent and the chain has not shown it yet, and a second copy would be refused after '
          + 'its fee was paid. Nothing was sent; wait for the first.',
      });
      return;
    }
    /* Held from here, before the first wait, so a second press arriving meanwhile is refused rather than paid. */
    handoversSent.set(account.id, now().getTime());
    const release = () => { handoversSent.delete(account.id); };
    const read = await authorityOf(company.address);
    if (read.state !== 'read') {
      release();
      res.status(503).json({ nothingWasSent: true, error: `the chain could not be asked who holds this company's account (${read.why}). Nothing was sent.` });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await build({ read, to: committee, strictestBar: strictestBarOf(company, null) });
    } catch (e) {
      release();
      res.status(409).json({ nothingWasSent: true, error: (e as Error)?.message ?? String(e) });
      return;
    }
    /* The service built it, and still reads it as if a stranger had: what is paid for is what is checked. */
    const sent = await send(res, account.id, 'handing the company account to its committee', 'proven-moving-nothing', bytes,
      (tx) => refusalForHandover(tx, { vault: company.address, to: committee, onChain: read.authority, contract: 'account' }));
    /* Only a refusal that says nothing was sent frees the account for another press; one that may have landed does not. */
    if (sent === null && res.statusCode !== 502) release();
    if (sent === null) return;
    res.json({ txRef: sent.ref, state: 'handover-sent' });
  });

  /* ---- a committee changed after a signer joins or leaves ---- */

  /*
   * **WHICH CONTRACTS STILL CARRY A COMMITTEE THAT IS NOT THE COMPANY'S NOW.**
   * Read from the chain each time: the committee that holds each contract, the
   * counter a change is signed against, and the seats that have already signed
   * the change to the company's committee as it stands now. Signatures kept for
   * a counter the chain has moved past, or for a committee that is no longer
   * the company's, are not reported: they can never be used.
   */
  const collectedFor = (address: string, counter: bigint, to: Committee): CollectedCommitteeSignatures | null => {
    const kept = deps.store.getCommitteeSignatures(address);
    return kept !== null && kept.counter === counter.toString() && sameCommittee(kept.to, to) ? kept : null;
  };

  const companyContracts = async (account: SealedAccount, companyAddress: Hex) => {
    const out: { contract: 'account' | 'vault'; read: AuthorityRead; bornHeld: boolean }[] = [
      { contract: 'account', read: await authorityOf(companyAddress), bornHeld: accountBornHeld(account.id, companyAddress) },
    ];
    for (const v of deps.store.listCompanyVaults(account.id)) {
      out.push({ contract: 'vault', read: await authorityOf(v.vault), bornHeld: v.bornHeld === true });
    }
    return out;
  };

  r.get('/api/accounts/:id/committee-change', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.json({
        company: company?.address ?? null, label: account.companyLabel ?? null,
        to: null, why: why ?? 'this company has no committee yet.', contracts: [], notChangeable: [],
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
        signedSeats: [...(collectedFor(c.address, c.counter, committee)?.signatures ?? [])].map((x) => x.seat).sort((a, b) => a - b),
        required: c.now.threshold,
      })),
      notChangeable,
    });
  });

  /*
   * **ONE CHANGE SENT PER CONTRACT AT A TIME.** Every copy would be signed
   * against the same counter, and the chain charges the fee for each one it
   * then refuses. Kept in this process only, for as long as the change could
   * still land.
   */
  const changesSent = new Map<string, number>();
  const changeStillPending = (key: string): boolean => {
    const at = changesSent.get(key);
    return at !== undefined && now().getTime() - at < HANDOVER_LIFETIME_MS;
  };
  /*
   * **ONE REQUEST AT A TIME PER CONTRACT.** Two signers whose signatures each
   * complete the change, arriving together, would otherwise both put it
   * together and both send it, and the chain charges the fee for the second
   * and refuses it; and each would write back the signatures it read, so one
   * signature could be lost. In this process only: a second process or a
   * restart does not see it.
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
   * **A SIGNER'S SIGNATURES ON THE CHANGE, AS THEIR WALLET MADE THEM.** Each
   * contract's change is rebuilt here from the chain and the company's
   * committee, never taken from the request; each signature is checked against
   * the seat it names on the committee holding the contract now, and kept; and
   * once enough have signed, the change is sent. This service signs nothing.
   */
  r.post('/api/accounts/:id/committee-change/signatures', ...guard, async (req, res) => {
    const KEY = z.object({ tag: z.string().min(1), value: z.string().regex(/^[0-9a-f]+$/u) }).strict();
    const body = z.object({
      to: z.object({ committee: z.array(KEY), threshold: z.number().int() }).strict(),
      signatures: z.array(z.object({
        address: z.string().regex(HEX64),
        counter: z.string().regex(/^[0-9]+$/u),
        seat: z.number().int().min(0),
        signature: KEY,
      }).strict()).min(1).max(64),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'these are not signatures on a change to this company\'s committee. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const { company, committee, why } = await committeeNow(account);
    if (company === null || committee === null) {
      res.status(409).json({ nothingWasSent: true, error: `${why ?? 'this company has no committee yet.'} Nothing was sent.` });
      return;
    }
    if (!sameCommittee(body.data.to, committee)) {
      res.status(409).json({
        nothingWasSent: true,
        error: 'these signatures are on a committee that is not this company\'s as it stands now, so they were not kept. '
          + 'Nothing was sent. Reload this page and sign again.',
      });
      return;
    }
    const assemble = deps.committeeChange;
    if (assemble === undefined) {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send transactions, so nothing was sent.' });
      return;
    }
    const results: Array<Record<string, unknown>> = [];
    const byAddress = new Map<string, typeof body.data.signatures>();
    for (const sig of body.data.signatures) byAddress.set(sig.address, [...(byAddress.get(sig.address) ?? []), sig]);
    for (const [address, given] of byAddress) {
      await oneAtATime(fold(address), async () => {
        const isAccount = fold(address) === fold(company.address);
        const vault = isAccount ? null : deps.store.getCompanyVault(address);
        if (!isAccount && (vault === null || vault.accountId !== account.id)) {
          results.push({ address, state: 'refused', nothingWasSent: true, error: 'this company has no contract at that address.' });
          return;
        }
        const contract: 'account' | 'vault' = isAccount ? 'account' : 'vault';
        const label = isAccount ? 'the company\'s account' : `vault ${address}`;
        /* Refused before any signature is kept: a change to a contract not born held is never sent. */
        if (!(isAccount ? accountBornHeld(account.id, company.address) : vault?.bornHeld === true)) {
          results.push({
            address, state: 'refused', nothingWasSent: true,
            error: `${label} was not created here held by the company's committee, so a change to its committee is not `
              + 'sent. Nothing was sent.',
          });
          return;
        }
        const read = await authorityOf(address as Hex);
        if (read.state !== 'read') {
          results.push({ address, state: 'refused', nothingWasSent: true, error: `the chain could not be asked who holds ${label} (${read.why}). Nothing was sent.` });
          return;
        }
        if (given.some((g) => g.counter !== read.authority.counter.toString())) {
          results.push({
            address, state: 'refused', nothingWasSent: true,
            error: `${label} has been changed since these signatures were made, so they no longer count. Nothing was sent. Sign again.`,
          });
          return;
        }
        const key = `${fold(address)}:${read.authority.counter}`;
        if (changeStillPending(key)) {
          results.push({ address, state: 'sent', note: 'the change was sent and the chain has not shown it yet.' });
          return;
        }
        const kept = collectedFor(address, read.authority.counter, committee)?.signatures ?? [];
        const merged = [...kept.filter((k) => !given.some((g) => g.seat === k.seat)), ...given.map((g) => ({ seat: g.seat, signature: g.signature }))];
        let assembled: Awaited<ReturnType<NonNullable<CompanyVaultDeps['committeeChange']>>>;
        try {
          assembled = await assemble({
            read, to: committee, strictestBar: strictestBarOf(company, isAccount ? null : address), signatures: merged, label,
          });
        } catch (e) {
          results.push({ address, state: 'refused', nothingWasSent: true, error: `${(e as Error)?.message ?? String(e)} Nothing was sent.` });
          return;
        }
        deps.store.putCommitteeSignatures({
          accountId: account.id, address: fold(address), counter: read.authority.counter.toString(),
          to: { committee: committee.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: committee.threshold },
          signatures: merged.map((m) => ({ seat: m.seat, signature: { tag: m.signature.tag, value: m.signature.value } })),
      });
      if (assembled.proven === null) {
        results.push({ address, state: 'waiting', have: assembled.have, required: assembled.required, seatsSigned: assembled.seatsSigned });
        return;
      }
      if (typeof deps.ledger.sendVault !== 'function') {
        results.push({ address, state: 'refused', nothingWasSent: true, error: 'this deployment does not send transactions, so nothing was sent.' });
        return;
      }
      changesSent.set(key, now().getTime());
      try {
        const sent = await deps.ledger.sendVault(account.id, `changing ${label}'s committee to the company's`,
          'proven-moving-nothing', assembled.proven,
          (tx) => refusalForCommitteeChange(tx, {
            address, to: committee, onChain: read.authority, contract,
            bornHeld: isAccount ? accountBornHeld(account.id, company.address) : vault?.bornHeld === true,
          }),
          deps.readers.proven);
        results.push({ address, state: 'sent', txRef: sent.ref, have: assembled.have, required: assembled.required });
      } catch (e) {
        const nothing = saysNothingWasSent(e);
        /* Only a refusal that says nothing was sent frees the contract for another send; one that may have landed does not. */
        if (nothing) changesSent.delete(key);
        results.push({ address, state: 'refused', nothingWasSent: nothing, error: (e as Error)?.message ?? String(e) });
      }
      });
    }
    res.json({ results });
  });

  return r;
}
