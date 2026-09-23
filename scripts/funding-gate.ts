import { existsSync, readFileSync } from 'node:fs';
import { authorityFileIn } from '../src/midnight/authority-file.js';
import { vaultAuthorityFile } from '../src/midnight/vault-record.js';
import { readContractAuthority, type ContractStateReader } from '../src/midnight/ledger.js';
import { circuitsRefusal, refusalToPutMoneyIn } from '../src/wiring/vault-submission.js';
import type { CommitteeKey } from '../src/midnight/vault-committee.js';
import { DEPLOYED_CIRCUITS } from '../src/midnight/deferral.js';
import { NotAVaultsState, vaultAccountFromTheIndexer } from '../src/server/vault-records-authority.js';
import { accountVerifierKeysIn, vaultVerifierKeysIn } from '../src/server/vault-chain.js';

/** Every circuit's verifying key as this build compiled it, loaded when first asked. */
export type VerifierKeys = () => Promise<ReadonlyMap<string, Uint8Array>>;

/**
 * **THIS BUILD'S VERIFYING KEYS, THE VAULT'S AND THE ACCOUNT'S, READ FROM THE
 * BUILD'S OWN ARTEFACTS UNDER `root`** by the same two readers the product's
 * server uses, so an operator door and the product compare a contract against
 * the same bytes. They are small files the build has already written; reading
 * them builds nothing.
 */
export const thisBuildsVerifierKeys = (root: string): { vault: VerifierKeys; account: VerifierKeys } => ({
  vault: vaultVerifierKeysIn(root),
  account: accountVerifierKeysIn(root),
});

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
 * **EVERY FACT IT HANDS THE GATE IS READ HERE, FROM THE CHAIN, AND NONE IS
 * THE CALLER'S TO STATE.** Who holds each contract's rules; each contract's
 * circuits against the verifying keys this build compiled; and the account the
 * vault's own ledger pins, read by the same reader the product's records route
 * uses. A caller cannot pass *this build's* for a contract nobody compared.
 *
 * Each address is read once and every fact about it comes from that one
 * answer, so two facts about one contract are never two moments of it.
 */
export async function refusalToFund(input: {
  readonly vault: string;
  readonly vaultName: string;
  /** The account this vault is pinned to in its ledger, from the vault's own record. */
  readonly account: string;
  readonly readState: ContractStateReader;
  readonly held: readonly CommitteeKey[];
  /**
   * **THIS BUILD'S VERIFYING KEYS, FOR THE VAULT'S CIRCUITS AND THE ACCOUNT'S.**
   * Required: a door that cannot say what this build compiled cannot say a
   * contract runs it. `thisBuildsVerifierKeys(root)` is what the scripts pass.
   */
  readonly verifierKeys: { readonly vault: VerifierKeys; readonly account: VerifierKeys };
}): Promise<string | null> {
  const what = `vault '${input.vaultName}' is not funded`;
  const asked = new Map<string, Promise<unknown>>();
  const readOnce: ContractStateReader = (address) => {
    let answer = asked.get(address);
    if (answer === undefined) {
      answer = Promise.resolve().then(() => input.readState(address));
      asked.set(address, answer);
    }
    return answer;
  };
  const [vault, account] = await Promise.all([
    readContractAuthority(readOnce, input.vault),
    readContractAuthority(readOnce, input.account),
  ]);

  let vaultKeys: ReadonlyMap<string, Uint8Array>;
  let accountKeys: ReadonlyMap<string, Uint8Array>;
  try {
    [vaultKeys, accountKeys] = await Promise.all([input.verifierKeys.vault(), input.verifierKeys.account()]);
  } catch (e) {
    return `${what}: this build's verifying keys could not be read (${(e as Error)?.message ?? String(e)}), `
      + 'so it cannot check that this vault and its account run this build\'s circuits. '
      + 'Build both contracts with their proving keys, then run this again. Nothing was sent.';
  }
  /* A state that could not be fetched has no circuits to read; the gate has already refused on who holds it. */
  const stateOf = async (address: string): Promise<unknown> => {
    try { return await readOnce(address); } catch { return null; }
  };

  /*
   * **THE PIN, READ BY THE READER THE PRODUCT'S RECORDS ROUTE USES, OVER THE
   * SAME ANSWER.** A state that is not a vault's is `null`, which the gate
   * refuses. A chain that could not be asked is never turned into *not a
   * vault*: it is already the vault's rules read as unanswered, which the gate
   * refuses first, and if the vault's rules were read it is thrown.
   */
  let pinnedAccount: string | null;
  try {
    pinnedAccount = await vaultAccountFromTheIndexer(
      { queryContractState: readOnce as (address: string) => Promise<{ data: unknown } | null> },
    )(input.vault as never);
  } catch (e) {
    if (!(e instanceof NotAVaultsState) && vault.state === 'read') throw e;
    pinnedAccount = null;
  }

  return refusalToPutMoneyIn({
    label: input.vaultName,
    what,
    vault,
    vaultCircuits: circuitsRefusal(await stateOf(input.vault), vaultKeys, what),
    pinnedAccount,
    companyAccount: input.account,
    account,
    accountCircuits: circuitsRefusal(
      await stateOf(input.account), accountKeys,
      `${what}, because of the account it pays out on`,
      DEPLOYED_CIRCUITS, 'the account\'s'),
    committee: null,
    heldHere: input.held,
  })?.why ?? null;
}
