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
  /**
   * **THIS VAULT IS DEAD AND NO DOOR MAY WORK AGAINST IT.**
   *
   * A vault deployed before a ledger field existed has an on-chain ledger a field
   * SHORT of what this build compiles, and a client reads a vault's fields by
   * counting -- so every read of it is off by one and the note set it hands back
   * is not the note set. That was measured on a live vault.
   *
   * **IT IS HERE BECAUSE IT WAS NOWHERE.** Which vaults were
   * disposed of, repeatedly, and it lived only in conversation: nothing on disk
   * said so, so a rebuild was measured against one of the dead ones and only
   * learned it afterwards. A fact that decides whether a door may touch money
   * belongs in the record the door reads, not in the memory of whoever is awake.
   */
  disposed?: boolean;
  /** Why, for a person, in plain terms. Never load-bearing. */
  disposed_why?: string;
  /** The finalized deploy transaction's public facts, or null when unread. */
  deployTx: Record<string, unknown> | null;
}

export interface VaultRegistry {
  network: string;
  savedAt: string;
  /**
   * **WHICH VAULT IS LIVE.** The one a door uses when nobody names one, so that a
   * door does not pick for itself and get whichever key a JSON object listed
   * first. Absent for a registry written before this was recorded.
   */
  current?: string;
  /**
   * The note beside `current`, for a person: why a live vault is recorded at
   * all. Carried so that writing the record back does not delete it.
   */
  currentWhy?: string;
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
  return {
    network,
    savedAt: String(r.savedAt ?? ''),
    /*
     * **WHICH VAULT A DOOR USES WHEN NOBODY NAMES ONE.** Carried through rather
     * than dropped, because the alternative is every door picking for itself and
     * the answer being whichever key a JSON object happened to list first.
     */
    ...(typeof r._current === 'string' && r._current.length > 0 ? { current: r._current } : {}),
    ...(typeof r._why === 'string' && r._why.length > 0 ? { currentWhy: r._why } : {}),
    vaults: r.vaults as Record<string, VaultEntry>,
  };
}

/**
 * **THE RECORD, SPELLED THE WAY THE FILE SPELLS IT, AND THIS IS NOT TIDINESS.**
 *
 * `parseVaultRegistry` reads `_current` and `_why` into `current` and
 * `currentWhy`, because a leading underscore is how the file marks the keys that
 * are not vaults. **Handing the parsed shape straight to `JSON.stringify` writes
 * `current` instead and the file loses `_current` entirely** -- so the next read
 * finds no live vault, every door stops offering one, and every refusal of a
 * retired vault loses the sentence naming the vault to use instead. The note
 * saying why any of that is recorded goes with it.
 *
 * **THAT IS A WRITER SILENTLY DELETING THE THING THIS RECORD WAS EXTENDED TO
 * CARRY**, one deploy after it was written down. Everything that writes this
 * file goes through here.
 */
