import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { utf8 } from './crypto.js';
import type { SealedAccount, Proposal, SealedProposal, PayrollRun, SealedRun, Attestation, SealedEmployee, Invite, Installation, PluginEvent, User, CompanyVault, VaultKeysOfASigner } from './types.js';
import { provenanceOf, type Marked, type WiringName } from './provenance.js';

export interface Shape {
  accounts: Record<string, SealedAccount>;
  proposals: Record<string, SealedProposal>;
  runs: Record<string, SealedRun>;
  attestations: Record<string, Attestation>;
  employees: Record<string, SealedEmployee>;
  invites: Record<string, Invite>;
  installations: Record<string, Installation>;
  pluginEvents: Record<string, PluginEvent>;
  users: Record<string, User>;
  /** A company's vaults, keyed by vault address. */
  companyVaults: Record<string, CompanyVault>;
  /** Each signer's public vault keys, keyed by `accountId:userId`. */
  vaultKeys: Record<string, VaultKeysOfASigner>;
  /**
   * **EVERY LEDGER OBSERVED WRITING HERE, IN THE ORDER IT WAS FIRST SEEN.**
   *
   * Appended to by every write below that carries a marker, including the
   * rotation that writes several collections at once. Never removed, never
   * inferred, and never a claim about the records themselves - those carry
   * their own markers and are the authority.
   *
   * **WHAT THIS BUYS THAT COUNTING THE RECORDS CANNOT: IT REMEMBERS.** A count
   * over what is in the store today answers what is there now; this answers
   * whether a second ledger has ever written here, and it goes on answering
   * after the records that proved it were deleted, cancelled or superseded. A
   * store two ledgers have both written to is a store whose lists will be
   * mixed, and that is worth knowing before anything is served rather than
   * when the first company is refused.
   *
   * An EMPTY array is not a claim that nothing wrote here. It says no marked
   * write has been observed, which is what a file written before records were
   * marked looks like, and which is why the records in such a file read as not
   * known rather than as this list's only entry.
   */
  writtenBy: WiringName[];
}

export const emptyShape = (): Shape =>
  ({ accounts: {}, proposals: {}, runs: {}, attestations: {}, employees: {}, invites: {},
    installations: {}, pluginEvents: {}, users: {}, writtenBy: [], companyVaults: {}, vaultKeys: {} });

/**
 * Note what is NOT stored here: viewing keys and signer secrets. Nothing that can
 * open shielded state is ever persisted. Clients hold those and pass them per
 * call, which is the same constraint the real product has.
 *
 * Isomorphic. No filesystem, so this runs in the browser unchanged. FileStore in
 * store-file.ts adds persistence for the server.
 */
/**
 * The stored key for an invite: `sha256` of the raw token, hex.
 *
 * ONE DEFINITION, imported by everything that stores or finds one. A second
 * copy of a hashing rule is this project's most expensive habit, and here the
 * two copies would disagree by silently making every invite unfindable.
 */
export const inviteKeyOf = (token: string): string =>
  bytesToHex(sha256(utf8(token)));

/**
 * THE STORED KEY FOR A WALLET: `sha256` of the subwallet address, hex.
 *
 * ONE DEFINITION, imported by everything that stores or finds one — the same
 * argument as `inviteKeyOf` above, and here the two copies would disagree by
 * silently making every returning person a new person.
 *
 * **THE ADDRESS ITSELF IS NEVER STORED.** `wallet-identity.ts` has the reason
 * in full: `memberUserIds` is outside the envelope, so a plaintext address on
 * a user row would read as *this on-chain identity holds a seat on this
 * company*, which is what `RosterEmployee.address` is sealed to hide and what
 * `A-11` removed `Invite.acceptedBy` for one join less than.
 *
 * NORMALISED BY TRIMMING AND NOTHING ELSE. Bech32 is case-significant here
 * because the address is produced by a codec rather than typed by a person, and
 * lower-casing a value the codec did not lower-case would make a second person
 * out of the same one.
 */
export const walletKeyOf = (address: string): string =>
  bytesToHex(sha256(utf8(address.trim())));

export class MemoryStore {
  protected data: Shape = emptyShape();

  protected flush() { /* nothing to do in memory */ }

  reset() { this.data = emptyShape(); this.flush(); }
  snapshot(): Shape { return this.data; }

  putUser(u: User) { this.data.users[u.id] = u; this.flush(); }

  /*
   * **THE DEVICE STORE WENT WITH THE ENVELOPE.**
   *
   * `putDevice`, `getDevice`, `listDevices` and `replaceDeviceEnvelope` are
   * deleted. The last of those existed so that removing a device — mint a new
   * bundle key, re-seal, re-wrap to the survivors, delete the row — landed as
   * ONE write, because a half-landed one locks the owner out. **There is no
   * such operation any more**, so there is no partial state to guard.
   */
  getUser(id: string) { return this.data.users[id] ?? null; }

