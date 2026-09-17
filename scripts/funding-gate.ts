import { existsSync, readFileSync } from 'node:fs';
import { authorityFileIn } from '../src/midnight/authority-file.js';
import { vaultAuthorityFile } from '../src/midnight/vault-record.js';
import { readContractAuthority, type ContractStateReader } from '../src/midnight/ledger.js';
import { refusalToPutMoneyIn } from '../src/wiring/vault-submission.js';
import type { CommitteeKey } from '../src/midnight/vault-committee.js';

/**
 * **NO OPERATOR TOOL FUNDS A VAULT WHOSE RULES ARE STILL A KEY THIS MACHINE
 * HOLDS, AND WHO HOLDS THEM IS READ FROM THE CHAIN.**
 *
 * The files below are read for one thing only: which signing keys this
 * machine keeps, so that a committee containing one of them is refused too.
 * They never say who holds the vault's rules. The chain does, at the moment of
 * funding, and a chain that cannot be asked is a refusal.
 */

/** The verifying keys of every maintenance key this machine keeps in its state folder, for this vault and for the account. */
export function keysThisMachineHolds(
  root: string, stateDir: string, vaultName: string,
  verifyingKeyOf: (signingKey: CommitteeKey) => CommitteeKey,
  read: (path: string) => string | null = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
): CommitteeKey[] {
  const out: CommitteeKey[] = [];
  for (const path of [vaultAuthorityFile(stateDir, vaultName), authorityFileIn(root)]) {
    const text = read(path);
    if (text === null) continue;
    let parsed: { kind?: unknown; signingKey?: unknown };
    try { parsed = JSON.parse(text); } catch { continue; }
    const key = parsed.signingKey as CommitteeKey | undefined;
    if (parsed.kind === 'single-key' && key && typeof key.tag === 'string' && typeof key.value === 'string') {
      out.push(verifyingKeyOf(key));
    }
  }
  return out;
}

/**
 * **THE SENTENCE THAT STOPS AN OPERATOR FUNDING DOOR**, or `null` when the
 * chain says money may go into this vault.
 *
 * **IT ASKS THE SAME FUNCTION THE PRODUCT'S OWN DOORS ASK** -
 * `refusalToPutMoneyIn` - and it asks about the VAULT and about the ACCOUNT
 * THAT VAULT PAYS OUT ON. A tool that read only the vault's rules would fund a
 * vault handed to its committee while the account every payment is approved by
 * was still held by a temporary key on this machine, which is the machine
 * holding the key deciding where the money goes.
 *
 * **THIS DOOR HAS NO COMPANY ROSTER**, so it cannot compare the chain against a
 * committee. It asks the stricter structural question instead, which is what
 * `committee: null` means to the gate.
 *
 * **WHAT THIS DOOR DOES NOT READ, STATED HERE RATHER THAN LEFT TO BE NOTICED:**
 * neither the vault's circuits nor the account's are read by an operator tool,
 * because the verifying keys they compare against are built by a separate job
 * and cost a minute and a hundred megabytes. Those two conditions are passed as
 * `null`, which the gate reads as *this build's*. **A vault at an address that
 * is not this build's vault therefore passes this door and is refused by the
 * product's**, and nothing here closes that.
 */
export async function refusalToFund(input: {
  readonly vault: string;
  readonly vaultName: string;
  /** The account this vault is pinned to in its ledger, from the vault's own record. */
  readonly account: string;
  readonly readState: ContractStateReader;
  readonly held: readonly CommitteeKey[];
  /**
   * **THE ACCOUNT THE VAULT'S LEDGER PINS, READ FROM THE CHAIN.** `null` when
   * the state at that address cannot be read as a vault's, which is a refusal.
   * Required, and never defaulted to the account being asked about: comparing a
   * value with itself is a condition that cannot fail, and it read as a
   * condition that was being run.
   */
  readonly pinnedAccount: string | null;
  /**
   * **THE CALLER'S READING OF THE VAULT'S CIRCUITS AGAINST THIS BUILD'S**,
   * `null` only when the caller has read them and they are this build's.
   *
   * Required rather than optional, so that a door which does not read them has
   * to say so at its own call site instead of inheriting a pass. **AN OPERATOR
   * TOOL PASSES `null` WITHOUT READING**, and that is a gap, not a check: see
   * the note at each call site.
   */
  readonly vaultCircuits: string | null;
  /** The same for the account's circuits. */
  readonly accountCircuits: string | null;
}): Promise<string | null> {
  const [vault, account] = await Promise.all([
    readContractAuthority(input.readState, input.vault),
    readContractAuthority(input.readState, input.account),
  ]);
  return refusalToPutMoneyIn({
    label: input.vaultName,
    what: `vault '${input.vaultName}' is not funded`,
    vault,
    vaultCircuits: input.vaultCircuits,
    pinnedAccount: input.pinnedAccount,
    companyAccount: input.account,
    account,
    accountCircuits: input.accountCircuits,
    committee: null,
    heldHere: input.held,
  })?.why ?? null;
}
