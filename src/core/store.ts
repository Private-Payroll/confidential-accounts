import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { utf8 } from './crypto.js';
import type { SealedAccount, Proposal, SealedProposal, PayrollRun, SealedRun, Attestation, SealedEmployee, Invite, Installation, PluginEvent, User, CompanyVault, FilingKeyOfAMember } from './types.js';
import type { CompanyVaultKeyIndex } from './vault-keys.js';
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
  /**
   * Each company's vault keys with nobody's name on them, keyed by account. Made
   * from the sealed roster every time the roster is written; the roster is the
   * only record of whose each key is.
   */
  vaultKeyIndex: Record<string, CompanyVaultKeyIndex>;
  /** Each member's filing key, keyed by `accountId:userId`. */
  filingKeys: Record<string, FilingKeyOfAMember>;
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
    installations: {}, pluginEvents: {}, users: {}, writtenBy: [], companyVaults: {}, vaultKeyIndex: {}, filingKeys: {} });

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
 * in full: `memberUserIds` is outside the envelope, so a plaintext address on a
 * user row would read as *this on-chain identity holds a seat on this company*,
 * which is what `RosterEmployee.address` is sealed to hide and what
 * `Invite.acceptedBy` was removed for one join less than.
 *
 * NORMALISED BY TRIMMING AND NOTHING ELSE. Bech32 is case-significant here
 * because the address is produced by a codec rather than typed by a person, and
 * lower-casing a value the codec did not lower-case would make a second person
 * out of the same one.
 */
export const walletKeyOf = (address: string): string =>
  bytesToHex(sha256(utf8(address.trim())));

/**
 * **WHERE A PAYSLIP LOOKUP LOOKS, SO IT DOES NOT READ EVERY RECORD TO ANSWER.**
 *
 * A payee's page asks two things with no viewing key: which slips are sealed to
 * one public key, and which company addresses one company's slips name. Both
 * are answered from fields already outside the envelope - a slip's `sealedTo`
 * and `issuedBy`, a roster record's public key, an account's contract address -
 * so this holds nothing the records do not already show. It exists so that the
 * answer costs the size of the answer rather than the size of the store.
 *
 * **BUILT FROM THE DATA IT DESCRIBES, AND REBUILT WHEN THE DATA IS REPLACED.**
 * It remembers which `data` object it was built from; a reset, a load, or a
 * write that failed and was put back replaces that object, and the next
 * lookup rebuilds rather than answering about records that are gone. Every
 * write between those is applied to it as it happens.
 */
class PayslipIndex {
  /** Slips that name the key they are sealed to: key -> run ids. */
  private readonly sealedTo = new Map<string, Set<string>>();
  /** Slips sealed before they named a key: employee id -> run ids. */
  private readonly unnamed = new Map<string, Set<string>>();
  /** Roster records by their public key: key -> employee ids. */
  private readonly byKey = new Map<string, Set<string>>();
  private readonly keyOfEmployee = new Map<string, string>();
  /** Per run, what it was indexed under, so a rewrite can take it back out. */
  private readonly ofRun = new Map<string, {
    accountId: string; keys: string[]; unnamed: string[]; named: string[];
  }>();
  /** Per account, every address its slips name, counted across runs. */
  private readonly namedBy = new Map<string, Map<string, number>>();
  /** Per account, its contract address as indexed. */
  private readonly addressOf = new Map<string, string>();
  /** Address -> accounts that hold it now or whose slips name it. */
  private readonly accountsAt = new Map<string, Map<string, number>>();

  constructor(readonly builtFrom: Shape) {
    for (const a of Object.values(builtFrom.accounts)) this.account(a);
    for (const e of Object.values(builtFrom.employees)) this.employee(e);
    for (const r of Object.values(builtFrom.runs)) this.run(r);
  }

