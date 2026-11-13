/**
 * **A CHANGE OF THE SUPER ADMINS, KEPT BY THE SERVICE SO EVERY SUPER ADMIN FINDS IT.**
 *
 * The super admin who raises a change signs the change's bytes with its key on the committee holding the company's
 * account on the chain; that is the first signature that counts, and nothing is kept before it. Each key the change
 * adds then signs the change with its own key, and that signature is kept with it. Updates of the contracts are
 * signed only after every joining key has signed, on the routes that already keep and send them. Every check reads
 * who holds the account from the chain, never from here.
 */
import { createHash } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { KeptSuperAdminChange } from '../core/store.js';
import { bare as fold } from '../midnight/account-deploy.js';
import type { AuthorityRead } from '../midnight/ledger.js';
import { sameCommittee, sameCommitteeKey } from '../midnight/vault-committee.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { joinedBy, superAdminChangeBytes, type SignatureCheck } from 'midnight-identity/profile/committee-sign';
import { theLedgersCheck } from './super-admin-guard.js';
import { SUPER_ADMIN_HEADER, superAdminAsksOf } from '../midnight/super-admin-request.js';

/** Where the changes of the super admins are kept. */
export interface SuperAdminChangesStore {
  listSuperAdminChanges(accountId: string): KeptSuperAdminChange[];
  setSuperAdminChanges(accountId: string, changes: readonly KeptSuperAdminChange[]): void;
}