  /*
   * **`getUserByEmail` IS DELETED.**
   *
   * It found the row a password sign-in was for, and `register` used it to
   * refuse a second row for one email. **Both callers went with the password**,
   * and no door left creates a user with an email at all: a wallet sign-in
   * resolves by `getUserByWalletKey` below, which is `sha256` of the subwallet
   * address a signature was verified against.
   *
   * Its guard is worth keeping in mind rather than in code: `null` and `''`
   * were both findable once, so `getUserByEmail('')` returned the first person
   * who had never had one and handed a caller somebody else's account. **A
   * lookup by a value that can mean "absent" has no honest answer**, which is
   * an argument against reintroducing this one under any name.
   */

  /** The person a subwallet address signs in as. `walletKeyOf`, never the address. */
  getUserByWalletKey(walletKey: string) {
    const wanted = (walletKey ?? '').trim();
    if (!wanted) return null;
    return Object.values(this.data.users).find(u => u.walletKey === wanted) ?? null;
  }

  /*
   * Accounts are stored SEALED.
   *
   * The store can no longer answer "what is this company called" or "who is on
   * it" — it holds `memberUserIds`, which are opaque, and ciphertext. That is
   * the property rather than a limitation: a store that could list signers by
   * name would be a store that could read the mapping the on-chain blinding
   * exists to hide.
   */

  /**
   * Every account this user has a seat on, granted or waiting. The basis of
   * multi-tenancy, and it must answer with NO VIEWING KEY — the server decides
   * whether a session may touch an account before any key is supplied.
   *
   * Pending seats are included so an invitee can see the account they are
   * waiting on. `membership` is the stricter check and counts only active ones.
   */
  accountsForUser(userId: string) {
    return Object.values(this.data.accounts)
      .filter(a => a.memberUserIds.includes(userId)
        || a.pendingSigners.some(p => p.userId === userId));
  }

  /**
   * **RECORDS WHAT A WRITE SAID ABOUT ITSELF. IT NEVER SUPPLIES AN ANSWER.**
   *
   * A record with no marker adds nothing here, because *this write did not say*
   * is not evidence about which ledger was running - and writing down a guess
   * is worse than the silence it replaces, since the next reader cannot tell it
   * was a guess.
   */
  protected observe(record: Marked) {
    const seen = provenanceOf(record);
    if (seen === 'unknown') return;
    if (this.data.writtenBy.includes(seen)) return;
    this.data.writtenBy = [...this.data.writtenBy, seen];
  }

  putAccount(a: SealedAccount) { this.data.accounts[a.id] = a; this.observe(a); this.flush(); }
  getAccount(id: string) { return this.data.accounts[id] ?? null; }
  listAccounts() { return Object.values(this.data.accounts); }

  /* Proposals are stored SEALED. S-8: approvals[].signerId is the deanonymised
   * version of the nullifiers the chain deliberately blinds. */
  putProposal(p: SealedProposal) { this.data.proposals[p.id] = p; this.observe(p); this.flush(); }
  getProposal(id: string) { return this.data.proposals[id] ?? null; }
  listProposals(accountId: string) {
    return Object.values(this.data.proposals).filter(p => p.accountId === accountId);
  }

  /* Runs are stored SEALED. S-9: the amounts live here as well as on the roster. */
  putRun(r: SealedRun) { this.data.runs[r.id] = r; this.observe(r); this.flush(); }
  getRun(id: string) { return this.data.runs[id] ?? null; }
  listRuns(accountId: string) {
    return Object.values(this.data.runs).filter(r => r.accountId === accountId);
  }

