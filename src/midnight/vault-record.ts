/**
 * WHAT IS WRITTEN DOWN WHEN A VAULT IS CREATED, AND WHERE.
 *
 * The account has one deployment and one file: `.midnight/<network>-contract.json`,
 * written by `scripts/deploy-preview.ts`. **A company has MANY vaults**, so a
 * vault cannot borrow that shape, and the three questions the account's record
 * never had to answer are answered here.
 *
 * ------------------------------------------------------------------------
 * 1. WHERE THE SET LIVES, AND WHY IT IS ONE FILE RATHER THAN ONE PER VAULT
 *
 * `.midnight/<network>-vaults.json`, a map from NAME to entry. One file,
 * because the question an operator asks is *"which vaults does this company
 * have"* and a directory listing answers it only by accident; and because the
 * one operation that must be atomic is **adding a vault without losing the
 * others**, which a single read-modify-write can be made to refuse and a
 * scattering of files cannot.
 *
 * Per network, exactly as the account's record is: a contract address is
 * meaningless on another chain, and Stagenet is wiped on a schedule.
 *
 * ------------------------------------------------------------------------
 * 2. HOW A VAULT IS NAMED, AND WHY IT IS NOT NAMED BY ITS ADDRESS
 *
 * By a slug the operator chooses — `payroll-uk`, `contractors`, `alice`.
 * Three reasons, and the first two are the ones that decide it:
 *
 *   · **The name has to exist BEFORE the address does.** The maintenance
 *     authority is chosen before the deploy — that is the whole of `C225` —
 *     and a file keyed by address cannot be written until after the deploy has
 *     already used it. So the choice is filed under the name, and the address
 *     joins it afterwards.
 *   · **`C236`: A VAULT'S RAW ADDRESS MUST NEVER REACH A SCREEN.** A filename
 *     is a screen — it is in every listing, every error, every backup log. A
 *     file called `vault-authority-<64 hex>.json` puts the one value that
 *     destroys money in front of somebody every time they open a folder.
 *   · A person reads `payroll-uk` and knows which pot of money they are looking
 *     at. Nobody reads 32 bytes of hex and knows anything.
 *
 * **AND NOT A TRUNCATED ADDRESS EITHER, anywhere, for the same reason.** A
 * shortened address is still an address to somebody who can go and find the
 * rest, and it looks exactly like a thing to paste into a wallet — which is the
 * single action that strands a vault's money permanently and that no contract
 * can refuse.
 *
 * ------------------------------------------------------------------------
 * 3. TWO VAULTS FOR THE SAME PURPOSE
 *
 * **They are two vaults, they get two names, and the record REFUSES to write
 * the second over the first.** This is the money rule of this file.
 *
 * Deploying a vault called `payroll-uk` when one already exists produces a
 * SECOND contract at a NEW address. The first is untouched: still deployed,
 * still holding whatever it holds, still spendable — *by anyone who knows its
 * address*. That address exists in exactly one place. Overwriting the entry
 * therefore does not replace a vault; it forgets one, and forgetting a vault's
 * address is losing its money with the money still visibly on chain.
 *
 * So `addVault` throws on a name that is taken, and says what to do: pick
 * another name for the new one, or — if the first really is finished with —
 * move its entry aside deliberately, the same manual step `S9` made step zero
 * for the account's authority file, because no code can tell stale from
 * precious.
 *
 * ------------------------------------------------------------------------
 * 4. WHERE THE AUTHORITY CHOICE IS RECORDED, GIVEN THERE ARE MANY
 *
 * `.midnight/vault-authority-<name>.json`, **one per vault**, beside
 * `.midnight/maintenance-authority.json` which is and stays the ACCOUNT's.
 * Gitignored with the rest of `.midnight/`, because in `single-key` mode the
 * file holds key material.
 *
 * **EACH VAULT CHOOSES ITS OWN. One choice does NOT cover a company's account
 * and all its vaults**, and the reasoning is worth keeping because the cheaper
 * answer is genuinely tempting:
 *
 *   · One key over every pot of money means one compromise, or one lost file,
 *     reaches all of them at once. The whole argument for many vaults is that
 *     two payments out of different pots have nothing to say to each other;
 *     a shared authority puts that back.
 *   · The account's key is already recorded as a TEMPORARY state, with a
 *     `fixedBy` naming the round that replaces it. Reusing it for vaults would
 *     silently extend a temporary decision to contracts that did not exist when
 *     it was taken — and the round that replaces the account's deployment would
 *     then be replacing every vault's authority as a side effect nobody wrote
 *     down.
 *   · A per-vault file inherits `S9`'s move-aside discipline for free: a stale
 *     file is refused per vault rather than silently inherited by all of them.
 *
 * **What it costs, stated rather than engineered around:** N keys to hold and
 * back up instead of one, and N chances to lose one. Losing a vault's authority
 * file means that vault can never be maintained — it does NOT mean its money is
 * stuck, because maintenance changes which proofs the contract accepts and
 * nothing about spending. That asymmetry is why the cost is acceptable and it
 * is the reason to prefer it, not a consolation.
 *
 * ------------------------------------------------------------------------
 * This module is PURE. It builds paths, validates names and merges records; it
 * opens no file. `scripts/deploy-vault.ts` does the I/O, so both halves can be
 * tested without one.
 */
