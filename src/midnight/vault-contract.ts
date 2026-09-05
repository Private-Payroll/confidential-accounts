/**
 * THE VAULT'S DEPLOY, AND THE FIND THAT SERVES IT. S6e.
 *
 * The account is deployed through the PARTIAL path — eleven of the eleven it
 * compiles since S23's shed and S25's empty deferred list, eleven of thirteen
 * before them —
 * and `src/midnight/partial-contract.ts` exists, in every line, for that. **The
 * vault is a FULL one.** Every circuit `Vault.compact` compiles is deployed —
 * `VAULT_CIRCUITS` below is the list, and it is read off the compiler's own
 * answer rather than transcribed. So nothing here defers,
 * nothing here prunes an operations map, and nothing here is reused from the
 * account's deploy except the one thing that is not about partiality at all:
 * the maintenance-authority choice, which is `deployContract`'s own default and
 * is therefore the FULL path's defect before it is anybody else's.
 *
 * ------------------------------------------------------------------------
 * WHICH FIND THE VAULT USES, AND WHY IT IS NEITHER OF THE TWO THAT EXIST
 *
 * **NOT `findDeployedPartialContract`.** It refuses a FULL deployment on
 * purpose (`C231`): a contract carrying a name in `DEFERRED_CIRCUITS` is not
 * the deployment that client serves. Correct for the account. Pointed at a
 * vault it would be wrong in the most confusing possible way — the vault's
 * circuits are not in either of the account's lists, so the failure would be a
 * verifier-key comparison against circuit names the vault has never had.
 *
 * **NOT the SDK's `findDeployedContract` either, and this is the half that is
 * easy to get wrong.** It would compare the right keys. It also calls
 * `setOrGetInitialSigningKey` (`midnight-js-contracts/dist/index.mjs:
 * 1951-1963`), which — when the private-state store holds no signing key for
 * the address — **SAMPLES ONE AND STORES IT UNDER THE VAULT'S ADDRESS.** That
 * key is not the vault's maintenance authority: the deployed contract's
 * authority was fixed by the deploy, and this one was invented afterwards on
 * a device that merely READ the contract. A later `replaceAuthority` reads
 * exactly that slot (`:547`) and would build an update the chain refuses. So
 * the find that a mere reader runs must not write a key at all. `M-155`.
 *
 * **What the vault's find does instead**, and it keeps every property the
 * account's find keeps: read the state, refuse when there is none, check the
 * operations map is EXACTLY this contract's own circuits in both directions,
 * compare the deployed verifier keys byte-for-byte against the compiled ones
 * through the SDK's OWN `verifyContractState` (`M-9`), and build the call
 * interface. It stores nothing and it samples nothing.
 *
 * ------------------------------------------------------------------------
 * WHY THE DEPLOY IS THE SDK'S ORDINARY `deployContract`
 *
 * Because the vault deploys whole. `submitPartialDeployTx` builds a contract
 * state by hand for one reason — `setOperation` cannot remove, so a partial
 * operations map has to be rebuilt — and a vault has nothing to remove.
 * Reusing it here would hand-build a state the SDK can build correctly, for a
 * deployment nobody asked to be partial, and would put the contract that holds
 * the money on the path with the most hand-written steps in this repository.
 *
 * ------------------------------------------------------------------------
 * C228, ANSWERED TWICE OVER
 *
 * Private state is filed under `${contractAddress}:${privateStateId}` and the
 * address half is a mutable closure variable
 * (`midnight-js-level-private-state-provider/dist/index.mjs:767-778`). `C228`'s
 * row says it worked only because exactly one contract had ever been addressed.
 * **This module addresses the second.**
 *
 *   1. **THE VAULT HAS NO SDK PRIVATE STATE, DELIBERATELY.** Nothing here
 *      passes a `privateStateId`, so the SDK writes none and reads none —
 *      `submitDeployTx` only writes one when `'privateStateId' in options`
 *      (`index.mjs:1181-1183`), and `createCallTxOptions` only carries one when
 *      it is given (`:1862`). The vault's single witness, `noteToSpend`, reads
 *      the note POOL — sealed, wrapped per signer, keyed by vault address in
 *      `src/midnight/vault-pool.ts` — and hands the runtime's private state
 *      straight back untouched (`src/midnight/vault-notes.ts`,
 *      `witnessesOver`). There is therefore no vault view for a second vault to
 *      read, which is a stronger answer than addressing one carefully.
 *   2. **AND THE ADDRESS IS SET FROM THE VAULT THE CALL IS FOR, BEFORE EVERY
 *      ACCESS ANYWAY.** `addressVaultPrivateState` below is called at the top
 *      of the find and immediately after the deploy, so no vault operation ever
 *      inherits whichever address an account entry point happened to leave
 *      behind, and no account operation inherits a vault's. It costs one call
 *      and it is the rule `C228`'s row states; property (1) is what makes the
 *      rule cheap to keep, not a reason to skip it.
 *
 * `src/midnight/vault-contract.test.ts` proves both against a fake provider
 * that MIRRORS the level store's addressing semantics — the closure variable,
 * the composed key, the throw when no address was ever set — per `T-34`,
 * because a stub without the semantics could not fail the way the product
 * would.
 */
