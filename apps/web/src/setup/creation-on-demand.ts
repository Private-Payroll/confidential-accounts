import type { CompanyCreation } from '../adapters/creation-standing.js';

/*
 * The creation adapter, loaded the first time a list of companies needs it and then shared, so the first page does
 * not carry the keyring.
 */
let creationAdapter: Promise<typeof import('../adapters/creation-standing.js')> | null = null;

/** Where a company's creation stands, read through the adapter when first asked. */
export const creationOfCompany = (id: string): Promise<CompanyCreation> =>
  (creationAdapter ??= import('../adapters/creation-standing.js')).then((m) => m.creationOf(id));