import type { MaintenanceAuthorityDescription } from './partial-contract.js';

/**
 * A vault name a person chose.
 *
 * Lowercase, digits and single hyphens, 2–48 characters, starting and ending
 * with an alphanumeric. Narrow on purpose: this string becomes a filename and a
 * JSON key, and a name carrying a slash, a dot or a space is a name that can
 * escape a directory or shadow another entry. `..` and `.` cannot be spelled
 * under this rule, which is the point.
 */
const NAME_RULE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,47}$/;

export function assertVaultName(name: string): string {
  if (typeof name !== 'string' || !NAME_RULE.test(name)) {
    throw new Error(
      `"${String(name)}" is not a usable vault name. A vault is named for the person or the ` +
        'purpose it pays — payroll-uk, contractors, alice — in lowercase letters, digits and ' +
        'single hyphens, 2 to 48 characters, starting and ending with a letter or digit.\n' +
        'It is narrow because the name becomes a FILENAME and a record key: a name carrying a ' +
        'slash, a dot or a space is one that can escape a directory or shadow another vault. ' +
        'And it is a name rather than an address because a vault\'s address must never reach a ' +
        'screen — C236.',
    );
  }
  return name;
}

/** Where the PUBLIC halves a vault's pool is sealed to are recorded. Keyed by NAME. */
export const vaultPoolSignersFile = (stateDir: string, name: string): string =>
  `${stateDir}/vault-pool-signers-${assertVaultName(name)}.json`;

/**
 * THE IDS A VAULT'S TEST SIGNERS GET, AND WHY THEY CARRY THE VAULT'S NAME.
 *
 * The mint used to hand every vault the ids `test-signer-1..N` and
 * write the secret halves into ONE shared file keyed by id. So the second
 * vault's run overwrote the first vault's secrets in place, under the same
 * names — and **the sealed pool record names its signers by ID and never by
 * public key**, so no code anywhere could compare the two and notice. The pool
 * key is the only record of a note's nonce, colour and value and a
 * commitment on chain cannot be inverted to recover them, so the result is
 * money on chain that nobody can describe.
 *
 * **IT HAD ALREADY FIRED TWICE BEFORE ANYBODY LOOKED**, measured on disk
 * 31 Aug: `vault-pool-signers-payroll-test-1.json` names three public keys
 * whose secret halves are on that machine nowhere, and that pool is unopenable
 * today. It holds nothing, so nothing was lost.
 *
 * **TWO RULES, NOT ONE, AND THAT IS DELIBERATE.** Scoping the id to the vault
 * makes the collision unreachable; refusing an id that already has a secret is
 * what catches it if a later edit makes it reachable again. *The branch is not
 * taken* and *there is no branch* are different claims, and only the second
 * survives a refactor — so this makes both, and a test can hold each.
 *
 * It is a pure function over the ids that already exist BECAUSE the door that
 * needs it runs as a generated script: a rule that lives only inside a heredoc
 * is a rule no test can reach.
 */
export function mintedSignerIds(
  vaultName: string, count: number, existingIds: readonly string[],
): string[] {
  const name = assertVaultName(vaultName);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `"${String(count)}" is not a number of signers. A pool wrapped to nobody is ciphertext ` +
        'with no key in the world, and `sealPool` refuses it (V-91).',
    );
  }
  const taken = new Set(existingIds);
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `${name}-signer-${i}`;
    if (taken.has(id)) {
      throw new Error(
        `a secret is already recorded for "${id}", and this refuses to write over it.\n\n` +
          "A pool is sealed under a key wrapped to each signer's PUBLIC key, and the sealed " +
          'record names the signer by ID and nothing else. Replacing the secret behind an id ' +
          'leaves every pool wrapped to the old key openable by nobody, with nothing on chain ' +
          "or on disk to say so — and a pool key is the only record of a note's nonce, colour " +
          'and value (C284), which a commitment on chain cannot be inverted to recover. C275.' +
          `\n\nIf these signers really must be replaced for "${name}", that is a RE-SEAL of ` +
          "that vault's pool by somebody who can already open it, not an edit of a key file. " +
          'There is no door for it today and this refusal is not going to pretend otherwise.',
      );
    }
    ids.push(id);
  }
  return ids;
}