export interface SuperAdminChangesDeps {
  /** The guard every route of a change of the committee sits behind: a member, or a super admin with no seat. */
  readonly superAdmins: readonly express.RequestHandler[];
  readonly store: SuperAdminChangesStore;
  readonly company: (accountId: string) => Promise<{ readonly address: Hex } | null>;
  readonly authorityOf: (address: Hex) => Promise<AuthorityRead>;
  readonly signatureCheck?: () => Promise<SignatureCheck>;
  /** One write at a time per key: what a route keeps is read again and written inside it, so no write is lost to another. */
  readonly oneAtATime: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const KEY = z.object({ tag: z.literal('schnorr'), value: z.string().regex(HEX64) }).strict();
const SIGNATURE = z.string().regex(/^[0-9a-f]{128}$/u);
const COMMITTEE = z.object({ committee: z.array(KEY).min(1).max(64), threshold: z.number().int() }).strict();
const RAISE = z.object({
  company: z.string().min(1).max(256),
  salt: z.string().regex(HEX64),
  change: z.object({
    kind: z.literal('super-admins'),
    from: COMMITTEE,
    committee: z.array(KEY).min(1).max(64),
    threshold: z.number().int(),
    contracts: z.array(z.object({
      contract: z.enum(['account', 'vault']), address: z.string().regex(HEX64), counter: z.string().regex(/^[0-9]{1,20}$/u),
    }).strict()).min(1).max(256),
  }).strict(),
  raisedBy: z.object({ key: KEY, signature: SIGNATURE }).strict(),
}).strict();
const JOIN = z.object({ chainId: z.string().regex(HEX64), joined: z.object({ key: KEY, signature: SIGNATURE }).strict() }).strict();

const bytesOf = (c: Pick<KeptSuperAdminChange, 'company' | 'salt' | 'change'>, account: string): Uint8Array =>
  superAdminChangeBytes(c.company, account, c.salt, c.change);
const idOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The one turn every write of a company's changes of the super admins takes. */
const turnOf = (accountId: string): string => `super-admin-changes ${accountId}`;

/**
 * The committees the changes kept for a company name, at the counter the account's change was raised at: the guard
 * lets a joining key in only while a change kept at the account's counter names it.
 */
export const changesNamingAt = (store: SuperAdminChangesStore, accountId: string, address: string, counter: bigint) =>
  store.listSuperAdminChanges(accountId)
    .filter((c) => fold(c.change.contracts[0]!.address) === fold(address) && c.change.contracts[0]!.counter === counter.toString())
    .map((c) => ({ to: { committee: c.change.committee } }));

/** The changes kept for a company, as a super admin's device reads them: every signature in them is checked again there. */
export const changesKeptFor = (store: SuperAdminChangesStore, accountId: string) =>
  store.listSuperAdminChanges(accountId).map(({ accountId: _company, ...c }) => c);

/** Adds the routes that keep a raised change and a joining key's signature on it, behind the super admins' guard. */
export function superAdminChangeRoutes(r: express.Router, deps: SuperAdminChangesDeps): void {
  const refuse = (res: express.Response, status: number, error: string) => { res.status(status).json({ nothingWasKept: true, error: `${error} Nothing was kept.` }); };
  const accountHeld = async (accountId: string, res: express.Response) => {
    const company = await deps.company(accountId);
    if (company === null) { refuse(res, 409, 'this company has no account on the chain this service can read.'); return null; }
    const read = await deps.authorityOf(company.address);
    if (read.state !== 'read') { refuse(res, 503, `the chain could not be asked who holds the company's account (${read.why}).`); return null; }
    return { address: company.address, authority: read.authority };
  };

  r.post('/api/accounts/:id/committee-change/raise', ...deps.superAdmins, async (req, res) => {
    const body = RAISE.safeParse(req.body);
    if (!body.success) { refuse(res, 400, 'this is not a raised change of the super admins with its raiser\'s signature.'); return; }
    const { change, raisedBy } = body.data;
    const asks = superAdminAsksOf(req.headers[SUPER_ADMIN_HEADER]);
    if (asks === null || !sameCommitteeKey(asks.key, raisedBy.key)) {
      refuse(res, 403, 'a raise is kept only from its raiser\'s own signed request, and this request is not signed by the key that raised it. The raiser sends it from their own page.');
      return;
    }
    const notInstallable = whyNotInstallable(change);
    if (notInstallable !== null) { refuse(res, 409, `the committee this change installs cannot be installed: ${notInstallable}`); return; }
    const accountId = String(req.params.id);
    const held = await accountHeld(accountId, res);
    if (held === null) return;
    const first = change.contracts[0]!;
    if (first.contract !== 'account' || fold(first.address) !== fold(held.address)
      || new Set(change.contracts.map((c) => fold(c.address))).size !== change.contracts.length) {
      refuse(res, 409, 'this change does not name the company\'s account first, or names one contract twice.');
      return;
    }
    if (first.counter !== held.authority.counter.toString() || !sameCommittee(change.from, held.authority)) {
      refuse(res, 409, 'the company\'s account on the chain is no longer held by the committee this change replaces, at the counter it names. Raise the change again.');
      return;
    }
    if (!held.authority.committee.some((k) => sameCommitteeKey(k, raisedBy.key))) {
      refuse(res, 403, 'the key that signed this change is not on the committee holding the company\'s account on the chain. A super admin on it raises the change.');
      return;
    }
    const bytes = bytesOf(body.data, held.address);
    if (!joinedBy(await (deps.signatureCheck ?? theLedgersCheck)(), bytes, raisedBy.key, raisedBy.signature)) {
      refuse(res, 403, 'the raiser\'s signature is not its key\'s own over this change. The raiser\'s wallet signs the change again.');
      return;
    }
    const kept: KeptSuperAdminChange = { accountId, chainId: idOf(bytes), ...body.data, joined: [] };
    await deps.oneAtATime(turnOf(accountId), async () => {
      const now = deps.store.listSuperAdminChanges(accountId);
      /* A change already kept stays as it is, with its joins. */
      if (now.some((c) => c.chainId === kept.chainId)) return;
      /* One change kept per raising key at this counter; a change kept at an older counter can never land, so it goes. */
      const others = now.filter((c) => c.change.contracts[0]!.counter === first.counter && !sameCommitteeKey(c.raisedBy.key, raisedBy.key));
      deps.store.setSuperAdminChanges(accountId, [...others, kept]);
    });
    res.json({ state: 'kept', chainId: kept.chainId });
  });

  r.post('/api/accounts/:id/committee-change/join', ...deps.superAdmins, async (req, res) => {
    const body = JOIN.safeParse(req.body);
    if (!body.success) { refuse(res, 400, 'this is not a joining key\'s signature on a kept change of the super admins.'); return; }
    const accountId = String(req.params.id);
    const kept = deps.store.listSuperAdminChanges(accountId).find((c) => c.chainId === body.data.chainId);
    if (kept === undefined) { refuse(res, 404, 'no change of the super admins with that identity is kept for this company. A super admin raises it first.'); return; }
    const held = await accountHeld(accountId, res);
    if (held === null) return;
    if (kept.change.contracts[0]!.counter !== held.authority.counter.toString()) {
      refuse(res, 409, 'the company\'s account has changed on the chain since this change was raised, so it can no longer land. A super admin raises it again.');
      return;
    }
    const { key, signature } = body.data.joined;
    if (!kept.change.committee.some((k) => sameCommitteeKey(k, key)) || held.authority.committee.some((k) => sameCommitteeKey(k, key))) {
      refuse(res, 403, 'this key is not one the kept change adds to the company\'s account, so it has nothing to sign as a joining key.');
      return;
    }
    if (!joinedBy(await (deps.signatureCheck ?? theLedgersCheck)(), bytesOf(kept, held.address), key, signature)) {
      refuse(res, 403, 'this signature is not the joining key\'s own over the kept change. Its wallet signs the change again.');
      return;
    }
    /* Read again in the account's turn, so a join or a raise kept meanwhile is not written over. */
    const joined = await deps.oneAtATime(turnOf(accountId), async () => {
      const now = deps.store.listSuperAdminChanges(accountId);
      const still = now.find((c) => c.chainId === kept.chainId);
      if (still === undefined) return null;
      const next = [...still.joined.filter((j) => !sameCommitteeKey(j.key, key)), { key, signature }];
      deps.store.setSuperAdminChanges(accountId, now.map((c) => (c.chainId === kept.chainId ? { ...c, joined: next } : c)));
      return next;
    });
    if (joined === null) { refuse(res, 404, 'the change was replaced while this signature was checked. A super admin raises it again.'); return; }
    res.json({ state: 'kept', joined: joined.length });
  });
}