import {
  requireMaintenanceAuthority, describeMaintenanceAuthority,
  type MaintenanceAuthorityChoice, type MaintenanceAuthorityDescription,
} from './partial-contract.js';

export type {
  MaintenanceAuthorityChoice, MaintenanceAuthorityDescription,
} from './partial-contract.js';

/* ------------------------------------------------------------------ *
 * which circuits a vault has — the vault's own list, not the account's
 * ------------------------------------------------------------------ */

/**
 * The circuits `contracts/src/Vault.compact` compiles, and all of them deploy.
 *
 * **SEVEN SINCE `S6j`**, which added `depositUnshielded`, `payoutUnshielded`
 * and `forgetUnshielded` so the vault could hold the token the product launches
 * with (`C245`). Nothing that reads this list may hard-code a count: every
 * consumer derives it, and the two tests that had typed *four* now do.
 *
 * **THIS IS NOT `deferral.ts` AND MUST NOT BECOME IT.** `DEPLOYED_CIRCUITS` and
 * `DEFERRED_CIRCUITS` describe the ACCOUNT's deployment and the split between
 * them is a product decision (`S9`). The vault has no split: it fits, so it
 * deploys whole, and the day it does not fit is a day for a new decision rather
 * than for a second list under the same names. `assertKnownCircuitSet` and
 * `src/midnight/deferral.ts` are the account's; widening either to cover both
 * contracts would make one list describe two deployments, which is how a client
 * ends up accepting a deployment nobody chose (`C231`'s money direction).
 *
 * Sorted, and kept sorted, so a diff of this list is a diff of the deployment.
 * Read off `contracts/managed-vault/contract/index.d.ts`'s `ProvableCircuits`,
 * which is the compiler's own answer and not a transcription of the source.
 */
export const VAULT_CIRCUITS = [
  'deposit',
  'depositUnshielded',
  'forgetUnshielded',
  'payout',
  'payoutUnshielded',
  'retire',
  'splitNote',
] as const;

export type VaultCircuit = (typeof VAULT_CIRCUITS)[number];

/**
 * The account's circuits, named here for ONE purpose: telling a reader that the
 * address they pointed a vault client at is an account.
 *
 * Not imported from `deferral.ts`, and the restraint is deliberate. Importing
 * would couple the vault's refusal message to the account's DEPLOYMENT lists,
 * which move when the account's split is re-decided — and a message that
 * changes when an unrelated decision changes is a message nobody can trust.
 * These three are entry points the account has had since `S6a` and the vault
 * has never had; any one of them appearing in a state a vault client is reading
 * settles the question on its own.
 */
const ACCOUNT_TELLS = ['adopt', 'recordPayment', 'setVaultThreshold'];