/** Where one vault's maintenance-authority choice is recorded. Keyed by NAME. */
export const vaultAuthorityFile = (stateDir: string, name: string): string =>
  `${stateDir}/vault-authority-${assertVaultName(name)}.json`;

/** Where the set of a company's vaults on one network is recorded. */
export const vaultRegistryFile = (stateDir: string, network: string): string =>
  `${stateDir}/${network}-vaults.json`;

/**
 * One vault, as the record holds it.
 *
 * `contractAddress` is here because it must be: it is how the client reaches
 * the vault, and it exists nowhere else once the deploying process exits.
 * **It is written and never printed** — see `describeVaultForReport`.
 */
export interface VaultEntry {
  name: string;
  /** Free text, for a person: "the UK payroll pot". Never load-bearing. */
  purpose?: string;
  /** RECORDED, NEVER DISPLAYED. */
  contractAddress: string;
  /** The account this vault is married to, pinned in its ledger at creation. V-37. */
  accountAddress: string;
  deployedAt: string;
  /** What the deployed operations map carries, read back from it — not typed in. */
  circuits: string[];
  /** Shape only: kind, committee size, threshold, and for a single key its fixedBy. */
  maintenanceAuthority: MaintenanceAuthorityDescription;
  /**
   * Whether the account has adopted this vault, as far as this record knows.
   *
   * **A RECORD, NOT AN AUTHORISATION, and the distinction is the contract's
   * own.** `adopt` inserts into the account's `vaults` set and NOTHING consults
   * it before authorising a payment — `recordPayment` does not, deliberately
   * (`ConfidentialAccount.compact`, the note above `retireVault`). So this
   * field can be wrong in either direction without any money moving that
   * should not have. It is here because `C127`'s shape is the reason `vaults`
   * exists at all: a vault that has been FUNDED and has never PAID appears
   * nowhere on chain, and a company that lost its devices could not find it.
   */
  adopted: boolean;
  /** The finalized deploy transaction's public facts, or null when unread. */
  deployTx: Record<string, unknown> | null;
}

export interface VaultRegistry {
  network: string;
  savedAt: string;
  vaults: Record<string, VaultEntry>;
}

export const emptyVaultRegistry = (network: string): VaultRegistry =>
  ({ network, savedAt: new Date().toISOString(), vaults: {} });

/**
 * Reads a registry off whatever `JSON.parse` produced, refusing anything that
 * is not one.
 *
 * A file that will not parse into this shape is NOT an empty registry. The
 * difference is the same one `vault-pool.ts` keeps: an empty record claims the
 * company has no vaults, and a damaged one is our ignorance — and answering the
 * first when the second is true is how a deploy writes over an entry it could
 * not read.
 */
export function parseVaultRegistry(raw: unknown, network: string): VaultRegistry {
  const r = raw as any;
  if (r == null || typeof r !== 'object' || typeof r.vaults !== 'object' || r.vaults === null) {
    throw new Error(
      'the vault registry did not parse into a registry. **This is not an empty registry** — ' +
        'an empty one is a claim that this company has no vaults, and an unreadable one is our ' +
        'ignorance. Writing a new vault into it now would replace the record of every vault ' +
        'this company has, and a vault whose address is forgotten is money on chain that ' +
        'nobody can reach. Restore the file from a backup before deploying anything.',
    );
  }
  if (typeof r.network === 'string' && r.network !== network) {
    throw new Error(
      `this registry records ${r.network} vaults and the deploy is on ${network}. A contract ` +
        'address is meaningless on another chain; the file is per network for that reason.',
    );
  }
  return { network, savedAt: String(r.savedAt ?? ''), vaults: r.vaults as Record<string, VaultEntry> };
}

/**
 * Adds a vault to the registry, or refuses because the name is taken.
 *
 * Returns a NEW registry; the input is not mutated, so a caller cannot half-add
 * a vault and then fail on the write.
 *
 * **THE REFUSAL IS THE POINT OF THIS FUNCTION.** See §3 in the header: a second
 * vault of the same name is a second CONTRACT, and overwriting the entry does
 * not replace a vault — it forgets one, with its money still on chain.
 */
