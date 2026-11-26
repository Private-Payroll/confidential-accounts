/**
 * **ONLY THE NETWORK FEE, ADDED TO ONE CALL A DEVICE PROVED.** The call is
 * handed back finished for the company's own service or the person's wallet to
 * submit, and whoever was handed it says when it is done with it.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { VaultTxArrival } from '../core/ledger.js';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount } from '../core/types.js';
import { feeAnswerCodeOf } from '../midnight/sponsor.js';
import { refusalForProven, refusalUnlessOnlyACallTo } from '../wiring/proven-submission.js';
import { movesNothing, vaultCallRefusal } from '../wiring/vault-call-checks.js';
import { isListedRegistry, REGISTRY_PUT, registryPutRefusal } from '../wiring/registry-call-checks.js';
import { HEX64, VAULT_TX_LIMIT, fold, personOf, toBase64, type CompanyVaultReads } from './company-vault-reads-and-sends.js';
import type { vaultStartRoutes } from './vault-start-routes.js';

/** How long a call handed back with only its fee holds its company's and its member's turn, unless said done sooner. */
export const HANDED_BACK_HELD_MS = 4 * 60_000;

/** The registry writes our sponsorship pays for per seat the company's account holds, each day. */
export const REGISTRY_PUTS_A_SEAT = 2;

/** The kinds of call the fee route pays for. */
const FEE_KINDS = ['account-call', 'registry-put', 'vault-secret', 'vault-copy', 'vault-retire', 'vault-forget', 'payout', 'merge', 'public-payout'] as const;
type FeeKind = (typeof FEE_KINDS)[number];

