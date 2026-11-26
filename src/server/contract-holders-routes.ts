/**
 * **WHO HOLDS THE COMPANY'S CONTRACTS, AND A CHANGE OF IT.** Who holds the
 * account's and every vault's rules on the chain, and the routes through which
 * a change of who holds them is signed, kept and sent.
 */
import express from 'express';
import { z } from 'zod';
import type { Hex } from '../core/crypto.js';
import type { SealedAccount } from '../core/types.js';
import { saysNothingWasSent } from '../core/jobs.js';
import type { AuthorityRead } from '../midnight/ledger.js';
import { sameCommittee, type Committee } from '../midnight/vault-committee.js';
import { authorityView, type ContractAuthorityView } from '../midnight/company-authority.js';
import { contractsOwingAChange, type ContractOwingAChange } from '../midnight/committee-change.js';
import { aGivenSignatureCounts, committeeSignaturesKept, NONE_COUNTS } from './committee-signatures-kept.js';
import { superAdminOrMember, theLedgersCheck } from './super-admin-guard.js';
import { changesKeptFor, changesNamingAt, superAdminChangeRoutes } from './super-admin-changes-kept.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { joinedBy, superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import { refusalForCommitteeChange } from '../wiring/vault-submission.js';
import { HEX64, fold, type CompanyVaultReads } from './company-vault-reads-and-sends.js';
import type { CompanyVaultDeps } from './company-vaults.js';

