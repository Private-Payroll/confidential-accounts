/**
 * **A PAYMENT OUT OF A VAULT, AND A MERGE OF ITS NOTES, BEHIND THE GATE.** A
 * private payment, a public payment and a merge, each sent only out of a vault
 * this service can vouch for, read from the chain now.
 */
import express from 'express';
import { refusalForMerge, refusalForPayout, refusalForPublicPayout } from '../wiring/vault-submission.js';
import type { CompanyVaultReads } from './company-vault-reads-and-sends.js';

/** The routes that send a payment out of a vault or a merge of its notes. */
export function vaultPaymentOutRoutes(r: express.Router, reads: CompanyVaultReads): void {
  const { guard, theVault, fundable, txFrom, send } = reads;

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
    /*
     * **THE SAME GATE, ASKED IN THIS DOOR'S OWN WORDS.** A person paying money
     * out is told why this payment is not paid for, never about money going in.
     */
    const gated = await fundable(req, res, record,
      'this service pays no fee for a payment out of this vault');
    if (gated === null) return;
    const { account, company } = gated;
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
    const gated = await fundable(req, res, record,
      'this service pays no fee for a merge of this vault\'s notes');
    if (gated === null) return;
    const { account } = gated;
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
    const gated = await fundable(req, res, record,
      'this service pays no fee for a payment out of this vault');
    if (gated === null) return;
    const { account, company } = gated;
    const sent = await send(res, account.id, 'a public payment out of a vault', 'proven-moving-the-vaults-own-coins', bytes,
      (tx) => refusalForPublicPayout(tx, { vault: record.vault, account: company.address }));
    if (sent === null) return;
    res.json({ txRef: sent.ref, transactionHash: sent.transactionHash });
  });
}
