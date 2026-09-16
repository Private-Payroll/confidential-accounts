import { existsSync, readFileSync } from 'node:fs';
import { authorityFileIn } from '../src/midnight/authority-file.js';
import { vaultAuthorityFile } from '../src/midnight/vault-record.js';
import { readContractAuthority, type ContractStateReader } from '../src/midnight/ledger.js';
import { heldKeyFundingRefusal } from '../src/wiring/vault-submission.js';
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

/** The sentence that stops a funding door, or null when the chain says the vault may be funded. */
export async function refusalToFund(input: {
  readonly vault: string;
  readonly vaultName: string;
  readonly readState: ContractStateReader;
  readonly held: readonly CommitteeKey[];
}): Promise<string | null> {
  const read = await readContractAuthority(input.readState, input.vault);
  return heldKeyFundingRefusal(read, input.held, input.vaultName);
}