/** Entry-point names as strings, whatever the runtime hands back. */
const opNames = (state: { operations(): Array<string | Uint8Array> }): string[] =>
  state.operations().map((n) => (typeof n === 'string' ? n : new TextDecoder().decode(n)));

/**
 * Refuses an operations map that is not exactly the vault's own circuits.
 *
 * BOTH DIRECTIONS, exactly as the account's own assertion works: a missing
 * circuit means this is not a whole vault, and an extra one means it is not a
 * vault at all. The alternative is `C224`'s: a deployment smaller than anyone
 * decided, or a client happily building calls against a contract it has never
 * seen the shape of.
 *
 * `where` names the thing being described — "the compiled vault", "the contract
 * at this address" — because the same refusal fires at two very different
 * moments and the remedies are not the same.
 */
export function assertVaultCircuitSet(names: string[], where: string): void {
  const expected = [...VAULT_CIRCUITS].sort();
  const actual = [...names].sort();
  if (expected.length === actual.length && expected.every((n, i) => n === actual[i])) return;

  const tells = actual.filter((n) => ACCOUNT_TELLS.includes(n));
  const isAccount = tells.length > 0;
  throw new Error(
    `${where} does not carry the ${expected.length} circuits a vault has.\n` +
      `  found:    ${actual.length ? actual.join(', ') : '(none)'}\n` +
      `  expected: ${expected.join(', ')}\n` +
      (isAccount
        ? 'THIS IS AN ACCOUNT, NOT A VAULT: it carries ' + tells.join(', ') + '. The account ' +
          'has its own client and its own find — findDeployedPartialContract in ' +
          'src/midnight/partial-contract.ts — because the account is a PARTIAL deployment and ' +
          'this one is not. Pointing a vault client at an account is a wrong address, and no ' +
          'retry changes the answer.\n'
        : 'A vault deploys whole — nothing is deferred — so a vault missing a circuit was not ' +
          'deployed by this client, and a vault carrying an extra one has been maintained ' +
          'since. Neither is a state to build calls on.\n' +
          'A vault deployed BEFORE S6j carries four circuits and is one of these: it predates ' +
          'depositUnshielded, payoutUnshielded and forgetUnshielded, cannot hold the token the ' +
          'product launches with, and is refused by name here rather than failing later on a ' +
          'verifier key.\n') +
      'src/midnight/vault-contract.ts holds the list; contracts/src/Vault.compact holds the ' +
      'contract. If the vault genuinely gained or lost a circuit, that list is re-decided ' +
      'against the derived ceiling (scripts/dispatch-ceiling.ts) — not patched to make this ' +
      'error go away.',
  );
}

/* ------------------------------------------------------------------ *
 * the maintenance authority, for the contract that holds the money
 * ------------------------------------------------------------------ */

/**
 * The vault's authority choice, validated — and never sampled. `C225`.
 *
 * **THE TYPE AND THE VALIDATOR ARE THE ACCOUNT'S, IMPORTED RATHER THAN
 * COPIED, AND THAT IS A DELIBERATE EXCEPTION TO "DO NOT REUSE
 * partial-contract.ts".** Everything else in that module is about a partial
 * operations map. `MaintenanceAuthorityChoice` is not: it is the answer to
 * `deployContract`'s `options.signingKey ?? sampleSigningKey()`
 * (`midnight-js-contracts/dist/index.mjs:1907`), which is the FULL deploy path,
 * which is this one. Two validators of a rule the money depends on is `M-104`,
 * and it is the more expensive mistake of the two available here.
 *
 * **WHAT IS THE VAULT'S OWN IS THE NARROWING BELOW, AND IT IS A REAL LOSS OF
 * CHOICE.** Read from source, not assumed:
 *
 *   · `deployContract` builds the contract's maintenance authority through
 *     compact-js's `createMaintenanceAuthority`
 *     (`compact-js/dist/esm/effect/ContractExecutable.js:276-290`), which takes
 *     ONE signing key and produces
 *     `new ContractMaintenanceAuthority([verifyingKey], DEFAULT_CMA_THRESHOLD,
 *     …)` — **a committee of one at threshold one, always.**
 *   · `replaceAuthority` is no way out either: `submitReplaceAuthorityTx`
 *     (`midnight-js-contracts/dist/index.mjs:532-557`) takes a single
 *     `newAuthority` signing key and goes through the same constructor.
 *
 * So through the SDK's full deploy path a vault can have exactly one kind of
 * maintenance authority: **one key.** `committee` and `unmaintainable` are not
 * expressible, and this refuses them by name rather than accepting a choice it
 * would then quietly not honour — which is the failure that would matter,
 * because the deploy report would record a committee that the chain does not
 * have. `M-156` carries what it would take.
 *
 * The account escapes this only because its deploy rebuilds the contract state
 * by hand to prune the operations map, and can set the authority while it is
 * there. That is not a licence to do the same for a vault: it would put the
 * contract that holds the money on the hand-assembled path, for a property the
 * account has not needed yet either — its own deployment is `single-key`
 * today.
 */