export function addVault(registry: VaultRegistry, entry: VaultEntry): VaultRegistry {
  assertVaultName(entry.name);
  const existing = registry.vaults[entry.name];
  if (existing) {
    throw new Error(
      `this company already has a vault called "${entry.name}" on ${registry.network}, deployed ` +
        `${existing.deployedAt}, and writing this one over it would LOSE THE FIRST VAULT'S ` +
        'ADDRESS.\n\n' +
        'The vault just deployed is a different contract at a different address. The old one is ' +
        'still deployed and still holds whatever it holds — and its address exists in this file ' +
        'and nowhere else, so forgetting it is losing its money with the money visibly on ' +
        'chain.\n\n' +
        'Two vaults for the same purpose are two vaults: give this one its own name. If the ' +
        'first really is finished with, move its entry aside deliberately first — no code can ' +
        'tell a stale record from a precious one, which is why this refuses instead of ' +
        'guessing.',
    );
  }
  return {
    ...registry,
    savedAt: new Date().toISOString(),
    vaults: { ...registry.vaults, [entry.name]: entry },
  };
}

/**
 * Replaces an entry that is already there, and refuses one that is not.
 *
 * **THE MIRROR OF `addVault`, AND SEPARATE FROM IT FOR THE REASON
 * `SealedNotePool` KEEPS `create` AND `save` APART**: creating and advancing
 * are different acts, and only one of them is allowed to invent a vault.
 *
 * The deploy uses both, in this order and never the other: the address is
 * recorded with `addVault` the moment the deploy lands — a vault we deployed
 * and did not write down is money nobody can reach — and the fee, the block and
 * the transaction id are added afterwards with this, because they come from a
 * read-back that is allowed to fail. Calling `addVault` twice would refuse the
 * second write, correctly, and lose the measurement; calling this first would
 * refuse to record the address at all.
 */
export function updateVault(registry: VaultRegistry, entry: VaultEntry): VaultRegistry {
  assertVaultName(entry.name);
  const existing = registry.vaults[entry.name];
  if (!existing) {
    throw new Error(
      `there is no vault called "${entry.name}" on ${registry.network} to update. Recording one ` +
        'here would create a vault record out of a single later step — and a record that begins ' +
        'midway through a deploy is one whose earlier facts nothing checked. addVault is what ' +
        'creates an entry, at the moment the address exists.',
    );
  }
  if (existing.contractAddress !== entry.contractAddress) {
    /*
     * THE ADDRESS IS THE ONE THING AN UPDATE MAY NOT CHANGE. Anything else about
     * a vault can be re-read; the address exists in this file and nowhere else,
     * and an update that moved it would forget a deployed contract while looking
     * like bookkeeping.
     */
    throw new Error(
      `refusing to change the recorded address of "${entry.name}". An update may add what a ` +
        'read-back learned — the fee, the block, the transaction — and may not move the vault ' +
        'it describes: that address exists in this file and nowhere else, and replacing it ' +
        'forgets a deployed contract with its money still on chain.',
    );
  }
  return {
    ...registry,
    savedAt: new Date().toISOString(),
    vaults: { ...registry.vaults, [entry.name]: entry },
  };
}

/**
 * What a report, a console or a screen may say about a vault.
 *
 * **THE ADDRESS IS NOT IN IT, AND THAT IS THE WHOLE FUNCTION.** A shielded
 * output addressed to a vault without a `deposit` call is money on chain that
 * nobody can ever spend, and no contract can refuse it — `deposit` does
 * `receiveShielded` AND `notes.insert` in one transaction, and a plain send
 * does the first only. Showing the address invites the one action that destroys
 * money, and somebody who has used any other chain will paste it into a wallet
 * without asking. There is no "here's your vault address, wire funds to it"
 * flow and there never can be.
 *
 * A vault is therefore identified to people by its NAME. Anything that needs
 * the address gets it from the record, in code.
 *
 * `src/midnight/vault-record.test.ts` asserts of these lines that they contain
 * neither the vault's address nor any substring of it long enough to be worth
 * having — because the failure this prevents is somebody adding a "just the
 * first eight characters, for support" line, and nothing objecting.
 */
export function describeVaultForReport(entry: VaultEntry): string[] {
  const a = entry.maintenanceAuthority;
  return [
    `vault                 ${entry.name}${entry.purpose ? `  — ${entry.purpose}` : ''}`,
    `deployed              ${entry.deployedAt}`,
    `circuits              ${entry.circuits.join(', ')}`,
    `maintenance authority ${a.kind} — committee of ${a.committeeSize}, threshold ${a.threshold}` +
      (a.fixedBy ? `  (TEMPORARY, replaced by: ${a.fixedBy})` : ''),
    `adopted by the account ${entry.adopted ? 'yes' : 'not yet — adopt is a governed round on the account'}`,
    'address               NOT SHOWN, AND NEVER WILL BE. C236: a plain send to a vault\'s',
    '                      address is money on chain that nobody can spend, permanently, and',
    '                      no contract can refuse it. Funding a vault is a deposit CALL.',
  ];
}