/** The fee route and its done route. */
export function feeRoutes(
  r: express.Router, reads: CompanyVaultReads, startStepMayGo: ReturnType<typeof vaultStartRoutes>['startStepMayGo'],
): void {
  const { deps, now, guard, accountOf, NO_COMPANY, whyNotFunded } = reads;

  /*
   * **A REFUSAL BY THE CALL'S OWN CHECKS IS MARKED `callRefused`, AND IS FINAL**: this call must not go, whoever pays
   * for it, so a wallet offers no other way to pay. A refusal to pay (busy, out of DUST, over the registry's bound, a
   * person who is not a member, a deployment that pays nothing) is not marked, and a wallet may offer the person's own
   * DUST for it.
   */
  const callRefused = (res: express.Response, status: number, error: string): null => {
    res.status(status).json({ nothingWasSent: true, callRefused: true, error });
    return null;
  };

  /* Why a registry call named this way is not one this service pays for, read before its transaction is. */
  const registryCallRefusal = (contract: string, circuit: string): string | null => {
    if (!isListedRegistry(deps.registries, contract)) {
      return 'this call is not to a registry this network lists, and only the company\'s own calls and a registry\'s write are paid for. Nothing was sent.';
    }
    return circuit === REGISTRY_PUT ? null : `a registry's only call paid for is its "${REGISTRY_PUT}". Nothing was sent.`;
  };

  /*
   * **WHAT THE CALL IS HELD TO, BY ITS KIND**, or null with the refusal sent, marked as the call's own: one `put` to a
   * registry the network lists; one call to the company's own account; or one call to a vault of this company's, a
   * first secret or sealed copy only when its start route would send it, and a payment out only of a vault this service
   * can vouch for.
   */
  const callFor = async (
    res: express.Response, asked: { readonly kind: FeeKind; readonly contract: string; readonly circuit: string },
    account: SealedAccount, company: { readonly address: Hex },
  ): Promise<{ readonly check: (tx: unknown) => string | null; readonly arrival: VaultTxArrival } | null> => {
    const { kind, contract, circuit } = asked;
    if (kind === 'registry-put') {
      const refused = registryCallRefusal(contract, circuit);
      if (refused !== null) return callRefused(res, 409, refused);
      return { check: (tx) => registryPutRefusal(tx, contract), arrival: 'proven-moving-nothing' };
    }
    if (kind === 'account-call') {
      if (contract !== fold(company.address)) {
        return callRefused(res, 409, 'this call is not to this company\'s account, and only the company\'s own calls are paid for. Nothing was sent.');
      }
      return { check: (tx) => refusalForProven(tx, company.address) ?? refusalUnlessOnlyACallTo(tx, circuit), arrival: 'proven-moving-nothing' };
    }
    const record = HEX64.test(contract) ? deps.store.getCompanyVault(contract) : null;
    if (!record || record.accountId !== account.id) return callRefused(res, 404, 'this company has no vault at that address. Nothing was sent.');
    if ((kind === 'vault-secret' || kind === 'vault-copy') && !await startStepMayGo(record, account, kind, res, { callRefused: true })) return null;
    if (kind === 'payout' || kind === 'merge' || kind === 'public-payout') {
      const unvouched = await whyNotFunded(record.vault, company.address, undefined, undefined,
        'this service pays no fee for a payment out of this vault');
      if (unvouched !== null) return callRefused(res, 409, unvouched.why);
    }
    const vault = record.vault;
    return {
      check: (tx) => vaultCallRefusal(kind, tx, { vault, account: company.address }),
      arrival: movesNothing(kind) ? 'proven-moving-nothing' : 'proven-moving-the-vaults-own-coins',
    };
  };

  /*
   * **HOW MANY REGISTRY WRITES OUR SPONSORSHIP PAYS FOR, PER COMPANY AND DAY**: twice the seats the chain holds on the
   * company's account, each seat needing one entry. Counted in this process only, by the day in UTC; past it the fee
   * is refused as a payment, so the person may still pay it from their own DUST.
   */
  const registryPaid = new Map<string, { readonly day: string; readonly paid: number }>();
  const dayOf = (): string => now().toISOString().slice(0, 10);
  const registryPutsLeft = (accountId: string, seats: number): boolean => {
    const kept = registryPaid.get(accountId);
    return kept === undefined || kept.day !== dayOf() || kept.paid < REGISTRY_PUTS_A_SEAT * Math.max(1, seats);
  };
  const registryPutPaid = (accountId: string): void => {
    const kept = registryPaid.get(accountId);
    registryPaid.set(accountId, { day: dayOf(), paid: kept === undefined || kept.day !== dayOf() ? 1 : kept.paid + 1 });
  };

  /*
   * The calls handed back with only their fee, by name: one at a time per company and per member, held until
   * whoever was handed it says it is done, or for as long as it could still be submitted.
   */
  const handedBack = new Map<string, { company: string; member: string; expires: number; done: () => Promise<void> }>();

  /*
   * **ONLY THE NETWORK FEE, ADDED TO ONE CALL A SEAT'S DEVICE PROVED, AND
   * HANDED BACK FINISHED** for whoever submits it: the company's own service,
   * or the person's wallet straight to the chain. This service pays only for a
   * call of this company's, or a private registry's write, each held to what
   * `callFor` names for its kind, the same a route that sends it holds it to;
   * the contract checks that the seat that proved it may make it. Nothing is
   * submitted here, so every refusal says nothing was sent; the fee payer's
   * booking is settled by what the chain later shows. One call at a time is
   * held per company and per member, until the member says done
   * (`/fee/done`) or it could no longer be submitted; a second is answered as
   * sponsorship unavailable, never held up behind it.
   */
  r.post('/api/accounts/:id/fee', ...guard, async (req, res) => {
    const body = z.object({
      tx: z.string().min(1).max(VAULT_TX_LIMIT),
      kind: z.enum(FEE_KINDS),
      contract: z.string().min(1).max(130),
      circuit: z.string().min(1).max(128),
    }).strict().safeParse(req.body);
    if (!body.success) {
      callRefused(res, 400, 'this is not one call to pay the fee for: a transaction, its kind, its contract and its circuit. Nothing was sent.');
      return;
    }
    if (typeof deps.ledger.feeAddedTo !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment pays no fees, so no fee was added. Nothing was sent.' });
      return;
    }
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      callRefused(res, 409, `${NO_COMPANY} Nothing was sent.`);
      return;
    }
    const call = await callFor(res, { kind: body.data.kind, contract: fold(body.data.contract), circuit: body.data.circuit }, account, company);
    if (call === null) return;
    const registry = body.data.kind === 'registry-put';
    if (registry && !registryPutsLeft(account.id, company.seats)) {
      res.status(429).json({
        nothingWasSent: true,
        error: 'fee sponsorship has paid for as many registry entries for this company today as its seats need. Nothing was sent.',
      });
      return;
    }
    const member = personOf(req);
    const busy = [...handedBack.values()].find((h) => h.expires > now().getTime() && (h.company === account.id || h.member === member));
    if (busy !== undefined) {
      res.status(503).json({
        nothingWasSent: true,
        error: `fee sponsorship is already holding a call handed back ${busy.member === member ? 'to you' : 'for this company'}, and holds one at a time. `
          + 'Nothing was sent. Send this once that call has gone.',
      });
      return;
    }
    /* Whether the call's own check refused it, as the fee payer read it: such a refusal is the call's, and final. */
    let checkRefused = false;
    const check = (tx: unknown): string | null => {
      const refused = call.check(tx);
      if (refused !== null) checkRefused = true;
      return refused;
    };
    const handle = randomUUID();
    handedBack.set(handle, { company: account.id, member, expires: now().getTime() + HANDED_BACK_HELD_MS, done: async () => undefined });
    try {
      const added = await deps.ledger.feeAddedTo(account.id, 'a call whose fee alone is paid here', call.arrival,
        new Uint8Array(Buffer.from(body.data.tx, 'base64')), check, deps.readers.proven);
      handedBack.set(handle, { company: account.id, member, expires: now().getTime() + HANDED_BACK_HELD_MS, done: added.done ?? (async () => undefined) });
      if (registry) registryPutPaid(account.id);
      res.json({ tx: toBase64(added.tx), transactionHash: added.transactionHash, booking: handle });
    } catch (e: unknown) {
      handedBack.delete(handle);
      const code = feeAnswerCodeOf(e);
      res.status(422).json({
        nothingWasSent: true, ...(checkRefused ? { callRefused: true } : {}), error: (e as { message?: string })?.message ?? 'unknown error', ...(code ? { code } : {}),
      });
    }
  });

  /*
   * **WHOEVER WAS HANDED A CALL SAYS IT IS DONE WITH IT**, submitted or not, which frees its company's and its
   * member's turn. Nothing is released: the call may still land, and its DUST waits for the chain.
   */
  r.post('/api/accounts/:id/fee/done', ...guard, async (req, res) => {
    const booking = (req.body as { booking?: unknown } | null)?.booking;
    const held = typeof booking === 'string' ? handedBack.get(booking) : undefined;
    if (held === undefined || held.company !== String(req.params.id) || held.member !== personOf(req)) {
      res.json({ done: false });
      return;
    }
    handedBack.delete(booking as string);
    await held.done().catch(() => {
      /* a booking not told done is settled by what the chain shows or its deadline (`feeAddedTo`) */
    });
    res.json({ done: true });
  });
}