export function requireVaultMaintenanceAuthority(
  choice: MaintenanceAuthorityChoice | undefined,
): Extract<MaintenanceAuthorityChoice, { kind: 'single-key' }> {
  const validated = requireMaintenanceAuthority(choice);
  if (validated.kind !== 'single-key') {
    throw new Error(
      `a vault cannot be deployed with a "${validated.kind}" maintenance authority, and this ` +
        'refuses rather than recording one the chain would not have.\n\n' +
        "The SDK's full deploy path builds the authority from ONE signing key — compact-js " +
        "`createMaintenanceAuthority` returns a committee of one at threshold one " +
        '(ContractExecutable.js:276-290) — and `replaceAuthority` takes a single key through ' +
        'the same constructor (midnight-js-contracts index.mjs:532-557). So a committee, and ' +
        'an empty committee that can never sign, are both unreachable from here.\n\n' +
        'What IS available, and it is the account\'s own state today:\n' +
        '  { kind: "single-key", signingKey: {tag,value},\n' +
        '    temporary: { fixedBy: "<the round that replaces this deployment>" } }\n' +
        'One key, DELIBERATELY, as a recorded temporary state. Everything C225 says about a ' +
        'single key applies, knowingly, until that round — and for a vault it applies to the ' +
        'contract that holds the money.\n\n' +
        'The way out is a deploy that assembles the contract state by hand, as the account\'s ' +
        'partial deploy already does for a different reason. That is a round, not a parameter; ' +
        'it is written up as M-156 and it is not taken here.',
    );
  }
  return validated;
}

export { describeMaintenanceAuthority };

/* ------------------------------------------------------------------ *
 * the addressing rule, named so it can be grepped and tested
 * ------------------------------------------------------------------ */

/**
 * Points the private-state store at the vault this operation is for. `C228`.
 *
 * A function rather than a bare call at four sites, so the rule has a name a
 * later round can grep for and a test can drive. It refuses an empty address
 * rather than passing one on: `setContractAddress('')` would make every
 * subsequent key `:<id>`, which is a real prefix that a second empty-address
 * caller would share — the failure this exists to prevent, wearing a different
 * hat.
 */
export function addressVaultPrivateState(providers: any, vaultAddress: string): void {
  if (typeof vaultAddress !== 'string' || vaultAddress.trim().length === 0) {
    throw new Error(
      'refusing to address a vault\'s private state by an empty address. The store files ' +
        'everything under `${contractAddress}:${privateStateId}`, so an empty address is not ' +
        'an absent prefix — it is a shared one (C228).',
    );
  }
  providers?.privateStateProvider?.setContractAddress?.(vaultAddress);
}

/* ------------------------------------------------------------------ *
 * the deploy
 * ------------------------------------------------------------------ */

