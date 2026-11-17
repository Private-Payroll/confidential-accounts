import type express from 'express';
import { z } from 'zod';
import type { RateLimiter } from '../core/rate-limit.js';
import type { PayrollService } from '../core/payroll.js';
import { PAGE_OUT_OF_DATE, PAYSLIP_PAGE_HEADER, isCurrentPayslipPage } from '../core/payslip-page.js';

/** What the payslip routes are built from: the attempt limiter, the payroll, and the server's sign-in gate and error wrapper. */
export interface PayslipRouteParts {
  readonly limiter: RateLimiter;
  readonly payroll: PayrollService;
  readonly authed: express.RequestHandler;
  readonly wrap: (fn: express.RequestHandler) => express.RequestHandler;
  readonly context: (req: express.Request) => { ip: string | null; userAgent: string | null };
}

/** Mounts the payslip routes on `app`. */
export function payslipRoutes(app: express.Express, parts: PayslipRouteParts): void {
  const { limiter, payroll, authed, wrap, context } = parts;
  /*
   * **A COMPANY'S PAYSLIPS FOR A MONTH, EVERY ONE, TO ANYBODY SIGNED IN.**
   *
   * No route here takes or names a payslip key. A slip is ciphertext wrapped to
   * one payee's key with nothing beside it that says whose it is, so the
   * service hands every slip of the company's month to any signed-in person and
   * the payee's own device tries each with its key. The service learns which
   * signed-in person asked about which company and month, and never which slip
   * opened, or for whom. Anyone signed in can see how many slips a company's
   * runs carry; that count is the number of people the run pays, which the
   * proposal shows on the chain.
   *
   * **WHAT THE SIGN-IN COSTS, SAID RATHER THAN LEFT TO BE FOUND.** Nothing here
   * writes down who asked: no route stores it, and the refusal log records a
   * request's method and address and no session. Which companies pay a person
   * is kept in that person's own saved keys, sealed under the key their wallet
   * releases, and this service cannot read it there.
   */
  /*
   * Metered by where the request comes from, on top of the sign-in. A caller with
   * no address is not counted, as on the offer route.
   */
  const payslipsMetered = async (req: express.Request, res: express.Response): Promise<boolean> => {
    const from = context(req).ip;
    if (!from) return true;
    const decision = await limiter.record('payslips', from);
    if (decision.allowed) return true;
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    res.status(429).json({
      error: `too many payslip requests from here. Try again in ${decision.retryAfterSeconds} seconds.`,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
    return false;
  };

  /*
   * **A PAGE OLDER THAN THESE ROUTES IS TOLD TO RELOAD, BEFORE ANYTHING ELSE.**
   * It sends no sign-in, and a bare "not signed in" would send somebody who is
   * signed in back to a sign-in. Checked ahead of the sign-in, and it answers
   * nothing but the refusal, so no route here answers without a sign-in.
   */
  const currentPayslipPage: express.RequestHandler = (req, res, next) => {
    if (isCurrentPayslipPage(req.headers[PAYSLIP_PAGE_HEADER])) { next(); return; }
    res.status(409).json({ code: 'payslip-page-out-of-date', error: PAGE_OUT_OF_DATE });
  };

  const companyLabel = z.string().regex(/^co_[0-9a-f]{64}$/u, 'a company is named by its label: co_ and 64 lower-case hex');

  /*
   * `POST /api/payslips/proof` AND `POST /api/payslips` STOOD HERE AND ARE GONE.
   * They took a payee's payslip key in the clear, proved it, and sent the slips
   * sealed to it, so the service learned whose slips were whose.
   */

  app.get('/api/payslips', currentPayslipPage, authed, wrap(async (req, res) => {
    if (!await payslipsMetered(req, res)) return;
    const company = companyLabel.parse(String(req.query.company ?? ''));
    const period = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/u, 'a month is written YYYY-MM')
      .parse(String(req.query.period ?? ''));
    res.json(payroll.payslipsOf(company, period));
  }));

  /*
   * `GET /api/payslips/paid` STOOD HERE AND IS GONE. It relayed a company's
   * completed payments, and nothing called it once the payslip page read the
   * company's contract itself, through the indexer the payee's wallet names.
   */

  /*
   * **A COMPANY'S LABEL, WITH THE ACCOUNT THAT CARRIES IT NOW.** A payee's wallet
   * is told which account to read the label back from before it gives the key
   * their slips open with. Labels and account addresses are public on the chain,
   * and this answers with nothing else, to a signed-in person only.
   */
  app.get('/api/payslips/addresses', currentPayslipPage, authed, wrap(async (req, res) => {
    if (!await payslipsMetered(req, res)) return;
    const company = companyLabel.parse(String(req.query.company ?? ''));
    res.json({ companies: payroll.payslipAddressesOf(company) });
  }));
}
