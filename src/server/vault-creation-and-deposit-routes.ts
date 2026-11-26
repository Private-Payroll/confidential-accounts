/**
 * **A VAULT CREATED, HANDED OVER, READ AND PAID INTO.** The committee and the
 * readers a new vault is made for, the company's vaults and where each stands,
 * a vault's deploy and its handover to the company's committee, what the chain
 * holds for one vault, and a private or public deposit behind the gate.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import { publicHoldingsOf, PublicBalanceUnreadable } from '../midnight/public-balance.js';
import {
  readVaultDeploy, refusalForDeposit, refusalForHandover, refusalForPublicDeposit, type ContractAnswer,
} from '../wiring/vault-submission.js';
import { VAULT_TX_LIMIT, toBase64, vaultState, type AccountNotReady, type CompanyVaultReads } from './company-vault-reads-and-sends.js';

/** The routes that create, hand over, read and pay into a company's vaults. */
export function vaultCreationAndDepositRoutes(r: express.Router, reads: CompanyVaultReads): void {
  const {
    deps, now, guard, accountOf, NO_COMPANY, accountCommittee, theVault, authorityOf, accountFactsOf, whyNotFunded, fundable, txFrom,
    send,
  } = reads;

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
       * company's account on the chain. The deploy's bytes are not kept: nothing reads them, and the chain holds the vault. */
      deps.store.putCompanyVault({
        accountId: account.id, vault, deployedAt: now().toISOString(),
        deployRef: sent?.ref ?? 'unknown', intended: { committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold },
        bornHeld: true,
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
      started,
    });
  });

  r.post('/api/accounts/:id/vaults/:vault/deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const bytes = txFrom(req, res);
    if (bytes === null) return;
    const gated = await fundable(req, res, record);
    if (gated === null) return;
    const { account } = gated;
    const sent = await send(res, account.id, 'a deposit into a vault', 'finished-by-the-depositor', bytes,
      (tx) => refusalForDeposit(tx, { vault: record.vault }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });

  /*
   * **A PUBLIC DEPOSIT, BEHIND THE SAME GATE AS A PRIVATE ONE.** The page hands
   * over the transaction and nothing else, and a body that carries anything
   * more is refused: the token and the amount are read from the transaction,
   * which is refused unless it puts exactly one public token, a positive amount
   * of it, into this vault, paid for by the depositor's own public money.
   */
  r.post('/api/accounts/:id/vaults/:vault/public-deposit', ...guard, async (req, res) => {
    const record = theVault(req, res);
    if (record === null) return;
    const asked = z.object({ tx: z.string().min(1).max(VAULT_TX_LIMIT) }).strict().safeParse(req.body);
    if (!asked.success) {
      res.status(400).json({
        nothingWasSent: true,
        error: 'this request does not carry the public deposit\'s transaction and nothing else. Nothing was sent and no '
          + 'money moved. Reload the page and try again; if it happens again, the service needs attention.',
      });
      return;
    }
    const bytes = new Uint8Array(Buffer.from(asked.data.tx, 'base64'));
    const gated = await fundable(req, res, record);
    if (gated === null) return;
    const { account } = gated;
    const sent = await send(res, account.id, 'a public deposit into a vault', 'finished-by-the-depositor', bytes,
      async (tx) => refusalForPublicDeposit(tx, {
        vault: record.vault,
        addressOf: (await import('@midnightntwrk/ledger-v9')).addressFromKey as (owner: unknown) => string,
      }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });
}