/** The routes that say who holds the company's contracts and carry a change of it. */
export function contractHoldersRoutes(r: express.Router, reads: CompanyVaultReads): void {
  const { deps, now, guard, accountOf, NO_COMPANY, accountCommittee, authorityOf, HANDOVER_LIFETIME_MS } = reads;

  /* ---- who holds the company's rules ---- */

  /*
   * **WHO HOLDS EACH SEAT IS NOT ANSWERED HERE.** This service keeps no record of
   * which key is whose; a device names each committee key from the seats it
   * believes, and says which is its own from its own wallet.
   */
  const NO_HOLDERS: ReadonlyMap<string, string> = new Map();

  /*
   * **EVERY VAULT THE COMPANY'S ACCOUNT LISTS ON THE CHAIN**, adopted or
   * retired: the account's own record of its vaults, and the only thing that
   * makes a vault the company's here. Neither the account a vault's deployer
   * pinned it to, nor this service's list of vaults, nor its record of how
   * each was created decides it. Empty when the chain could not be asked.
   */
  const listedVaults = async (companyAddress: Hex): Promise<string[]> => {
    if (deps.chain.accountVaults === undefined) return [];
    try {
      return [...new Set((await deps.chain.accountVaults(companyAddress)).map(fold))].filter((v) => HEX64.test(v) && v !== fold(companyAddress));
    } catch { return []; /* a vault this read cannot list is refused by `contractOf` and left off the view; nothing is kept or sent for it */ }
  };

  /*
   * **EVERY CONTRACT OF THE COMPANY, WITH WHO HOLDS EACH ON THE CHAIN NOW**: the
   * account, and every vault it lists on the chain. For a screen to show and a
   * device to check; a change of who holds them names its own contracts.
   */
  const companyContracts = async (_account: SealedAccount, companyAddress: Hex) => {
    const out: { contract: 'account' | 'vault'; read: AuthorityRead; bornHeld: boolean }[] = [
      { contract: 'account', read: await authorityOf(companyAddress), bornHeld: true },
    ];
    for (const v of await listedVaults(companyAddress)) out.push({ contract: 'vault', read: await authorityOf(v as Hex), bornHeld: true });
    return out;
  };

  /**
   * **WHETHER A CONTRACT IS OFFERED A CHANGE ON THE SETTINGS SCREEN, AND THE
   * SENTENCE BESIDE IT**, from the same list the change view is built from, so
   * the screen never offers what the view would not list.
   */
  const changeOffered = (committee: Committee | null, owed: readonly ContractOwingAChange[]) => {
    if (committee === null) {
      return { possible: false, why: 'No committee holds this company\'s account on the chain yet, so there is nothing to change its vaults to.' };
    }
    const vaultsBehind = owed.filter((c) => c.contract === 'vault').length;
    if (owed.length === 0) {
      return {
        possible: false,
        why: 'No change is waiting. Every contract listed above that could be read is held by the committee that holds '
          + 'the company\'s account.',
      };
    }
    return {
      possible: true,
      why: `${vaultsBehind} vault${vaultsBehind === 1 ? ' is' : 's are'} still held by the super admins from before they last `
        + 'changed. Until a vault is changed, the keys of the super admins who left can still change its rules. Payments '
        + 'into and out of it go on as before. The super admins who hold each one now sign the change in their own '
        + 'wallets, and once enough have signed, a device sends it.',
    };
  };

  r.get('/api/accounts/:id/authority', ...guard, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    const serviceKey = deps.account.temporaryKey ?? null;
    const contracts: ContractAuthorityView[] = [];
    const listed = company === null ? [] : await companyContracts(account, company.address);
    for (const c of listed) contracts.push(authorityView(c.contract, c.read, committee, NO_HOLDERS, serviceKey));
    res.json({
      company: company === null ? null : { address: company.address, label: account.companyLabel ?? null },
      committee,
      why,
      contracts,
      change: changeOffered(
        committee,
        company === null || committee === null ? [] : contractsOwingAChange(listed, committee).owed),
    });
  });

  /* ---- a change of who holds the company's contracts ---- */

  /*
   * **THE SIGNATURES KEPT, AND WHO MAY USE THE FOUR ROUTES BELOW**: a member, or
   * a super admin whose signed request `superAdminOrMember` lets in.
   */
  const { keptRecord, keptFor, keep } = committeeSignaturesKept(deps);
  /* For a vault, which other committees kept for it can still be sent: only the one the account holds on the chain now. */
  const sendableFor = async (contract: 'account' | 'vault', companyAddress: Hex): Promise<((c: Committee) => boolean) | undefined> => {
    const accountNow = contract === 'vault' ? await authorityOf(companyAddress) : null;
    if (accountNow?.state !== 'read') return undefined;
    const held: Committee = { committee: accountNow.authority.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: accountNow.authority.threshold };
    return (c) => sameCommittee(c, held);
  };
  const superAdmins = [deps.signedIn, express.json({ limit: '4mb' }), superAdminOrMember({
    member: deps.member, accountExists: (id) => deps.store.getAccount(id) !== null,
    companyAddress: async (id) => (await deps.company(id))?.address ?? null, authorityOf,
    changesKept: (id, address, counter) => [...(keptRecord(id, address, counter)?.proposed ?? []), ...changesNamingAt(deps.store, id, address, counter)],
  })];

  /*
   * **WHICH OF THIS COMPANY'S CONTRACTS AN ADDRESS IS, READ FROM THE CHAIN**:
   * its account, or a vault the account itself lists (`listedVaults`). The
   * account a vault's deployer pinned it to is the deployer's claim, so it
   * decides nothing here.
   */
  const contractOf = async (companyAddress: string, address: string): Promise<{ contract: 'account' | 'vault'; label: string } | string> => {
    if (fold(address) === fold(companyAddress)) return { contract: 'account', label: 'the company\'s account' };
    return (await listedVaults(companyAddress as Hex)).includes(fold(address))
      ? { contract: 'vault', label: `vault ${address}` }
      : 'this company has no contract at that address: the company\'s account does not list a vault there on the chain.';
  };

  /*
   * **ONE REQUEST AT A TIME PER CONTRACT.** Two devices asking at once would
   * otherwise both read the same signatures, each write back what it read, and
   * both send. In this process only; the counter kept with the signatures
   * stands behind it across processes.
   */
  const inTurn = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = inTurn.get(key) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.then(() => undefined, () => {
      /* the turn only orders the next request; `mine` hands this one's error to its caller */
    });
    inTurn.set(key, settled);
    void settled.then(() => { if (inTurn.get(key) === settled) inTurn.delete(key); });
    return mine;
  };
  superAdminChangeRoutes(r, { superAdmins, store: deps.store, company: deps.company, authorityOf, oneAtATime });

  /*
   * **THE VAULTS NOT HOLDING THE COMMITTEE THAT HOLDS THE COMPANY'S ACCOUNT ON
   * THE CHAIN.** Read from the chain each time: the committee holding the
   * account, which is the only committee offered here, and for each vault the
   * committee holding it, the counter an update is signed against and the
   * places on that committee whose signatures are kept. Nothing taken from a
   * change in progress is offered.
   */
  r.get('/api/accounts/:id/committee-change', ...superAdmins, async (req, res) => {
    const account = accountOf(req);
    const { company, committee, why } = await accountCommittee(account);
    if (company === null || committee === null) {
      res.json({
        company: company?.address ?? null, label: account.companyLabel ?? null,
        to: null, why, contracts: [], notChangeable: [],
      });
      return;
    }
    const { owed, notChangeable } = contractsOwingAChange(await companyContracts(account, company.address), committee);
    res.json({
      company: company.address,
      /* The company's label, from the same record as the address: what the signer's wallet derives its key from. */
      label: account.companyLabel ?? null,
      to: committee,
      why: null,
      contracts: owed.map((c) => ({
        contract: c.contract,
        address: c.address,
        counter: c.counter.toString(),
        now: c.now,
        signedIndexes: keptFor(account.id, c.address, c.counter, committee).map((x) => x.index),
        required: c.now.threshold,
      })),
      notChangeable,
    });
  });

  const KEY = z.object({ tag: z.string().min(1).max(32), value: z.string().regex(/^[0-9a-f]{1,256}$/u) }).strict();
  const TO = z.object({ committee: z.array(KEY).min(1).max(64), threshold: z.number().int() }).strict();
  const PLACE = z.object({ index: z.number().int().min(0).max(1023), signature: KEY }).strict();

  /*
   * **SIGNATURES ON CONTRACTS' COMMITTEE UPDATES, AS WALLETS MADE THEM, KEPT.**
   * For each contract named: that it is the company's on the chain, the
   * counter the chain holds it at, and each signature verifying, at the place
   * it names, under the committee holding it on the chain, over
   * `committeeUpdateOf`'s bytes for `to`. What verifies is kept, and only when
   * a signature this request gave is among it, each place's newest signature
   * replacing its older ones (`keep`); nothing is sent. No role, seat or signer is read,
   * and `to` is whatever committee the signatures are over, refused only by the
   * one install rule.
   */
  r.post('/api/accounts/:id/committee-change/signatures', ...superAdmins, async (req, res) => {
    const body = z.object({
      to: TO,
      signatures: z.array(z.object({
        address: z.string().regex(HEX64), counter: z.string().regex(/^[0-9]{1,20}$/u), index: z.number().int().min(0).max(1023), signature: KEY,
      }).strict()).min(1).max(64),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'these are not signatures on a change of a contract\'s committee. Nothing was kept or sent.' });
      return;
    }
    const to: Committee = body.data.to;
    const notInstallable = whyNotInstallable(to);
    if (notInstallable !== null) {
      res.status(409).json({ nothingWasSent: true, error: `these signatures are on a committee that cannot be installed: ${notInstallable} Nothing was kept or sent.` });
      return;
    }
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) {
      res.status(409).json({ nothingWasSent: true, error: `${NO_COMPANY} Nothing was kept or sent.` });
      return;
    }
    const assemble = deps.committeeChange;
    if (assemble === undefined) {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not check or send committee changes, so nothing was kept.' });
      return;
    }
    const results: Array<Record<string, unknown>> = [];
    const byAddress = new Map<string, typeof body.data.signatures>();
    for (const sig of body.data.signatures) byAddress.set(sig.address, [...(byAddress.get(sig.address) ?? []), sig]);
    for (const [address, given] of byAddress) {
      await oneAtATime(address, async () => {
        const which = await contractOf(company.address, address);
        if (typeof which === 'string') { results.push({ address, state: 'refused', nothingWasSent: true, error: which }); return; }
        const read = await authorityOf(address as Hex);
        if (read.state !== 'read') {
          results.push({ address, state: 'refused', nothingWasSent: true, error: `the chain could not be asked who holds ${which.label} (${read.why}).` });
          return;
        }
        if (given.some((g) => g.counter !== read.authority.counter.toString())) {
          results.push({
            address, state: 'refused', nothingWasSent: true,
            error: `${which.label} has been changed since these signatures were made, so they no longer count. Sign again.`,
          });
          return;
        }
        const places = given.map((g) => ({ index: g.index, signature: g.signature }));
        let assembled: Awaited<ReturnType<NonNullable<CompanyVaultDeps['committeeChange']>>>;
        try {
          assembled = await assemble({ read, to, label: which.label, signatures: [...keptFor(account.id, address, read.authority.counter, to), ...places] });
        } catch (e) {
          results.push({ address, state: 'refused', nothingWasSent: true, error: (e as Error)?.message ?? String(e) });
          return;
        }
        if (!aGivenSignatureCounts(places, assembled.counted)) { results.push({ address, state: 'refused', nothingWasSent: true, error: NONE_COUNTS }); return; }
        keep(account.id, address, read.authority.counter, to, assembled.counted, undefined, await sendableFor(which.contract, company.address));
        results.push({ address, state: 'kept', have: assembled.have, required: assembled.required, indexesSigned: assembled.indexesSigned });
      });
    }
    res.json({ results });
  });

  /* **EVERY SIGNATURE KEPT FOR THIS COMPANY'S CONTRACTS, HANDED BACK**, for each device to count only where it verifies. */
  r.get('/api/accounts/:id/committee-change/signatures', ...superAdmins, (req, res) => {
    const kept = deps.store.listCommitteeSignatures(accountOf(req).id);
    res.json({
      signatures: kept.filter((k) => Array.isArray(k.proposed)).flatMap((k) => k.proposed.flatMap((p) => p.signatures.map((x) => ({
        address: k.address, counter: k.counter, index: x.index, signature: x.signature, to: p.to,
      })))),
      changes: changesKeptFor(deps.store, accountOf(req).id),
    });
  });

  const CHANGE = z.object({
    company: z.string().min(1).max(256),
    salt: z.string().regex(HEX64),
    change: z.object({
      kind: z.literal('super-admins'),
      from: TO,
      committee: z.array(KEY).min(1).max(64),
      threshold: z.number().int(),
      contracts: z.array(z.object({
        contract: z.enum(['account', 'vault']), address: z.string().regex(HEX64), counter: z.string().regex(/^[0-9]{1,20}$/u),
      }).strict()).min(1).max(256),
    }).strict(),
    joined: z.array(z.object({ key: KEY, signature: z.string().regex(/^[0-9a-f]{128}$/u) }).strict()).max(64),
  }).strict();

  /*
   * **ONE CONTRACT'S UPDATE SENT, ON A DEVICE'S REQUEST, AND ONLY WHEN THE CHAIN
   * WOULD TAKE IT.** Sent only:
   *
   *   - with a change of the super admins (`change`), when `to` is the
   *     committee it installs, the contract is one it names, and every key `to`
   *     puts on this contract - every key of it the committee holding the
   *     contract on the chain does not hold - signed the change's bytes with its
   *     own key; and, for a vault, once the account reads current on the chain:
   *     holding `to` at a counter past the one the change was raised at;
   *   - without one, only to the committee holding the company's account on the
   *     chain now, which no key enters the company by;
   *   - once per counter: an update at a counter this service already sent is
   *     not sent again while it could still land, kept with the signatures so a
   *     restart or a second process sees it too;
   *   - and only once the signatures that verify, the kept and the given, reach
   *     the threshold of the committee holding the contract on the chain: the
   *     one count the chain makes, read before any fee is paid. A request
   *     short of it keeps what counted only as the signatures route would.
   *
   * No role, seat or signer is read, and nothing here decides which committee
   * the super admins may choose.
   */
  r.post('/api/accounts/:id/committee-change/send', ...superAdmins, async (req, res) => {
    const body = z.object({
      address: z.string().regex(HEX64),
      counter: z.string().regex(/^[0-9]{1,20}$/u),
      to: TO,
      signatures: z.array(PLACE).max(64).optional(),
      change: CHANGE.optional(),
    }).strict().safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ nothingWasSent: true, error: 'this is not a request to send one contract\'s committee update. Nothing was sent.' });
      return;
    }
    const { address, change } = body.data;
    const to: Committee = body.data.to;
    const refuse = (status: number, error: string) => { res.status(status).json({ nothingWasSent: true, error: `${error} Nothing was sent.` }); };
    const notInstallable = whyNotInstallable(to);
    if (notInstallable !== null) { refuse(409, `the committee asked for cannot be installed: ${notInstallable}`); return; }
    const account = accountOf(req);
    const company = await deps.company(account.id);
    if (company === null) { refuse(409, NO_COMPANY); return; }
    const assemble = deps.committeeChange;
    if (assemble === undefined || typeof deps.ledger.sendVault !== 'function') {
      res.status(503).json({ nothingWasSent: true, error: 'this deployment does not send committee changes, so nothing was sent.' });
      return;
    }
    await oneAtATime(address, async () => {
      const which = await contractOf(company.address, address);
      if (typeof which === 'string') { refuse(409, which); return; }
      const read = await authorityOf(address as Hex);
      if (read.state !== 'read') { refuse(503, `the chain could not be asked who holds ${which.label} (${read.why}).`); return; }
      if (body.data.counter !== read.authority.counter.toString()) {
        refuse(409, `${which.label} is at counter ${read.authority.counter} on the chain, not ${body.data.counter}, so an update signed `
          + 'at that counter would be refused: after its fee when its signatures still verify under the committee holding it now, '
          + 'with no fee when they do not. Read the chain again and sign at its counter.');
        return;
      }
      if (change !== undefined) {
        const installs: Committee = { committee: change.change.committee, threshold: change.change.threshold };
        if (!sameCommittee(installs, to)) { refuse(409, 'the committee asked for is not the one this change installs.'); return; }
        const first = change.change.contracts[0]!;
        if (first.contract !== 'account' || fold(first.address) !== fold(company.address)) {
          refuse(409, 'this change does not name the company\'s account first.');
          return;
        }
        if (!change.change.contracts.some((c) => fold(c.address) === fold(address))) {
          refuse(409, `this change does not name ${which.label}.`);
          return;
        }
        const L = await theLedgersCheck();
        const bytes = superAdminChangeBytes(change.company, company.address, change.salt, change.change);
        const holders = read.authority.committee;
        const joins = to.committee.filter((k) => !holders.some((h) => fold(h.tag) === fold(k.tag) && fold(h.value) === fold(k.value)));
        const unsigned = joins.filter((k) => !change.joined.some((j) => fold(j.key.tag) === fold(k.tag) && fold(j.key.value) === fold(k.value)
          && joinedBy(L, bytes, k, j.signature)));
        if (unsigned.length > 0) {
          refuse(409, `${unsigned.length} key${unsigned.length === 1 ? '' : 's'} this update puts on ${which.label} ${unsigned.length === 1 ? 'has' : 'have'} `
            + 'not signed the change with its own key, so the update is not sent: a key nobody holds is never put on a contract.');
          return;
        }
        if (which.contract === 'vault') {
          const accountNow = await authorityOf(company.address);
          const current = accountNow.state === 'read' && accountNow.authority.counter > BigInt(first.counter)
            && sameCommittee({ committee: accountNow.authority.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: accountNow.authority.threshold }, to);
          if (!current) {
            refuse(409, 'the company\'s account does not yet hold this committee on the chain, and a vault\'s update is sent only once it does. '
              + 'Send the account\'s update first.');
            return;
          }
        }
      } else {
        const held = await accountCommittee(account);
        if (held.committee === null || !sameCommittee(held.committee, to)) {
          refuse(409, 'without a change of the super admins, a contract is changed only to the committee holding the company\'s '
            + 'account on the chain now, and that is not the committee asked for.');
          return;
        }
      }
      const record = keptRecord(account.id, address, read.authority.counter);
      if (record?.sentAt != null && now().getTime() - Date.parse(record.sentAt) < HANDOVER_LIFETIME_MS) {
        refuse(409, `an update of ${which.label} at this counter was sent and the chain has not shown it yet, and once the first lands `
          + 'the chain refuses a second: with no fee when the first changed who holds it, after its fee when it did not. Wait for the '
          + 'first, then read the chain again.');
        return;
      }
      let assembled: Awaited<ReturnType<NonNullable<CompanyVaultDeps['committeeChange']>>>;
      try {
        assembled = await assemble({
          read, to, label: which.label,
          signatures: [...keptFor(account.id, address, read.authority.counter, to), ...(body.data.signatures ?? [])],
        });
      } catch (e) { refuse(409, (e as Error)?.message ?? String(e)); return; }
      if (assembled.proven === null) {
        if (aGivenSignatureCounts(body.data.signatures ?? [], assembled.counted)) keep(account.id, address, read.authority.counter, to, assembled.counted, undefined, await sendableFor(which.contract, company.address));
        refuse(409, `${assembled.have} of the ${assembled.required} signatures the committee holding ${which.label} on the chain needs `
          + 'verify, and the chain refuses an update short of that before it takes it.');
        return;
      }
      /* Marked sent before it goes, so a second request, here or in another process, is refused rather than paid. */
      keep(account.id, address, read.authority.counter, to, assembled.counted, now().toISOString());
      try {
        const sent = await deps.ledger.sendVault!(account.id, `changing the committee holding ${which.label}`,
          'proven-moving-nothing', assembled.proven,
          (tx) => refusalForCommitteeChange(tx, { address, to, onChain: read.authority, contract: which.contract }),
          deps.readers.proven);
        res.json({ state: 'sent', txRef: sent.ref, have: assembled.have, required: assembled.required });
      } catch (e) {
        const nothing = saysNothingWasSent(e);
        /* Only a refusal that says nothing was sent frees the counter for another send; one that may have landed does not. */
        if (nothing) keep(account.id, address, read.authority.counter, to, assembled.counted, null);
        res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: (e as Error)?.message ?? String(e) });
      }
    });
  });
}