export interface VaultDeployOptions {
  /** The VAULT's CompiledContract. Not the account's. */
  compiledContract: unknown;
  /**
   * The account this vault is married to, as the constructor takes it. `V-37`.
   *
   * A 32-byte contract address, hex, no prefix. It is pinned in the vault's
   * ledger at creation and can never be redirected — which is what stops
   * anybody pointing a vault at a contract that would answer "approved, pay
   * me". Passed here as a string and converted once, below, so a caller cannot
   * hand over a half-built reference object.
   */
  accountAddress: string;
  /** The deliberate choice. There is no default and nothing is sampled. C225. */
  maintenanceAuthority: MaintenanceAuthorityChoice | undefined;
}

export interface VaultDeployResult {
  /**
   * The deployed vault's address.
   *
   * **`C236`: THIS MUST NOT REACH A SCREEN.** A shielded output addressed to a
   * vault without a `deposit` call is money on chain that nobody can spend,
   * permanently, and no contract can refuse it. The address is recorded, and it
   * is passed to the client that calls the vault; it is never printed, never
   * put in a report, and never shown. `describeVault` in
   * `src/midnight/vault-record.ts` is what a report prints instead.
   */
  contractAddress: string;
  /** The finalized deploy transaction, as the SDK hands it back. */
  deployTxData: any;
  /** What the deployed operations map actually carries, read back from it. */
  circuits: string[];
  /** Shape only — committee size and threshold. NEVER key material. */
  authority: MaintenanceAuthorityDescription;
}

/**
 * Deploys a vault, whole, through the SDK.
 *
 * **THE ORDER OF THE REFUSALS IS THE DESIGN.** Everything knowable before a fee
 * is spent is checked before a fee is spent — the authority, the keys on disk —
 * and everything only knowable afterwards is REPORTED rather than thrown,
 * because after the submission the address exists and losing it is worse than
 * any wrong shape it could have. An address we deployed and did not write down
 * is money nobody can reach, which is the same rule `MidnightLedger.open`
 * follows for the account.
 *
 * **NO `privateStateId`, and it is not an omission.** See the `C228` note in
 * this file's header: the vault's witness reads the note pool, not the SDK's
 * private state, so the SDK writes nothing for a vault and there is no vault
 * view for a second vault to read.
 */
