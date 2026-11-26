/**
 * **WHAT A DEVICE BUILDS A CALL ON, READ FROM THE CHAIN.** The block a payment
 * out is built on, the account as one block holds it for a raise or an
 * approval, what one transaction created, and which of a vault's transactions
 * created one output. Public state only; nothing that opens a note.
 */
import express from 'express';
import type { Hex } from '../core/crypto.js';
import { HEX64, fold, type CompanyVaultReads } from './company-vault-reads-and-sends.js';

/** The routes that answer what the chain holds for a call to be built on. */
export function callStateRoutes(r: express.Router, reads: CompanyVaultReads): void {
  const { deps, guard, accountOf, theVault } = reads;

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
}
