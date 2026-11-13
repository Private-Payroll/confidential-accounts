/**
 * **WHO MAY USE THE ROUTES OF A CHANGE OF WHO HOLDS A COMPANY'S CONTRACTS: A MEMBER, OR A SUPER ADMIN WHO SIGNED.**
 *
 * A company's super admins are the committee holding its account on the chain, and need not hold a seat. A request
 * that carries no super admin header is judged by the member gate as every other route is. One that carries it is let
 * in only when its signature is its key's own over this company, its account on the chain and the person signed in
 * (`signedBySuperAdmin`), and
 * that key is on the committee the chain shows holding the company's account now, or joining it in a change a key on
 * that committee already had kept here. The service decides nothing else: the signatures a route keeps or sends are
 * still counted against the committee on the chain, and a refusal here keeps and reads nothing.
 */
import express from 'express';
import type { SignatureCheck } from 'midnight-identity/profile/committee-sign';
import type { Hex } from '../core/crypto.js';
import type { AuthorityRead } from '../midnight/ledger.js';
import { sameCommitteeKey } from '../midnight/vault-committee.js';
import {
  SUPER_ADMIN_HEADER, signedBySuperAdmin, superAdminAsksOf, type CommitteeKeyNamed,
} from '../midnight/super-admin-request.js';

/** What the guard reads: the member gate it falls back to, and the company, its account on the chain and the changes kept. */
export interface SuperAdminGuardDeps {
  readonly member: express.RequestHandler;
  readonly accountExists: (accountId: string) => boolean;
  /** The address of the company's account on the chain, or null when it has none the service can read. */
  readonly companyAddress: (accountId: string) => Promise<string | null>;
  readonly authorityOf: (address: Hex) => Promise<AuthorityRead>;
  /** The changes kept for a contract at a counter, each with the committee it installs. */
  readonly changesKept: (accountId: string, address: string, counter: bigint) => readonly { readonly to: { readonly committee: readonly CommitteeKeyNamed[] } }[];
  /** Checks a committee key's signature; the ledger's own by default. */
  readonly signatureCheck?: () => Promise<SignatureCheck>;
}

interface Refused { readonly status: number; readonly refused: string; readonly error: string }


/** The ledger's own check of a committee key's signature. */
export const theLedgersCheck = async (): Promise<SignatureCheck> => {
  const L = await import('@midnightntwrk/ledger-v9');
  return { verifySignature: (key, data, signature) => L.verifySignature(key, data, signature) };
};

/** Null when the signed request lets its person in, else why not, in words that say what lets them in. */
async function whyNotLetIn(deps: SuperAdminGuardDeps, req: express.Request, header: unknown): Promise<Refused | null> {
  const company = String(req.params.id);
  const user = (req as { userId?: string }).userId ?? '';
  if (user === '' || !deps.accountExists(company)) return { status: 404, refused: 'not-found', error: 'account not found' };
  const asks = superAdminAsksOf(header);
  if (asks === null) {
    return { status: 400, refused: 'not-a-request', error: 'this request\'s super admin header is not a committee key and its signature in the one shape the service reads, so nothing was read or kept. Ask again from your wallet.' };
  }
  const address = await deps.companyAddress(company);
  if (address === null) {
    return { status: 409, refused: 'no-company', error: 'this company has no account on the chain this service can read, so it has no super admins to let in. Nothing was read or kept.' };
  }
  if (!signedBySuperAdmin(await (deps.signatureCheck ?? theLedgersCheck)(), company, user, address, asks)) {
    return { status: 403, refused: 'not-signed', error: 'the signature on this request is not its key\'s own over this company, its account on the chain and the person signed in, so nothing was read or kept. Your wallet signs the request again for this company.' };
  }
  const read = await deps.authorityOf(address as Hex);
  if (read.state !== 'read') {
    return { status: 503, refused: 'chain-unread', error: `the chain could not be asked who holds the company's account (${read.why}), so no super admin was let in and nothing was read or kept. Ask again.` };
  }
  if (read.authority.committee.some((k) => sameCommitteeKey(k, asks.key))) return null;
  if (deps.changesKept(company, address, read.authority.counter).some((p) => p.to.committee.some((k) => sameCommitteeKey(k, asks.key)))) return null;
  return {
    status: 403, refused: 'not-a-super-admin',
    error: 'this key is not on the committee holding the company\'s account on the chain, and no change kept here names it joining, so nothing was read or kept. '
      + 'Ask from a key on that committee, or once a super admin on it has signed a change that names this key.',
  };
}

/**
 * **THE GATE OF THE ROUTES OF A CHANGE OF THE COMMITTEE.** A request with no super admin header goes to the member gate;
 * one with it passes only as `whyNotLetIn` allows, and is otherwise answered with why and what lets it in.
 */
export const superAdminOrMember = (deps: SuperAdminGuardDeps): express.RequestHandler => (req, res, next) => {
  const header = req.headers[SUPER_ADMIN_HEADER];
  if (header === undefined) { deps.member(req, res, next); return; }
  whyNotLetIn(deps, req, header).then((why) => {
    if (why === null) { next(); return; }
    res.status(why.status).json({ nothingWasSent: true, refused: why.refused, error: why.error });
  }, (e: unknown) => {
    res.status(503).json({ nothingWasSent: true, error: `whether this request comes from a super admin could not be read (${(e as Error)?.message ?? String(e)}), so nothing was read or kept. Ask again.` });
  });
};
