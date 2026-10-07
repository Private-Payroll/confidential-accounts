/**
 * **A COMPANY'S PAYROLL RUNS ON THE PRODUCT'S SERVER: DRAWN, SEALED AND SIGNED
 * ON A SIGNER'S DEVICE, AND KEPT HERE AS THEY ARE GIVEN.**
 *
 * A run names who is paid and how much, sealed under the company's viewing
 * key, and carries a payslip for each person sealed to their own payslip key.
 * The device that draws it seals it, mints nothing for anybody, and signs it
 * with its seat's filing key. This keeps it only for a seat the company's
 * directory believes may file a run (check S), opens none of it, and makes no
 * payslip and no key for anybody.
 */
import express from 'express';
import { z } from 'zod';
import type { SealedRun } from '../core/types.js';
import { runFilingRefusal, type SignedRunFiling } from '../core/run-filing.js';
import { FILING_REFUSAL } from '../midnight/seat-directory.js';
import type { WiringName } from '../core/provenance.js';
import { CHAIN_UNREAD, filerSeatNow, type DirectoryNow } from './seat-directory-route.js';

/** What this route needs of the store. */
export interface RunRouteStore {
  getAccount(accountId: string): { readonly keyEpoch: number } | null;
  getRun(id: string): SealedRun | null;
  putRun(r: SealedRun): void;
}

export const runRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: RunRouteStore;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
  readonly wiring: () => WiringName | null;
}): express.Router => {
  const router = express.Router();

  /*
   * **A RUN DRAWN ON A SIGNER'S DEVICE, KEPT.** Refused unless it is a run of
   * this company signed whole by the signed-in person's own seat, whose role
   * may file a run; sealed under the key the company uses now; a run this
   * company does not hold yet; and only drawn, with nothing raised from it.
   */
  router.post('/api/accounts/:id/runs', deps.signedIn, deps.member, express.json({ limit: '4mb' }), async (req, res) => {
    const b = z.object({ run: z.unknown() }).strict().safeParse(req.body ?? {});
    const company = String(req.params.id);
    if (!b.success) {
      res.status(400).json({ error: 'this is not a run to keep: a run is drawn, sealed and signed on a signer\'s own device. Nothing was kept.' });
      return;
    }
    const why = runFilingRefusal(company, b.data.run);
    if (why !== null) {
      res.status(422).json({ refused: 'not-a-run', error: `this is not a run this company can keep: ${why}. Nothing was kept.` });
      return;
    }
    const run = b.data.run as SignedRunFiling;
    let now: DirectoryNow;
    try {
      now = await deps.directoryOf(company);
    } catch (e) {
      res.status(503).json({ error: CHAIN_UNREAD(e) });
      return;
    }
    const seat = filerSeatNow(now, String((req as { userId?: unknown }).userId), run.filedBy.publicKey, 'run');
    if (typeof seat === 'string') {
      res.status(403).json({ refused: seat, error: `this run is not kept: ${FILING_REFUSAL[seat]}. Nothing was kept.` });
      return;
    }
    const account = deps.store.getAccount(company);
    if (account === null || run.keyEpoch !== account.keyEpoch) {
      res.status(409).json({ refused: 'not-the-current-key', error: 'this run is sealed under a key the company no longer uses. Reload the page and draw it again. Nothing was kept.' });
      return;
    }
    if (deps.store.getRun(run.id) !== null) {
      res.status(409).json({ refused: 'already-kept', error: 'a run by this name is already kept. Nothing was kept.' });
      return;
    }
    if (run.status !== 'draft' || (run.proposalIds ?? []).length > 0 || run.settledAt !== undefined) {
      res.status(422).json({ refused: 'not-a-drawn-run', error: 'a run is kept here as it is drawn, with nothing raised from it yet. Nothing was kept.' });
      return;
    }
    deps.store.putRun({ ...run, wiring: deps.wiring() });
    res.status(201).json({ run: { id: run.id } });
  });

  return router;
};
