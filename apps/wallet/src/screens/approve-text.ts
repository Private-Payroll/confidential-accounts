/*
 * The date format and the three text sizes the approval screens share.
 * A fact the browser saw for itself is never drawn smaller than a claim the asking page made about itself, so each size is named once here.
 */

export const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * **THE TWO SIZES, NAMED, BECAUSE THE RULE IS ABOUT SIZE.**
 *
 * The wallet was rendering a self-chosen name in its largest type
 * and the address the browser actually observed in its smallest, on a page
 * served from `payroll-b.example` calling itself *Payroll A*. **A claim shown
 * larger than the fact that checks it is a claim this interface has endorsed.**
 *
 * So the two are named here rather than typed at each call site: a FACT — the
 * observed origin, the company's fingerprint — is never smaller than a CLAIM,
 * which is anything the asking site chose to call itself. `unlock-screen.test`
 * ranks the tokens and fails if that inverts.
 */
export const FACT_TEXT = 'text-lg';

/** The fingerprint is the thing a person is asked to COMPARE, so it is
 * the largest thing in the section rather than an equal of the address it
 * stands for. */
export const FINGERPRINT_TEXT = 'text-xl';
export const CLAIM_TEXT = 'text-base';
