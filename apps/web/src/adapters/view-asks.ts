/*
 * THE NAMES THIS PAGE ASKS A COMPANY'S VIEW BY: each of the company's lists, and the stores and kinds of the records
 * a read proves. Sent and compared, never shown.
 */

import type { CompanyRecordKind } from '../../../../src/midnight/sealed-record-wire.js';
import type { ListKind } from 'vaults-web-shared/records-source.js';

/** The company's lists, each read whole. */
export const LIST = { runs: 'runs', proposals: 'proposals', invites: 'invites', vaults: 'vaults', vaultKeyOffers: 'vault-key-offers' } as const satisfies Readonly<Record<string, ListKind>>;

/** The stores and kinds of the records every page of a company proves. */
export const PROVEN = { company: 'company', roster: 'roster', grants: 'grants', person: 'person', vendor: 'vendor' } as const satisfies Readonly<Record<string, CompanyRecordKind | 'company'>>;
