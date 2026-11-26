/**
 * **A VAULT'S START, PAID FOR STEP BY STEP.** Its adoption and its first secret
 * run on the company's account, its first secret and each sealed copy of it;
 * each step is held while it could still land. `startStepMayGo` is handed to
 * the fee route, which pays for a first secret or a sealed copy only when these
 * routes would send it.
 */
import express from 'express';
import { z } from 'zod';
import type { SealedAccount, CompanyVault } from '../core/types.js';
import { vaultStandingIsFunded } from '../../packages/web-shared/src/vault-standing.js';
import {
  refusalForSecretCopy, refusalForSetNonceSecret, refusalForStartAccountCall, vaultIsTheCompanys, type VaultStartingLedger,
} from '../wiring/vault-submission.js';
import { VAULT_TX_LIMIT, personOf, vaultState, type CompanyVaultReads } from './company-vault-reads-and-sends.js';

/** The routes of a vault's start, and the check the fee route asks before it pays for one of its steps. */
export function vaultStartRoutes(r: express.Router, reads: CompanyVaultReads) {
  const { deps, now, guard, accountOf, NO_COMPANY, theVault, whyNotFunded, txFrom, send, HANDOVER_LIFETIME_MS } = reads;

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
   * frees it, including the node's refusal before its pool, which the fee payer
   * answers as nothing sent. In this process only: the chain's own refusals
   * stand behind it.
   */
  const startSent = new Map<string, number>();
  /*
   * A vault's first secret, or a sealed copy of it, is paid for only when the start route would send it: the
   * vault is the company's and fundable from here, no secret is set yet (or the copies are not all written), and
   * no secret just sent is still on its way. Each refusal carries `marked` beside its words.
   */
  const startStepMayGo = async (
    record: CompanyVault, account: SealedAccount, kind: 'vault-secret' | 'vault-copy', res: express.Response, marked: Readonly<Record<string, unknown>> = {},
  ): Promise<boolean> => {
    if (await startableFor(record, account, res, marked) === null) return false;
    let start: VaultStartingLedger;
    try {
      start = deps.chain.startingLedgerOf(await deps.chain.contractState(record.vault));
    } catch (e) {
      res.status(503).json({ nothingWasSent: true, ...marked, error: `the chain could not be read for this vault (${(e as Error)?.message ?? e}). Nothing was sent.` });
      return false;
    }
    if (kind === 'vault-secret' && (!/^0+$/u.test(start.nonceCommitment) || startStillPending(`${record.vault}:secret`))) {
      res.status(409).json({ nothingWasSent: true, ...marked, error: 'this vault already holds a secret, or one is on its way, so a first one is not paid for again. Nothing was sent.' });
      return false;
    }
    if (kind === 'vault-copy' && start.started) {
      res.status(409).json({ nothingWasSent: true, ...marked, error: 'every sealed copy of this vault\'s secret is already written. Nothing was sent.' });
      return false;
    }
    return true;
  };
  const startStillPending = (key: string): boolean => {
    const at = startSent.get(key);
    return at !== undefined && now().getTime() - at < HANDOVER_LIFETIME_MS;
  };

  /** The vault and its company, for a vault that is the company's as the chain and the record show it now; or the refusal, sent. */
  const startable = async (req: express.Request, res: express.Response) => {
    const record = theVault(req, res);
    if (record === null) return null;
    return startableFor(record, accountOf(req), res);
  };
  const startableFor = async (record: CompanyVault, account: SealedAccount, res: express.Response, marked: Readonly<Record<string, unknown>> = {}) => {
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, ...marked, error: `${NO_COMPANY} Nothing was sent.` });
      return null;
    }
    const refused = await whyNotFunded(record.vault, company.address,
      undefined, undefined, 'this vault is not started from here', vaultIsTheCompanys);
    if (refused !== null && !vaultStandingIsFunded(vaultState(refused.vaultRead ?? { state: 'answered' }, refused))) {
      res.status(409).json({ nothingWasSent: true, ...marked, error: refused.why });
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

  return { startStepMayGo };
}
