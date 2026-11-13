import type { SuperAdminSignature } from 'vaults-web-shared/proposal-file.js';
import type { SuperAdminDoors } from 'vaults-web-shared/super-admin-change.js';
import { api, holdersFromTheWallet } from 'vaults-web-shared/keyring.js';
import { superAdminSigned, superAdminWallet, type SuperAdminCompany } from 'vaults-web-shared/super-admin-ask.js';
import type { KeptChange, SuperAdminService } from 'vaults-web-shared/super-admins-on-the-service.js';
import { companyRoute, SERVICE } from './handover-state.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * **A SUPER ADMIN'S DOORS ON THIS PAGE.** What the page reads of the chain here is for showing only: the wallet reads
 * the chain again itself before it signs anything, the service checks every signature against the chain before it
 * keeps or sends one, and the chain counts the signatures on each update. The chain's reads, each update's bytes and
 * every signature check are asked of the vault worker, the one place the runtime, the account's ledger and the ledger
 * load; none of them loads on the page.
 */

/** A company as the page reaches it for its super admins: named by a link, or chosen by a signer of it. */
export interface SuperAdminReach {
  readonly company: SuperAdminCompany;
  /** True once the person acts with their wallet's key for the company, as a link always does: every call then carries their signed request. */
  readonly asSuperAdmin: boolean;
}

/** The headers a call carries: a signer reads as a member; anyone acting, or reading with their key, carries the signed request. */
const headersFor = async (reach: SuperAdminReach, acting: boolean): Promise<Record<string, string>> =>
  (reach.asSuperAdmin || acting ? (await superAdminSigned(reach.company, ACCOUNT_ORIGIN)).headers : {});

/** One call to a route of a change of the super admins, with the headers it needs. */
async function superAdminCall(reach: SuperAdminReach, route: string, body?: unknown): Promise<unknown> {
  const headers = await headersFor(reach, body !== undefined);
  return api(companyRoute(reach.company.accountId, route), body === undefined
    ? { headers }
    : { method: SERVICE.post, body: JSON.stringify(body), headers });
}

/** The service as a super admin's device reaches it for a change it keeps. */
export const superAdminService = (reach: SuperAdminReach): SuperAdminService => ({
  raise: async (body) => superAdminCall(reach, SERVICE.raiseAt, body),
  join: async (body) => superAdminCall(reach, SERVICE.joinAt, body),
  kept: async () => {
    const got = await superAdminCall(reach, SERVICE.signatures) as { changes?: unknown };
    return Array.isArray(got.changes) ? got.changes as KeptChange[] : [];
  },
  keepSignatures: async (body) => superAdminCall(reach, SERVICE.signatures, {
    to: { committee: body.to.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: body.to.threshold },
    signatures: body.signatures.map((s) => ({ address: s.address, counter: s.counter, index: s.index, signature: { tag: s.signature.tag, value: s.signature.value } })),
  }),
});

/**
 * **THE DOORS `governance-from-the-chain.ts` RAISES, JOINS AND APPROVES A CHANGE WITH.** The chain is read through
 * the indexer the person's own wallet names. No seat and no record of the company is read: the super admins are the
 * committee the chain holds, and a vault the company created and the account does not list yet is left out of the change.
 * Null when the wallet named no indexer, so who holds the company cannot be read here, or when the vault worker this
 * page started offers no super admins' reads.
 */
export async function superAdminDoorsFor(reach: SuperAdminReach): Promise<SuperAdminDoors | null> {
  const { indexer } = await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: reach.company.label, account: reach.company.account });
  if (indexer === null) return null;
  const worker = (await theVaultBuilder()).superAdmins;
  if (worker === undefined) return null;
  return {
    chain: worker.reads(indexer),
    ledger: worker.ledger,
    createdByTheCompany: [],
    seats: [],
    wallet: superAdminWallet(reach.company, ACCOUNT_ORIGIN),
    service: {
      send: async (update) => superAdminCall(reach, SERVICE.send, update),
      collected: async () => {
        const got = await superAdminCall(reach, SERVICE.signatures) as { signatures?: unknown };
        return Array.isArray(got.signatures) ? got.signatures as SuperAdminSignature[] : [];
      },
    },
  };
}
