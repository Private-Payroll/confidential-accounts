/**
 * **WHICH PAYSLIP PAGE IS ASKING, AND WHAT A PAGE OLDER THAN THIS SERVICE IS TOLD.**
 *
 * The payslip routes answer only a signed-in person. A page loaded before they
 * did sends its requests without the sign-in, and a bare "not signed in" would
 * send that person to a sign-in they have already done. So the page names
 * itself with a header, and a request that does not name the current page is
 * refused with a sentence saying what to do, before anything else is looked at.
 *
 * Imported by the page that sends the header and by the service that reads it,
 * so the two cannot disagree about the name or the value.
 */
export const PAYSLIP_PAGE_HEADER = 'x-payslip-page';

/** Raised whenever what the payslip routes require of a page changes. */
export const PAYSLIP_PAGE_VERSION = '1';

/** Shown, word for word, by a page older than this service. */
export const PAGE_OUT_OF_DATE = 'This page is out of date. Reload it and open your payslips again.';

/** Whether a request's header names the current page. */
export const isCurrentPayslipPage = (named: unknown): boolean => named === PAYSLIP_PAGE_VERSION;