  private static add<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
    let set = m.get(k);
    if (!set) m.set(k, set = new Set());
    set.add(v);
  }
  private static drop<K, V>(m: Map<K, Set<V>>, k: K, v: V) {
    const set = m.get(k);
    if (!set) return;
    set.delete(v);
    if (set.size === 0) m.delete(k);
  }
  private static count(m: Map<string, Map<string, number>>, k: string, v: string, by: 1 | -1) {
    let inner = m.get(k);
    if (!inner) m.set(k, inner = new Map());
    const n = (inner.get(v) ?? 0) + by;
    if (n > 0) inner.set(v, n); else inner.delete(v);
    if (inner.size === 0) m.delete(k);
  }

  account(a: SealedAccount) {
    const before = this.addressOf.get(a.id);
    const now = typeof a.contractAddress === 'string' ? a.contractAddress.toLowerCase() : undefined;
    if (before === now) return;
    if (before !== undefined) PayslipIndex.count(this.accountsAt, before, a.id, -1);
    if (now !== undefined) {
      PayslipIndex.count(this.accountsAt, now, a.id, 1);
      this.addressOf.set(a.id, now);
    } else {
      this.addressOf.delete(a.id);
    }
  }

  employee(e: SealedEmployee) {
    const before = this.keyOfEmployee.get(e.id);
    const now = e.wrappingPublicKey ? e.wrappingPublicKey.toLowerCase() : undefined;
    if (before === now) return;
    if (before !== undefined) PayslipIndex.drop(this.byKey, before, e.id);
    if (now !== undefined) {
      PayslipIndex.add(this.byKey, now, e.id);
      this.keyOfEmployee.set(e.id, now);
    } else {
      this.keyOfEmployee.delete(e.id);
    }
  }

  run(r: SealedRun) {
    const before = this.ofRun.get(r.id);
    if (before) {
      for (const k of before.keys) PayslipIndex.drop(this.sealedTo, k, r.id);
      for (const e of before.unnamed) PayslipIndex.drop(this.unnamed, e, r.id);
      for (const a of before.named) {
        PayslipIndex.count(this.namedBy, before.accountId, a, -1);
        PayslipIndex.count(this.accountsAt, a, before.accountId, -1);
      }
    }
    const keys: string[] = [];
    const unnamed: string[] = [];
    const named = new Set<string>();
    for (const p of r.payslips ?? []) {
      if (p.sealedTo !== undefined) keys.push(p.sealedTo.toLowerCase());
      else unnamed.push(p.employeeId);
      if (p.issuedBy) named.add(p.issuedBy.toLowerCase());
    }
    for (const k of keys) PayslipIndex.add(this.sealedTo, k, r.id);
    for (const e of unnamed) PayslipIndex.add(this.unnamed, e, r.id);
    for (const a of named) {
      PayslipIndex.count(this.namedBy, r.accountId, a, 1);
      PayslipIndex.count(this.accountsAt, a, r.accountId, 1);
    }
    this.ofRun.set(r.id, { accountId: r.accountId, keys, unnamed, named: [...named] });
  }

  runsSealedTo(key: string): string[] {
    const out = new Set(this.sealedTo.get(key) ?? []);
    for (const e of this.byKey.get(key) ?? []) for (const r of this.unnamed.get(e) ?? []) out.add(r);
    return [...out].sort();
  }
  employeesWithKey(key: string): string[] { return [...(this.byKey.get(key) ?? [])].sort(); }
  addressesNamedBy(accountId: string): string[] { return [...(this.namedBy.get(accountId)?.keys() ?? [])].sort(); }
  accountsNaming(address: string): string[] { return [...(this.accountsAt.get(address)?.keys() ?? [])].sort(); }
}

export class MemoryStore {
  protected data: Shape = emptyShape();

  private payslipIndex: PayslipIndex | null = null;

  /** The payslip index for the data as it is now; see `PayslipIndex`. */
  private payslips(): PayslipIndex {
    if (this.payslipIndex?.builtFrom !== this.data) this.payslipIndex = new PayslipIndex(this.data);
    return this.payslipIndex;
  }