  /*
   * Employees are stored SEALED.
   *
   * The store cannot sort by name any more, because it cannot read one — and
   * that is the correct outcome rather than a limitation to work around. Sorting
   * moves to the caller, which has the viewing key and is the only place that
   * should. A store that could sort by name would be a store that could read it.
   */
  putEmployee(e: SealedEmployee) { this.data.employees[e.id] = e; this.flush(); }
  getEmployee(id: string) { return this.data.employees[id] ?? null; }
  listEmployees(accountId: string): SealedEmployee[] {
    return Object.values(this.data.employees)
      .filter(e => e.accountId === accountId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * `i.token` IS ALREADY THE HASH by the time an invite reaches here — the field
   * is named for what it identifies, and its doc says what it holds. Keyed by it
   * directly so a caller cannot store one under a raw token by mistake.
   */
  putInvite(i: Invite) { this.data.invites[i.token] = i; this.flush(); }
  /**
   * Looked up by the HASH of the token. A-7.
   *
   * The caller passes the raw token; nothing here ever stores one. A database
   * backup therefore carries no usable invite, which is what `sessions.ts`
   * already concluded about a credential in a table.
   */
  getInvite(token: string) {
    const hashed = this.data.invites[inviteKeyOf(token)];
    if (hashed) return hashed;
    /*
     * A ROW WRITTEN BEFORE INVITES WERE HASHED. `C27`, found by audit.
     *
     * Without this, every invite outstanding at the moment of an upgrade became
     * unfindable — while `listInvites` went on serving it to the admin screen as
     * open, and the person stayed `pending`. **A run refuses to build while
     * anybody is pending, so one employee hired the day before a deploy stopped
     * everybody else being paid**, with no route to delete the orphan and
     * nothing saying that marking them a leaver was the escape.
     *
     * Found and re-keyed here rather than in a migration script, because the
     * store is also a file somebody restores from a backup — a one-shot
     * migration fixes the deploy and not the restore. It rewrites as it goes, so
     * each legacy row is converted the first time it is used and never again.
     */
    /*
     * AND A STORED KEY IS NOT A TOKEN. Caught by an existing test the moment the
     * fallback was added, which is the test earning its place: without this
     * line, `sha256(token)` — the value in the table, and in every backup —
     * would itself open the row, and hashing would have bought nothing at all.
     *
     * A legacy token is `inv_…`; a stored key is 64 hex characters. Anything
     * that looks like a key is refused rather than looked up.
     */
    if (/^[0-9a-f]{64}$/.test(token)) return null;

    const legacy = this.data.invites[token];
    if (!legacy) return null;
    const migrated = { ...legacy, token: inviteKeyOf(token) };
    delete this.data.invites[token];
    this.data.invites[migrated.token] = migrated;
    this.flush();
    return migrated;
  }
  listInvites(accountId: string) {
    return Object.values(this.data.invites).filter(i => i.accountId === accountId);
  }

  putInstallation(i: Installation) { this.data.installations[i.id] = i; this.flush(); }
  getInstallation(id: string) { return this.data.installations[id] ?? null; }
  getInstallationByToken(token: string) {
    return Object.values(this.data.installations).find(i => i.token === token) ?? null;
  }
  listInstallations(accountId: string) {
    return Object.values(this.data.installations)
      .filter(i => i.accountId === accountId && i.status !== 'removed');
  }

  putPluginEvent(e: PluginEvent) { this.data.pluginEvents[e.id] = e; this.flush(); }
  listPluginEvents(accountId: string) {
    return Object.values(this.data.pluginEvents).filter(e => e.accountId === accountId);
  }

  /* A company's vaults, and its signers' public vault keys. */
  putCompanyVault(v: CompanyVault) { this.data.companyVaults[v.vault] = v; this.flush(); }
  getCompanyVault(vault: string) { return this.data.companyVaults[vault.toLowerCase()] ?? null; }
  listCompanyVaults(accountId: string): CompanyVault[] {
    return Object.values(this.data.companyVaults)
      .filter(v => v.accountId === accountId)
      .sort((a, b) => a.deployedAt.localeCompare(b.deployedAt));
  }
  putVaultKeys(k: VaultKeysOfASigner) { this.data.vaultKeys[`${k.accountId}:${k.userId}`] = k; this.flush(); }
  getVaultKeys(accountId: string, userId: string) { return this.data.vaultKeys[`${accountId}:${userId}`] ?? null; }

  putAttestation(a: Attestation) { this.data.attestations[a.id] = a; this.flush(); }
  getAttestation(id: string) { return this.data.attestations[id] ?? null; }

  /**
   * The flip, and the only reason this method exists. K-4.
   *
   * A rotation re-seals every record an account owns under a new viewing key.
   * Written one `put` at a time it would go through `flush` once per record,
   * and a crash partway would leave an account whose roster opens under the new
   * key and whose payroll opens under the old — with only one of the two
   * wrapped key sets still issued. **Half of it would be unreadable by
   * everybody, permanently.**
   *
   * So it is one call that writes everything and flushes once. `FileStore`
   * rewrites the whole file, so on this implementation the swap is as atomic as
   * the filesystem allows; under Postgres (I-1) it becomes one transaction, and
   * this signature is what makes that a change of one method rather than of
   * every caller.
   *
   * The shielded state is NOT here, because it is not ours — it lives behind
   * the ledger and is written first, alongside the old epoch rather than over
   * it. That ordering is the whole design; see `AccountService.rotate`.
   */
  commitRotation(set: {
    account: SealedAccount;
    employees: SealedEmployee[];
    runs: SealedRun[];
    proposals: SealedProposal[];
  }): void {
    this.data.accounts[set.account.id] = set.account;
    for (const e of set.employees) this.data.employees[e.id] = e;
    for (const r of set.runs) this.data.runs[r.id] = r;
    for (const p of set.proposals) this.data.proposals[p.id] = p;
    /* This writes records without going through the three methods above, so it
     * has to observe what it wrote itself - a write the envelope does not see
     * is a ledger the envelope does not know has been here. */
    this.observe(set.account);
    for (const r of set.runs) this.observe(r);
    for (const p of set.proposals) this.observe(p);
    this.flush();
  }
}

export type DataStore = MemoryStore;