export async function deployVaultContract(
  providers: any,
  options: VaultDeployOptions,
): Promise<VaultDeployResult> {
  /* Before anything else: the authority. A missing or inexpressible one is a
   * refusal to explain, never a transient. */
  const authority = requireVaultMaintenanceAuthority(options.maintenanceAuthority);

  const account = options.accountAddress?.trim();
  if (!account || !/^[0-9a-fA-F]{64}$/.test(account)) {
    throw new Error(
      'a vault is deployed married to ONE account and the address given is not 32 bytes of ' +
        'hex. The account is pinned in the vault\'s ledger at creation and can never be ' +
        'redirected (V-37) — which is exactly why it is checked here rather than discovered ' +
        'when a payout asks the wrong contract whether it was approved.',
    );
  }

  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');

  /*
   * EVERY CIRCUIT HAS A KEY ON DISK, ASKED BEFORE A FEE IS SPENT. `C226`.
   *
   * `contracts/managed-vault/` has held no `keys/` since the vault was written,
   * and `COMPILE-VAULT.command` is the only thing that builds them. The SDK
   * would refuse too — `ContractExecutable.initialize` raises
   * `ContractConfigurationError` for a missing verifier key
   * (`compact-js/dist/esm/effect/ContractExecutable.js:100-118`) — but it would
   * do it after the wallet, the DUST wait and the proof server, and it would
   * name one circuit rather than the file that builds all four.
   */
  try {
    await providers.zkConfigProvider.getVerifierKeys([...VAULT_CIRCUITS]);
  } catch (cause) {
    throw new Error(
      'the vault\'s verifier keys are not on disk, so nothing can be deployed: ' +
        `${(cause as Error)?.message ?? String(cause)}\n` +
        'COMPILE-VAULT.command is the only file that builds them, it takes minutes, and it ' +
        'must run before this. MUTATE.command\'s quick recompiles wipe them and ' +
        'BUILD-KEYS.command covers the account only.',
      { cause },
    );
  }

  const deployed: any = await deployContract(providers as any, {
    compiledContract: options.compiledContract,
    /*
     * The constructor's one argument: the account, as a contract reference.
     * `initialState(context, a_0: { bytes: Uint8Array })` —
     * `contracts/managed-vault/contract/index.d.ts`, read rather than guessed.
     */
    args: [{ bytes: Uint8Array.from(Buffer.from(account, 'hex')) }],
    /*
     * THE CHOSEN KEY, PASSED. Without it `createDeployTxOptions` substitutes
     * `sampleSigningKey()` (`index.mjs:1907`) and the contract holding the
     * money acquires a single random unrecorded authority over which proofs it
     * will accept. That is C225, and this argument is the whole of the fix.
     */
    signingKey: authority.signingKey,
  } as any);

  const contractAddress = String(deployed.deployTxData.public.contractAddress);

  /*
   * The address, set explicitly, immediately. `submitDeployTx` sets it too
   * (`index.mjs:1180`) — this is not redundant, it is the rule: the vault path
   * does not depend on the SDK having left the store pointing anywhere in
   * particular, because the day it stops doing so the failure is a proof built
   * from another contract's view. C228.
   */
  addressVaultPrivateState(providers, contractAddress);

  return {
    contractAddress,
    deployTxData: deployed.deployTxData,
    /*
     * READ BACK OFF THE DEPLOY'S OWN STATE, not asserted. A wrong shape here
     * is reported to a caller that has already been handed the address; it is
     * not thrown, because throwing would lose the address of a contract that
     * exists.
     */
    circuits: opNames(deployed.deployTxData.public.initialContractState).sort(),
    authority: describeMaintenanceAuthority(authority),
  };
}

/* ------------------------------------------------------------------ *
 * the find
 * ------------------------------------------------------------------ */

/**
 * The vault's own find. See this file's header for why it is neither of the
 * other two.
 *
 * Keeps `M-9`'s property — the deployed verifier keys compared byte-for-byte
 * against the compiled ones, through the SDK's own `verifyContractState` — and
 * adds the check the SDK cannot express: the operations map must be EXACTLY the
 * vault's own. It writes nothing to the private-state store and samples no
 * key.
 */
export async function findDeployedVaultContract(
  providers: any,
  options: { compiledContract: unknown; contractAddress: string },
): Promise<{ callTx: any; circuits: string[] }> {
  const { contractAddress } = options;

  /* C228, before the first read of anything. */
  addressVaultPrivateState(providers, contractAddress);

  const { verifyContractState, createCircuitCallTxInterface } =
    await import('@midnight-ntwrk/midnight-js-contracts');

  const state: any = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    /*
     * NOT "an empty vault". `C110`: a state the node had finalised read as
     * absent to the indexer 168ms later, and the two readings need opposite
     * responses.
     */
    throw new Error(
      'no contract state came back for this vault. That is not an empty vault — an empty ' +
        'vault is a true statement and a missing state is our ignorance. Either nothing is ' +
        'deployed at this address, or the indexer has not caught up with a deploy that just ' +
        'landed (C110). The address is deliberately not printed: C236.',
    );
  }

  assertVaultCircuitSet(opNames(state), 'the contract at the address given');

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys([...VAULT_CIRCUITS]);
  verifyContractState(verifierKeys as any, state);

  /*
   * `createCircuitCallTxInterface` sets the provider's contract address itself
   * (`index.mjs:1876`). It is called with NO `privateStateId`, so
   * `createCallTxOptions` carries none (`:1862`) and no call this interface
   * builds reads or writes the private-state store. C228, property (1).
   */
  return {
    callTx: createCircuitCallTxInterface(
      providers, options.compiledContract as any, contractAddress as any, undefined as any),
    circuits: opNames(state).sort(),
  };
}