export function vaultRegistryForDisk(registry: VaultRegistry): Record<string, unknown> {
  const { current, currentWhy, ...rest } = registry;
  return {
    ...(current === undefined ? {} : { _current: current }),
    ...(currentWhy === undefined ? {} : { _why: currentWhy }),
    ...rest,
  };
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

/* ------------------------------------------------------------------ *
 * TURNING A NAME INTO A VAULT, WHICH IS THE ONE THING EVERY PATH DOES
 * ------------------------------------------------------------------ */

/**
 * **A VAULT RECORDED AS DISPOSED OF IS REFUSED, AND THIS IS WHERE.**
 *
 * A vault can be retired for a reason that is not a shape. The two that are
 * retired today were deployed before a ledger field existed, so their on-chain
 * ledger is a field SHORT of what this build compiles and **a client reads a
 * vault's fields by counting** — every read of one answers about the wrong
 * slot. That particular fault has a mechanism behind it,
 * `assertVaultLedgerIsThisBuilds`, which holds for a vault nobody has got round
 * to marking. **This refusal is for the rest**: a vault emptied and closed, a
 * vault whose authority is gone, a vault superseded by another — none of which
 * a chain read can tell from a healthy one, and all of which are a place to put
 * money that nobody will look at again.
 *
 * **IT IS A REFUSAL AND NOT A WARNING.** Nothing downstream can undo a deposit
 * into a retired vault, and a warning is the thing a person clicks past on the
 * way to the amount.
 */
export function assertTheVaultIsNotDisposed(
  named: string,
  entry: { disposed?: unknown; disposed_why?: unknown },
  /** The vault the record says is live AND still holds, if there is one. */
  current: string | undefined,
): void {
  /*
   * **THE FLAG IS HAND-WRITTEN AND NOTHING IN THIS PRODUCT WRITES IT**, so the
   * ways of getting it slightly wrong are the ways it will be got wrong -- and
   * every one of them slips past a bare `!== true`:
   *
   *   · `"disposed": "true"`, a string, copied out of somewhere that quotes it;
   *   · `disposed_why` written out in full with the flag itself forgotten,
   *     which is the likeliest of all: the two are independent fields and the
   *     reason is the part a person actually wants to write down.
   *
   * **AN ENTRY WE CANNOT READ ON THIS QUESTION IS NOT AN ENTRY THAT SAID
   * ALIVE.** Both refuse, and they say which shape to fix, because the
   * alternative is a record that carries a written reason for being dead and a
   * door that takes a deposit into it anyway.
   */
  if (entry.disposed !== undefined && typeof entry.disposed !== 'boolean') {
    throw new Error(
      `the record of the vault "${named}" says "disposed": ${JSON.stringify(entry.disposed)}, `
      + 'which is not true or false, so this cannot tell whether the vault is retired.\n'
      + 'An unreadable answer to that question is not an answer of "alive". Write it as the '
      + 'bare word true or false, unquoted, and run this again.');
  }
  if (entry.disposed !== true
      && typeof entry.disposed_why === 'string' && entry.disposed_why.trim() !== '') {
    throw new Error(
      `the record of the vault "${named}" carries a reason for being disposed of `
      + `(${entry.disposed_why.trim()}) and does NOT carry "disposed": true.\n`
      + 'A vault with a written reason for being dead is being treated as alive by every door, '
      + 'and a deposit into it is money nowhere anybody will look again. Add "disposed": true '
      + 'beside that reason, or remove the reason if the vault is in fact live.');
  }
  if (entry.disposed !== true) return;
  throw new Error(
    `the vault "${named}" is recorded as DISPOSED OF, so no door works against it`
    /*
     * **THE REASON IS PUNCTUATED HERE RATHER THAN IN THE RECORD.** Somebody
     * writing `disposed_why` will end it with a full stop about half the time,
     * and a refusal that reads "...off it.." is a refusal somebody trusts
     * slightly less than the one before it.
     */
    + `${typeof entry.disposed_why === 'string' && entry.disposed_why.trim() !== ''
      ? `: ${entry.disposed_why.trim().replace(/\.\s*$/, '')}.` : '.'}\n`
    + 'A retired vault still exists on chain and still accepts money, and nothing downstream '
    + 'can give back a deposit made into one. This record is what says it is retired, and this '
    + 'is the record being read.\n'
    + (current === undefined
      ? 'No vault is recorded as the live one, so this cannot say which one you meant. Name it.'
      : `The live vault is "${current}". Run this again and name that one.`));
}

/**
 * **THE ONE PLACE A VAULT NAME BECOMES A VAULT, AND THEREFORE THE ONE PLACE A
 * RETIRED VAULT CAN BE REFUSED FOR EVERY DOOR AT ONCE.**
 *
 * ------------------------------------------------------------------------
 * WHY HERE, AND NOT AT THE SEAM IN FRONT OF THE CALL
 *
 * The obvious place is the function every deposit and every payout resolves the
 * deployed contract through before it builds a call. It is the right place for
 * a fault a chain read can see, and it already refuses one. **It is the wrong
 * place for a fact that exists only in the record**, for two reasons that are
 * not matters of taste:
 *
 *   · **IT IS HANDED AN ADDRESS AND THE RECORD IS KEYED BY NAME.** To refuse
 *     there it would have to go and find the record itself — and a record it
 *     cannot find is a check that PASSES. A guard whose failure mode is silence
 *     leaves everything as it is while everybody believes otherwise, which is
 *     worse than the known gap it replaced.
 *   · **NOT EVERY PATH BUILDS A CALL.** A door that rebuilds a note pool, one
 *     that records where a note came from, and two read-only instruments all
 *     work against a vault and none of them resolves a contract to call it. A
 *     refusal in front of the call does not cover them.
 *
 * **WHAT EVERY PATH DOES DO IS THIS.** A vault's address exists in the record
 * and nowhere else (see §2 above, which is why it is never printed), so
 * every door — the ones that call, the ones that only write a pool, and the
 * instruments — begins by turning a name into an entry. **A check placed here
 * cannot fail open the way one at the seam can: if the record did not load
 * there is no entry, so there is no address, so there is no path.** The absence
 * that would silence the check is the same absence that stops the work.
 *
 * This function is pure, like the rest of this module: the caller opens the
 * file, because the message for a record that is not there differs per door and
 * is worth keeping.
 */
export function theVault(
  registry: VaultRegistry,
  name: string,
  /**
   * **A READ-ONLY POST-MORTEM ON A RETIRED VAULT, WHICH IS A REAL THING TO
   * WANT.** An instrument that asks what a dead vault holds is how anybody ever
   * finds out, and refusing it leaves no way to look.
   *
   * **IT IS A PARAMETER AND NOT AN ENVIRONMENT VARIABLE ON PURPOSE.** A flag
   * read in here would let any door be talked past its own guard by whoever set
   * it. A caller that does not pass this cannot be opted out of the refusal by
   * anything a person types — and `vault-record.test.ts` pins which files pass
   * it, so a door that starts passing it is a test failure rather than a
   * decision nobody saw.
   */
  allowances?: { aReadOnlyPostMortem?: boolean },
): VaultEntry {
  assertVaultName(name);
  const entry = registry.vaults[name];
  if (!entry) {
    const known = Object.keys(registry.vaults);
    throw new Error(
      `this company has no vault called "${name}" on ${registry.network}.\n`
      + (known.length
        ? `The vaults it does have are: ${known.join(', ')}.`
        : 'It has none at all on this network.')
      + '\nA vault is named rather than addressed because a vault\x27s address must never reach '
      + 'a screen, and the record is the only place the two are tied together.');
  }
  if (allowances?.aReadOnlyPostMortem !== true) {
    /*
     * **A REFUSAL WHOSE REMEDY IS ALSO REFUSED IS NOT A REMEDY.** The live
     * pointer and the disposal flags are two independent hand edits, so the
     * record can name a vault that this same function would turn away. When it
     * does, the refusal says there is nothing to fall back to rather than
     * sending somebody round the loop a second time.
     */
    const live = registry.current;
    const liveIsUsable = live !== undefined
      && registry.vaults[live] !== undefined
      && registry.vaults[live]!.disposed !== true;
    assertTheVaultIsNotDisposed(name, entry, liveIsUsable ? live : undefined);
  }
  return entry;
}

/**
 * **THE NAMES THIS RECORD GIVES A VAULT ADDRESS, WHICH IS THE ONE QUESTION ASKED
 * BY ADDRESS RATHER THAN BY NAME.**
 *
 * Asked by a store that must not give a vault a second record: whether this
 * record already keeps it. It answers names and never an entry, so nothing that
 * asks it can reach past the rules `theVault` enforces. Retired vaults are
 * included, because a retired vault's records are still its records. Addresses
 * are compared without regard to case, as hex.
 */
export function namesRecordedFor(registry: VaultRegistry, address: string): string[] {
  const wanted = address.toLowerCase();
  return Object.entries(registry.vaults)
    .filter(([, entry]) => entry.contractAddress.toLowerCase() === wanted)
    .map(([name]) => name);
}

/**
 * **WHICH VAULT SOMEBODY MEANT WHEN THEY PRESSED RETURN.**
 *
 * Using the right vault should be what happens when a person answers nothing,
 * rather than what happens when they remember the name. The record already says
 * which one is live; until now nothing read it.
 *
 * **WHERE THIS IS AND IS NOT USED, AND THE LINE IS DRAWN AT THE MONEY.** A door
 * that moves money keeps its deliberate absence of a default: putting
 * money into the wrong vault is not a mistake anything downstream can detect,
 * so that answer is typed out every time. A door that reads, or that writes a
 * record about a vault, has no such cost and gets the default.
 *
 * A blank answer with no live vault recorded is a refusal naming what fixes it,
 * never a guess: picking for ourselves is how a door ends up working against
 * whichever key a JSON object happened to list first.
 */
export function theVaultNameMeant(registry: VaultRegistry, asked: string): string {
  const trimmed = asked.trim();
  if (trimmed !== '') return trimmed;
  if (registry.current !== undefined) return registry.current;
  throw new Error(
    `no vault name was given, and the record of ${registry.network} vaults does not say which `
    + 'one is live, so there is nothing to fall back to and this will not pick one for you.\n'
    + (Object.keys(registry.vaults).length
      ? `The vaults it knows are: ${Object.keys(registry.vaults).join(', ')}. Name one.`
      : 'It knows of none at all on this network.'));
}

/**
 * **IS THIS NAME ALREADY A VAULT?** Asked before a deploy spends anything, and
 * it is a different question from `theVault`: the answer that matters is YES or
 * NO, and a caller asking it has no business with an address.
 *
 * **SO IT HANDS BACK NO ADDRESS**, only when the existing vault was deployed,
 * which is the one fact the refusal needs to be believable. `addVault` refuses a
 * taken name after the deploy as well, and that is the net that matters --
 * discovering it there means a deployed contract with nowhere to be recorded, so
 * anything knowable up front is asked up front.
 *
 * **AND IT EXISTS SO THAT NOTHING OUTSIDE THIS MODULE HAS A REASON TO INDEX THE
 * MAP OF VAULTS ITSELF**, which is the habit that let two doors drift outside
 * every rule this record enforces.
 */
export function whenThisNameWasTaken(
  registry: VaultRegistry, name: string,
): { deployedAt: string } | undefined {
  const existing = registry.vaults[assertVaultName(name)];
  return existing === undefined ? undefined : { deployedAt: existing.deployedAt };
}
