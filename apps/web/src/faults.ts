/*
 * A MISTAKE IN THIS APPLICATION'S OWN CODE, never something the person did:
 * a screen shown where what it needs was not provided, or a shared step that
 * answered in a way it promises it never does. Each carries a code a person
 * can read out from the browser's console and report; the code names the
 * place, and is not wording.
 */
export const FAULT = {
  noSession: 'web-1-no-session',
  noVisitor: 'web-2-no-visitor',
  noCurrentPage: 'web-3-no-current-page',
  noRightPanel: 'web-4-no-right-panel',
  companyDidNotOpen: 'web-5-company-did-not-open',
  noValueForAddress: 'web-6-no-value-for-address',
  noScreenInModule: 'web-7-no-screen-in-module',
  noCompanyRecords: 'web-8-no-company-records',
  vaultCompanyDidNotOpen: 'web-9-vault-company-did-not-open',
  vaultPaymentsNotAsked: 'web-10-vault-payments-not-asked',
} as const;

export type FaultCode = (typeof FAULT)[keyof typeof FAULT];

/** Thrown for a mistake in the code. Its message is its code. */
export class Fault extends Error {
  readonly code: FaultCode;
  constructor(code: FaultCode) {
    super(code);
    this.code = code;
  }
}