  /** Applied to the index only when one exists for this data; otherwise the next lookup builds it. */
  private indexed(apply: (ix: PayslipIndex) => void) {
    if (this.payslipIndex?.builtFrom === this.data) apply(this.payslipIndex);
  }

  /**
   * **THE RUNS HOLDING A SLIP SEALED TO THIS PUBLIC KEY.** A slip that names its
   * key is found by it; one sealed before slips named their key is found by the
   * roster record that holds the key now. Lower-case hex in, run records out.
   */
  runsWithPayslipsSealedTo(publicKey: string): SealedRun[] {
    return this.payslips().runsSealedTo(publicKey.toLowerCase())
      .map(id => this.data.runs[id]).filter((r): r is SealedRun => r !== undefined);
  }

  /** The roster records whose public key is this one. */
  employeeIdsWithKey(publicKey: string): string[] {
    return this.payslips().employeesWithKey(publicKey.toLowerCase());
  }

  /** Every company address one company's slips name, lower-cased. */
  payslipAddressesNamedBy(accountId: string): string[] {
    return this.payslips().addressesNamedBy(accountId);
  }

  /** The accounts whose contract address is this one, or whose slips name it. */
  accountsAtPayslipAddress(address: string): string[] {
    return this.payslips().accountsNaming(address.toLowerCase());
  }

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

  putAccount(a: SealedAccount) {
    this.data.accounts[a.id] = a; this.observe(a); this.indexed(ix => ix.account(a)); this.flush();
  }
  getAccount(id: string) { return this.data.accounts[id] ?? null; }
  listAccounts() { return Object.values(this.data.accounts); }

  /* Proposals are stored SEALED: approvals[].signerId is the deanonymised
   * version of the nullifiers the chain deliberately blinds. */
  putProposal(p: SealedProposal) { this.data.proposals[p.id] = p; this.observe(p); this.flush(); }
  getProposal(id: string) { return this.data.proposals[id] ?? null; }
  listProposals(accountId: string) {
    return Object.values(this.data.proposals).filter(p => p.accountId === accountId);
  }

  /* Runs are stored SEALED: the amounts live here as well as on the roster. */
  putRun(r: SealedRun) {
    this.data.runs[r.id] = r; this.observe(r); this.indexed(ix => ix.run(r)); this.flush();
  }
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
  putEmployee(e: SealedEmployee) {
    this.data.employees[e.id] = e; this.indexed(ix => ix.employee(e)); this.flush();
  }
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
   * Looked up by the HASH of the token.
   *
   * The caller passes the raw token; nothing here ever stores one. A database
   * backup therefore carries no usable invite, which is what `sessions.ts`
   * already concluded about a credential in a table.
   */
  getInvite(token: string) {
    const hashed = this.data.invites[inviteKeyOf(token)];
    if (hashed) return hashed;
    /*
     * A ROW WRITTEN BEFORE INVITES WERE HASHED.
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
  putVaultKeyIndex(k: CompanyVaultKeyIndex) { this.data.vaultKeyIndex[k.accountId] = k; this.flush(); }
  getVaultKeyIndex(accountId: string): CompanyVaultKeyIndex | null { return this.data.vaultKeyIndex[accountId] ?? null; }
  putFilingKey(k: FilingKeyOfAMember) { this.data.filingKeys[`${k.accountId}:${k.userId}`] = k; this.flush(); }
  getFilingKey(accountId: string, userId: string): FilingKeyOfAMember | null {
    return this.data.filingKeys[`${accountId}:${userId}`] ?? null;
  }

  putAttestation(a: Attestation) { this.data.attestations[a.id] = a; this.flush(); }
  getAttestation(id: string) { return this.data.attestations[id] ?? null; }

  /**
   * The flip, and the only reason this method exists.
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
   * the filesystem allows; under Postgres it becomes one transaction, and this
   * signature is what makes that a change of one method rather than of every
   * caller.
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
    this.indexed(ix => {
      ix.account(set.account);
      for (const e of set.employees) ix.employee(e);
      for (const r of set.runs) ix.run(r);
    });
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
