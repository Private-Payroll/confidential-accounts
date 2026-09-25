/**
 * THE VAULT'S DEPLOY, AND THE FIND THAT SERVES IT.
 *
 * The account is deployed through the PARTIAL path — eleven of the eleven it
 * compiles today, eleven of thirteen before two were shed and the deferred
 * list was emptied,
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
 * **AND THAT PARAGRAPH IS STILL TRUE AND IS NO LONGER THE WHOLE ANSWER.** It
 * weighs hand-written steps against nothing, because when it was written the only
 * alternative was the SDK. The thing on the other side of the scale is the
 * product's own non-negotiable: *"we can never custody any funds or hold the
 * wallet key anywhere with us."* The SDK's path cannot
 * satisfy it at all, at any level of care, because `submitDeployTx` stores the
 * signing key unconditionally (`index.mjs:1184`) and `deployContract` can express
 * one key and nothing else. **So there are now TWO deploys in this file and
 * neither replaces the other:** `deployVaultContract`, the SDK's, for a
 * `single-key` vault deployed knowingly; and `submitHandBuiltVaultDeployTx`, which
 * assembles the state by hand and can carry the company's own committee, at the
 * price of the nine dependencies enumerated above it. **Both positions are written
 * because both are live and neither is marked correct: the choice is a governance
 * decision and `vaultDeployCustody` is what states its cost.**
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
  type TaggedKey,
} from './partial-contract.js';
import { assertVaultLedgerIsThisBuilds } from './vault-ledger-shape.js';

export type {
  MaintenanceAuthorityChoice, MaintenanceAuthorityDescription,
} from './partial-contract.js';

/* ------------------------------------------------------------------ *
 * which circuits a vault has — the vault's own list, not the account's
 * ------------------------------------------------------------------ */

/**
 * The circuits `contracts/src/Vault.compact` compiles, and all of them deploy.
 *
 * **SEVEN**, since `depositUnshielded`, `payoutUnshielded`
 * and `forgetUnshielded` so the vault could hold the token the product launches
 * with (`C245`). Nothing that reads this list may hard-code a count: every
 * consumer derives it, and the two tests that had typed *four* now do.
 *
 * **THIS IS NOT `deferral.ts` AND MUST NOT BECOME IT.** `DEPLOYED_CIRCUITS` and
 * `DEFERRED_CIRCUITS` describe the ACCOUNT's deployment and the split between
 * them is a product decision. The vault has no split: it fits, so it
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
 * **THE ACCOUNT'S CIRCUITS A VAULT'S OWN CIRCUITS CALL**, and so the only ones
 * of the account's a device proves beside a vault's: `payout` asks
 * `recordPayment` inside the same transaction. No vault circuit shares a name
 * with one of these, which is what lets a prover be pointed at the account's
 * material by the circuit's name alone.
 */
export const ACCOUNT_CIRCUITS_A_VAULT_CALLS: readonly string[] = Object.freeze(['recordPayment']);

/**
 * **THE ACCOUNT'S CIRCUITS A SIGNER'S OWN DEVICE BUILDS AND PROVES**: raising a
 * round, approving one, and carrying out an approved round that seats a signer
 * or changes the threshold. Each opens with the signer check, so each runs
 * against the signer's own secret, which exists only on that device. No vault
 * circuit shares a name with any of them.
 */
export const ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS: readonly string[] = Object.freeze(['propose', 'approve', 'amendSigner', 'setThreshold']);

/** Every one of the account's circuits whose proving material is served to a device, for either reason above. */
export const ACCOUNT_CIRCUITS_SERVED_TO_A_DEVICE: readonly string[] = Object.freeze([
  ...ACCOUNT_CIRCUITS_A_VAULT_CALLS, ...ACCOUNT_CIRCUITS_A_DEVICE_GOVERNS,
]);

/**
 * The account's circuits, named here for ONE purpose: telling a reader that the
 * address they pointed a vault client at is an account.
 *
 * Not imported from `deferral.ts`, and the restraint is deliberate. Importing
 * would couple the vault's refusal message to the account's DEPLOYMENT lists,
 * which move when the account's split is re-decided — and a message that
 * changes when an unrelated decision changes is a message nobody can trust.
 * These three are entry points the account has had from the beginning and the vault
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
          'A vault carrying only four circuits predates depositUnshielded, payoutUnshielded ' +
          'and forgetUnshielded, so it cannot hold the token the product launches with, and ' +
          'it is refused by name here rather than failing later on a verifier key.\n') +
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
        '    temporary: { fixedBy: "<what replaces this deployment>" } }\n' +
        'One key, DELIBERATELY, as a recorded temporary state. The holder of that key can ' +
        'change which proofs this contract accepts, alone, outside any threshold, and if it ' +
        'is lost the contract can never be maintained. For a vault that applies to the ' +
        'contract holding the money, so it is accepted knowingly or not at all, and ' +
        'temporary.fixedBy names the deployment that replaces it.\n\n' +
        'THE WAY OUT EXISTS AND IT IS IN THIS FILE: submitHandBuiltVaultDeployTx assembles ' +
        'the contract state by hand, as the account\'s partial deploy already does for a ' +
        'different reason, and it accepts a committee.\n\n' +
        'THIS FUNCTION IS STILL CORRECT AND IS STILL THE SDK PATH\'S GUARD: ' +
        'deployVaultContract goes through deployContract, which can express one key and ' +
        'nothing else, so a committee handed to THAT path would be recorded in the deploy ' +
        'report and not carried on chain.\n\n' +
        'The two paths differ in one property a reader should be able to name, and ' +
        'vaultDeployCustody() names it: this one leaves a signing key on the deploying ' +
        'machine, and the hand-built one under a committee stores none.',
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
        'an absent prefix: it is a shared one, and a second caller with no address would ' +
        'read and write this vault\'s entries.',
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
        'redirected, which is exactly why it is checked here rather than discovered when a ' +
        'payout asks the wrong contract whether it was approved.',
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
        'landed. The address is deliberately not printed: a shielded output addressed to a ' +
        'vault without a deposit call is money nobody can spend.',
    );
  }

  assertVaultCircuitSet(opNames(state), 'the contract at the address given');

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys([...VAULT_CIRCUITS]);
  verifyContractState(verifierKeys as any, state);

  /*
   * **THE LEDGER'S SHAPE, AND IT IS THE CHECK NEITHER OF THE TWO ABOVE MAKES.**
   *
   * The operations map names circuits. The verifier keys compare those circuits
   * byte for byte. **Neither of them opens the ledger**, and a ledger field
   * that no circuit reads yet is invisible to both: one vault on this project's
   * own registry passes the verifier-key comparison above while holding a field
   * fewer than this build's contract declares. Measured, that vault and the one
   * deployed from this build, in the same afternoon. A field no circuit reads
   * yet is one edit from being a field that does, and by then the vault holds
   * money.
   *
   * **IT GOES HERE BECAUSE EVERYTHING GOES HERE.** Every deposit into a vault
   * and every payout out of one resolves the deployed contract through this
   * function before it builds a call, so a vault this build cannot read
   * correctly is refused once, in front of the fee and the proof, rather than
   * in each door that might remember to ask.
   */
  await assertVaultLedgerIsThisBuilds(state);

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

/* ------------------------------------------------------------------ *
 * ROUTE (a): THE HAND-BUILT VAULT DEPLOY, WHICH STORES NO SIGNING KEY
 * ------------------------------------------------------------------ */

/**
 * The deploy path for a vault whose maintenance authority is the company's own
 * committee, built here rather than taken from the SDK, because the SDK cannot
 * express one.
 *
 * **WHY THIS EXISTS, AND IT IS THE PRODUCT'S OWN RULE:** *"we can never custody
 * any funds or hold the wallet key anywhere with us."* The
 * ordinary path above, `deployVaultContract`, satisfies that sentence nowhere:
 * it requires a `single-key` authority (`requireVaultMaintenanceAuthority`), and
 * a single key over a pot of a company's money is one party able to swap
 * `payout`'s verifier key and take everything in that vault, alone, outside any
 * threshold.
 *
 * **AND THE SECOND CUSTODY SURFACE, WHICH IS WHAT THIS PATH REMOVES.** There are
 * TWO copies of a `single-key` vault's signing key today, not one:
 *
 *   COPY ONE. The door that records a chosen authority samples the key on
 *   whatever machine runs it and writes it to
 *   `.midnight/vault-authority-<name>.json` at mode `0600`. That is the copy
 *   the vault's own surface notes account for.
 *
 *   COPY TWO, WHICH NOBODY CHOSE.
 *   `node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs:1184`
 *   calls `setSigningKey` UNCONDITIONALLY inside `submitDeployTx`, storing it in
 *   the level signing-key store. `deployVaultContract` reaches it through
 *   `deployContract` (`:1928`), which is `submitDeployTx` with the sampling
 *   default in front of it (`:1907`). Nothing in this repository asked for that
 *   write and nothing in this repository could refuse it.
 *
 * **UNDER A COMMITTEE NO SIGNING KEY IS STORED, AND THAT IS THE WHOLE POINT.**
 * `src/midnight/partial-contract.ts:358-360` already has the rule on the
 * account's path, guarded on `kind === 'single-key'`; this is that rule for the
 * vault. A committee has no single key to store, and the SDK's maintenance
 * interface could not drive one anyway: every entry point begins by reading
 * exactly that slot and asserting it (`index.mjs:398-399`, `:470-471`,
 * `:547-548`). **So adopting a committee removes the second custody surface and
 * the SDK's whole maintenance interface in the same act.** What replaces the
 * latter is `buildMaintenanceInstruction` in `src/midnight/ledger.ts`; what
 * replaces the read-back is `readContractAuthority` in the same file. Neither
 * consults a stored key.
 *
 * ------------------------------------------------------------------------
 * THE NINE DEPENDENCIES, RE-DERIVED RATHER THAN INHERITED
 *
 * Nine things the hand-built path does that the SDK's does not, and the
 * balance moves if five of them are covered **by code rather than by care**.
 * Re-derived against `submitPartialDeployTx`
 * (`src/midnight/partial-contract.ts:257-370`) and against
 * `submitDeployTx`/`createDeployTxOptions` (`index.mjs:1172-1192`, `:1904-1916`)
 * here, and each is answered in the code below rather than in a comment:
 *
 *   1. THE OPERATIONS MAP IS REBUILT BY HAND. The account's loop reads
 *      `DEPLOYED_CIRCUITS`, which is the ACCOUNT's decided list; a vault built
 *      through it would deploy the account's names or none. **Answered by
 *      asserting the constructor's own map is exactly `VAULT_CIRCUITS` in both
 *      directions BEFORE the loop, building from that decided list, and
 *      asserting the built map again after.** A vault missing `payout` is money
 *      that can be deposited and never leave (`VerifierKeyNotPresent`,
 *      `verify.rs:104-119`; `retire` refuses a non-empty vault,
 *      `Vault.compact:1071` and `:1088`), so it is refused by name before a fee is
 *      spent rather than discovered on chain.
 *   2. `assertKnownCircuitSet` IS ACCOUNT-ONLY BY CONSTRUCTION
 *      (`src/midnight/deferral.ts:126-140`). **Answered by
 *      `assertVaultCircuitSet`**, which already existed and is already
 *      two-directional. Its `where` parameter was documented for two moments and
 *      had only ever been called at one; this path supplies the other.
 *   3. `pruned.data = full.data` CARRIES THE VAULT'S `account` PIN
 *      (`Vault.compact:262-264`). The loud failure is `IncorrectChargedState`
 *      (`verify.rs:1724-1730`); **the quiet one is a `data` that round-trips
 *      carrying a different account, and neither find checks it.** Answered by
 *      reading the vault's own ledger off the state this deploy is about to
 *      submit and comparing `account` against the address the caller gave,
 *      before submission. A vault married to the wrong account is a vault whose
 *      payouts ask the wrong contract whether they were approved (`V-37`).
 *   4. `privateStateProvider.set(...)` IS UNCONDITIONAL on the account's path
 *      (`partial-contract.ts:357`), where the SDK writes one only when
 *      `'privateStateId' in options` (`index.mjs:1181-1183`). **The vault
 *      deliberately has none** (this file's header, property 1). Answered by
 *      writing none: there is no `privateStateId` in this path's options and no
 *      call to `set`. Every vault deploy through the account's function would
 *      have written under `<address>:undefined`, a real shared key, which is
 *      a shared-prefix failure created by moving paths.
 *   5. `setContractAddress` RAW at `partial-contract.ts:356` bypasses the
 *      vault's named rule. **Answered by `addressVaultPrivateState`**, which
 *      refuses an empty address rather than passing one on.
 *   6. `initialContractState` IS NOT RETURNED by the account's path
 *      (`:362-369`, against `index.mjs:1073-1074`). `deployVaultContract` reads
 *      it at this file's `:452`, so `opNames(undefined)` would throw AFTER
 *      submission, at the exact point this file says nothing may throw, because
 *      an address we deployed and did not write down is money nobody can reach.
 *      **A mechanical break, not a hazard. Answered by returning it.**
 *   7. NO ZSWAP OFFER IS CARRIED. The account's guard exists and its message is
 *      about the ACCOUNT's constructor. **Answered by a guard whose message is
 *      about the vault's**, which mints nothing today (`Vault.compact:262-264`).
 *      A guard describing the wrong contract is a guard nobody acts on.
 *   8. `requireVaultMaintenanceAuthority`'s NARROWING MUST NOT APPLY HERE.
 *      **Answered by `requireHandBuiltVaultAuthority` below rather than by
 *      deleting it**, because the SDK path above still exists and still needs
 *      it. Deleting it would leave `deployVaultContract` able to record a
 *      committee the chain does not have, which its own comment calls the
 *      failure that would matter.
 *   9. UNDER A COMMITTEE NO SIGNING KEY IS STORED. **Answered by the guarded
 *      write at the end of this function, and pinned by a test that goes red the
 *      day the call comes back.** This is not a deploy cost at all: it is the
 *      reason the path exists.
 *
 * **WHAT THAT LEAVES.** The scope document predicted a hand-written residue of
 * items 3, 7, 8 and 9 once 1, 2, 4, 5 and 6 were covered by code. Measured
 * here: 1, 2, 4, 5 and 6 are covered by code, and so is 3, by the ledger read
 * below. **The residue is 7, 8 and 9, and all three are one refusal or one
 * conditional rather than a procedure.** That is the measurable claim the scope
 * enumeration promised; what settles it end to end is a real vault-shaped deploy
 * on a network, which has not been done.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS PATH IS NOT
 *
 * **IT IS NOT A REPLACEMENT FOR `deployVaultContract`.** That function is the
 * `single-key` path and stays, because every vault deployed so far carries a
 * single key and the product must keep being able to deploy one knowingly. **The two differ in exactly one property a reader should be able to
 * name: whether the deploying machine ends up holding a key that can rewrite the
 * rules of the contract holding the money.** `vaultDeployCustody` below answers
 * that question for a given choice, by name, so no round has to read either
 * function to find out.
 *
 * **AND IT DEPLOYS NOTHING BY BEING WRITTEN.** Running it is a person's act
 * behind a door. Nothing here has been run against a chain and no measurement in
 * this comment claims otherwise.
 */

/** The `ContractState` surface this path uses, named so a runtime change is a compile error here. */
export interface VaultContractStateLike {
  data: unknown;
  maintenanceAuthority: unknown;
  operations(): Array<string | Uint8Array>;
  operation(name: string): { verifierKey?: unknown } | undefined | null;
  setOperation(name: string, op: unknown): void;
  serialize(): Uint8Array;
}

/**
 * The runtime pieces this path needs, PASSED IN rather than imported.
 *
 * The same reason `MaintenancePrimitives` in `src/midnight/ledger.ts` takes
 * them: this module must stay loadable without ten megabytes of WebAssembly,
 * and a named interface makes a runtime change a compile error HERE rather than
 * an `any` flowing through a mismatch unnoticed under
 * `tsconfig.scripts.json`'s `strict: false`.
 *
 * **AND IT IS WHAT MAKES THIS MODULE'S CENTRAL PROPERTY TESTABLE.** A path
 * that reaches for its own imports can only be driven against the real runtime;
 * one that takes them can be driven against a fake that RECORDS, which is how
 * "this deploy stored no signing key" becomes an assertion rather than a
 * reading of the source. An assertion whose failure nobody has watched is not an
 * assertion.
 */
export interface VaultDeployPrimitives {
  ContractState: new () => VaultContractStateLike;
  ContractMaintenanceAuthority: new (
    committee: TaggedKey[], threshold: number, counter?: bigint,
  ) => object;
  ContractDeploy: new (state: unknown) => { address: unknown };
  /* `Intent.new` is a STATIC METHOD called `new`, not a construct signature.
   * Written as a property so `prims.Intent.new(...)` type-checks; the
   * method-shorthand spelling makes it a constructor and the call site
   * stops compiling. */
  Intent: { new: (ttl: unknown) => { addDeploy(deploy: unknown): unknown } };
  Transaction: { fromParts(...parts: unknown[]): unknown };
  ttlOneHour: () => unknown;
  deserializeContractState: (bytes: Uint8Array, context: unknown) => unknown;
  getNetworkId: () => unknown;
  /**
   * The VAULT's own ledger reader, `ledger` from
   * `contracts/managed-vault/contract/index.js`. Dependency 3: it is the only
   * thing that can say which account a built vault state is married to.
   */
  readVaultLedger: (data: unknown) => { account: { bytes: Uint8Array } };
  /** `SucceedEntirely`, the one status a submitted deploy may come back with. */
  SucceedEntirely: unknown;
}

/**
 * The authority a HAND-BUILT vault deploy accepts. Dependency 8.
 *
 * **THIS IS NOT `requireVaultMaintenanceAuthority` AND MUST NOT BECOME IT.**
 * That function refuses `committee` because the SDK's full deploy path cannot
 * express one, which is a statement about the SDK. This one refuses
 * `unmaintainable` because a vault must never be one, which is a statement
 * about the money. **Two different refusals about two different things, and
 * merging them would lose whichever reason was written second.**
 *
 * **WHY `unmaintainable` IS REFUSED HERE, AND IT IS A MEASUREMENT RATHER THAN
 * TASTE.** A vault's only exits are its own two circuits. It pays out normally
 * until the first defect in `payout`, and is permanently insolvent after it, and
 * **nothing distinguishes those two states from outside.** An unmaintainable
 * vault therefore trades a recoverable grief for an irrecoverable money loss,
 * and money must not be losable on either path. The type still carries the kind,
 * and the account may still choose it; the vault may not.
 *
 * **AND `single-key` IS STILL ACCEPTED, DELIBERATELY.** The point of this path
 * is that a committee becomes reachable, not that one key becomes forbidden: a
 * stagenet vault nobody relies on is a legitimate `single-key` deployment, and
 * `requireMaintenanceAuthority` already forces it to be a RECORDED temporary
 * state naming the deployment that replaces it. **What changes is that the
 * choice now exists**, and `vaultDeployCustody` says what each one costs.
 */
export function requireHandBuiltVaultAuthority(
  choice: MaintenanceAuthorityChoice | undefined,
): Exclude<MaintenanceAuthorityChoice, { kind: 'unmaintainable' }> {
  const validated = requireMaintenanceAuthority(choice);
  if (validated.kind === 'unmaintainable') {
    throw new Error(
      'a vault cannot be deployed unmaintainable, and this refuses rather than making a pot ' +
        'of money that no defect can ever be fixed in.\n\n' +
        'An unmaintainable contract is an empty committee at threshold one: no maintenance ' +
        'update can ever verify, so nobody can change which proofs it accepts, ever. On the ' +
        'ACCOUNT that is a defensible trade. On a VAULT it is not, and the measurement is ' +
        'this: a vault\'s only exits are its own two circuits, so it pays out normally ' +
        'until the first defect in payout and is permanently insolvent after it, and nothing ' +
        'distinguishes those two states from outside. Money must not be losable on either ' +
        'path, and a recoverable grief must not be traded for an irrecoverable loss.\n\n' +
        'What IS available here, and both are real choices rather than one and a fallback:\n' +
        '  { kind: "committee", committee: [{tag,value}...], threshold: N }\n' +
        '      The company\'s own signers at their own threshold. NO SIGNING KEY IS STORED ' +
        'ANYWHERE by this deploy, which is the whole reason this path exists. The keys in the ' +
        'list are VERIFYING keys, not signing keys.\n' +
        '  { kind: "single-key", signingKey: {tag,value}, temporary: { fixedBy: "<round>" } }\n' +
        '      One key, deliberately, as a recorded temporary state. The deploying machine ' +
        'ends up holding a key that can change which proofs the contract accepts, ' +
        'knowingly.\n\n' +
        'vaultDeployCustody() in this file answers which of those a given choice is, by name.',
    );
  }
  return validated;
}

/** What a given choice costs in custody, answered by name rather than by reading the deploy. */
export interface VaultDeployCustody {
  /** Whether THIS deploy writes a signing key into the level private-state store. */
  storesSigningKey: boolean;
  /** How many copies of a signing key exist for this vault once the deploy has run. */
  keyCopies: number;
  /** Where each copy is, in words a report may print. NEVER key material. */
  where: string[];
}

/**
 * Answers, for one choice: after this deploy, how many copies of a signing key
 * exist and where are they?
 *
 * **A SENTENCE IN A DOCUMENT GOES STALE SILENTLY.** This is the same sentence
 * somewhere a test can read it and a report can print it: which copies of a
 * signing key still exist once this deploy has run.
 *
 * **IT DESCRIBES THIS PATH AND NOT `deployVaultContract`.** The SDK path always
 * stores a key, because `submitDeployTx` does it unconditionally at
 * `index.mjs:1184` whatever we pass; there is no choice to describe there.
 * `vaultDeployCustody` is about the choice this path makes available.
 *
 * **NEVER KEY MATERIAL.** `where` names places, the way
 * `describeMaintenanceAuthority` names shapes. A report is a plaintext home for
 * anything put in it, and a key that reaches a file which is not `0600` and
 * ignored by version control has left the only place it was meant to be.
 */
export function vaultDeployCustody(
  choice: Exclude<MaintenanceAuthorityChoice, { kind: 'unmaintainable' }>,
): VaultDeployCustody {
  if (choice.kind === 'committee') {
    return {
      storesSigningKey: false,
      keyCopies: 0,
      where: [
        'nowhere. A committee authority is a list of VERIFYING keys, and this deploy STORES ' +
        'no signing key at all: not in the private-state store, not on disk, not in the ' +
        'deploy record. The committee members\' signing halves stay with their owners and ' +
        'never reach this machine. ONE KEY IS SAMPLED IN PROCESS AND DISCARDED UNUSED: the ' +
        'runtime builds an interim authority when none is passed, and this deploy replaces ' +
        'that authority before anything is serialized, so the sampled key is never stored, ' +
        'never returned and never the authority of the deployed contract. It exists only ' +
        'inside the deploy call and must never be logged: a report is a plaintext home ' +
        'for anything put in it.',
      ],
    };
  }
  return {
    storesSigningKey: true,
    keyCopies: 2,
    where: [
      'the chosen-authority file for this vault under .midnight/, mode 0600 and gitignored. ' +
      'The door that records a chosen authority sampled it there, and it is the only ' +
      'copy anybody chose.',
      'the level private-state store, under this vault\'s address, written by this deploy ' +
      'because a single-key authority has a key to store and the SDK\'s maintenance ' +
      'interface reads exactly that slot. This is the second copy, the one nobody chose, ' +
      'and choosing a committee is what removes it.',
    ],
  };
}

/** What a hand-built vault deploy is given. */
export interface HandBuiltVaultDeployOptions {
  /** The VAULT's CompiledContract. Not the account's. */
  compiledContract: unknown;
  /**
   * The account this vault is married to, 32 bytes of hex, no prefix. Pinned in
   * the vault's ledger at creation and never redirectable.
   */
  accountAddress: string;
  /** The deliberate choice. There is no default and nothing is sampled. */
  maintenanceAuthority: MaintenanceAuthorityChoice | undefined;
}

/** What a hand-built vault deploy hands back. */
export interface HandBuiltVaultDeployResult {
  /** **THIS MUST NOT REACH A SCREEN.** See `VaultDeployResult` above. */
  contractAddress: string;
  /** The finalized deploy transaction, plus the address, plus the state. Dependency 6. */
  deployTxData: {
    public: Record<string, unknown> & { contractAddress: string; initialContractState: unknown };
  };
  /** What the state this deploy submitted actually carries, read back off it. */
  circuits: string[];
  /** Shape only. Committee size and threshold. NEVER key material. */
  authority: MaintenanceAuthorityDescription;
  /** How many signing-key copies exist for this vault now, and where. */
  custody: VaultDeployCustody;
}

/**
 * Builds the contract state a hand-built vault deploy submits. Dependencies 1,
 * 2, 3 and 7, all before a fee is spent.
 *
 * **SEPARATED FROM THE SUBMISSION ON PURPOSE.** Everything knowable before a
 * transaction exists is decided here, where a refusal costs nothing, and the
 * function that submits does no checking of its own. It is the same ordering
 * `deployVaultContract` above states in its header, made into two functions so
 * that the checks can be driven without a chain, a wallet or a proof server.
 */
export function buildVaultDeployState(
  prims: VaultDeployPrimitives,
  input: {
    /** The constructor's own state, as `createUnprovenDeployTx` returned it. */
    constructed: VaultContractStateLike;
    /** The number of coins the constructor produced, and the two offer slots. Dependency 7. */
    offer: { newCoins: number; guaranteed: unknown; fallible: unknown };
    accountAddress: string;
    authority: Exclude<MaintenanceAuthorityChoice, { kind: 'unmaintainable' }>;
  },
): { state: VaultContractStateLike; circuits: string[] } {
  const { constructed, offer, accountAddress, authority } = input;

  /*
   * DEPENDENCY 7. This path carries no zswap offer, so it refuses a constructor
   * that made one. The VAULT's constructor writes one field, the account it is
   * married to (Vault.compact:262-264), and mints nothing. The account's guard
   * says the same thing about the account's constructor; a guard describing the
   * wrong contract is a guard nobody acts on, which is why this is its own
   * sentence rather than a shared one.
   */
  if (offer.newCoins > 0 || offer.guaranteed || offer.fallible) {
    throw new Error(
      'the VAULT\'s constructor produced a zswap offer, and the hand-built vault deploy path ' +
        'does not carry offers. This is new behaviour: Vault.compact\'s constructor writes ' +
        'the account it is married to and mints nothing (Vault.compact:262-264). Coins a ' +
        'constructor produced and a deploy silently dropped are money nobody can reach, so ' +
        'this needs a deliberate change here rather than a retry.',
    );
  }

  /*
   * DEPENDENCIES 1 AND 2. The constructor's own map, checked in both directions
   * against the VAULT's list before anything is built from it. A vault missing
   * payout can be deposited into and can never pay out; a vault carrying an
   * extra entry point is not a vault. Both are refused by name, here, before a
   * fee.
   */
  assertVaultCircuitSet(opNames(constructed), 'the compiled vault');

  const state = new prims.ContractState();

  /*
   * DEPENDENCY 3, first half. The constructor's data, carried whole. This is
   * the vault's account pin, and it is checked below rather than trusted.
   */
  state.data = constructed.data;

  /*
   * THE AUTHORITY, WHICH IS WHY THIS PATH EXISTS. A committee is constructed
   * from the VERIFYING keys the choice lists, at the chosen threshold, counter
   * zero. A single key is the runtime's own, exactly as the constructor built
   * it, because the runtime made it from the key we passed and rebuilding it by
   * hand would be a second implementation of one rule, and two implementations
   * of a rule the money depends on is the more expensive mistake.
   */
  if (authority.kind === 'committee') {
    /*
     * A REFUSAL NAMES WHAT RESOLVES IT. The runtime's own
     * constructor refuses a malformed verifying key, and it refuses well:
     * measured in review as accepting nothing but a real schnorr key, with a
     * blank value, an unknown tag, non-hex, 64 zeros and both wrong lengths all
     * refused. But it refuses with `failed to fill whole buffer`, which
     * names neither the seat nor the file, and an operator holding a committee
     * file with one mistyped key has no route from that sentence to the fix.
     *
     * **AND THE ONE IT CANNOT REFUSE IS THE ONE THAT COSTS MOST: a WELL-FORMED
     * verifying key nobody holds the signing half of.** That deploys cleanly and
     * produces a vault that can never be maintained, which is the state
     * `requireHandBuiltVaultAuthority` refuses by name three functions up.
     * Nothing in this repository can tell the two apart, because possession is
     * not a property of a key. Recorded rather than fixed: proving possession
     * needs a challenge and a signature per seat, which is its own piece of
     * work.
     */
    try {
      state.maintenanceAuthority =
        new prims.ContractMaintenanceAuthority(authority.committee, authority.threshold, 0n);
    } catch (cause) {
      throw new Error(
        `the committee of ${authority.committee.length} could not be built, so one of the ` +
          'verifying keys in it is not a verifying key: ' +
          `${(cause as Error)?.message ?? String(cause)}\n` +
          'Each seat is a schnorr VERIFYING key, 32 bytes of lowercase hex, with tag ' +
          '"schnorr". The signing halves stay with their owners and must never reach this ' +
          'machine. Nothing has been spent. Fix the seat in the chosen-authority file ' +
          'for this vault under .midnight/ and run the deploy door again.\n\n' +
          'AND THE CHECK THIS CANNOT MAKE: a key that is well formed but whose signing half ' +
          'nobody holds passes here and produces a vault that can never be maintained. Every ' +
          'seat must be pasted from its owner rather than typed.',
        { cause },
      );
    }
  } else {
    state.maintenanceAuthority = constructed.maintenanceAuthority;
  }

  /*
   * DEPENDENCY 1, the build. From VAULT_CIRCUITS, which is the decided list,
   * rather than from whatever the constructor happened to compile: that is
   * the property a decided list buys, and it is the one thing the hand-built path
   * buys that the
   * SDK's does not. The assertion above has already established the two agree,
   * so this loop cannot silently drop a circuit the compiler produced.
   */
  for (const name of VAULT_CIRCUITS) {
    const op = constructed.operation(name);
    if (!op || !op.verifierKey) {
      throw new Error(
        `circuit "${name}" is one of the vault's ${VAULT_CIRCUITS.length} and the compiled ` +
          'contract has no verifier key for it. A keyless contract is unmeasurable and not ' +
          'deployable. Only the vault\'s own compile step builds these keys; a quick ' +
          'recompile wipes them, and the account\'s key build does not cover the vault.',
      );
    }
    state.setOperation(name, op);
  }

  /*
   * AND READ BACK WHAT WAS BUILT, rather than assuming setOperation did it.
   * Dependency 1's failure is a map that is wrong on chain, so the check that
   * matters is over the object about to be serialized, not over the object it
   * was copied from. This is the second of the two moments assertVaultCircuitSet
   * was written for and had never been called at.
   */
  const circuits = opNames(state).sort();
  assertVaultCircuitSet(circuits, 'the vault state this deploy would submit');

  /*
   * DEPENDENCY 3, THE QUIET HALF. The loud failure of a wrong `data` is
   * IncorrectChargedState (verify.rs:1724-1730) and the chain catches it. The
   * quiet one is a data that round-trips carrying a DIFFERENT account, and
   * neither find in this repository checks it: the vault's own find checks the
   * operations map and the verifier keys and never opens the ledger.
   *
   * A vault married to the wrong account asks the wrong contract whether a
   * payout was approved (V-37), and the pin can never be redirected afterwards,
   * so the only moment this is fixable is before submission. It refuses on an
   * unreadable state as well as on a mismatch, because at this point nothing
   * has been spent and proceeding on a state we cannot read is the third
   * outcome a read-back exists to refuse.
   *
   * **WHAT THIS PROVES AND WHAT IT DOES NOT, WRITTEN OUT BECAUSE THE FIRST DRAFT
   * CLAIMED THE WIDER THING AND IT WAS CAUGHT IN REVIEW.**
   * `accountAddress` is the operator's own input and it is what was handed to
   * the constructor. **So this is a ROUND TRIP: it proves the artefact carried
   * the pin it was given, and it catches a constructor, a `data` copy or a
   * compiled artefact that lost or altered it.** It does NOT prove that the
   * address is the company's real account: a wrong-but-well-formed one passes
   * the regex, the constructor and this comparison alike. Nothing on this path
   * reads the chain or compares against the account record, and that gap is
   * recorded rather than quietly covered by this check.
   */
  let pinned: string;
  try {
    const bytes = prims.readVaultLedger(state.data).account.bytes;
    pinned = Buffer.from(bytes).toString('hex');
  } catch (cause) {
    throw new Error(
      'the vault state this deploy would submit could not be read back through the vault\'s ' +
        'own ledger, so the account it is married to cannot be checked: ' +
        `${(cause as Error)?.message ?? String(cause)}\n` +
        'The pin is set once at creation and can never be redirected, so an unreadable ' +
        'state is refused here rather than submitted and inspected afterwards. Nothing has ' +
        'been spent. Recompiling the vault rebuilds the artefact this reader comes from.',
      { cause },
    );
  }
  if (pinned.toLowerCase() !== accountAddress.toLowerCase()) {
    throw new Error(
      'the vault state this deploy would submit is married to a DIFFERENT account than the ' +
        'one given. The account is pinned in the vault\'s ledger at creation and can never be ' +
        'redirected, so a vault deployed against the wrong one asks the wrong contract ' +
        'whether a payout was approved, for ever. Neither find in this repository would ' +
        'notice: both check the operations map and the verifier keys and never open the ' +
        'ledger. Nothing has been spent. The addresses are deliberately not printed.',
    );
  }

  return { state, circuits };
}

/**
 * The runtime primitives, resolved: whatever was injected, and a dynamic import
 * for the rest.
 *
 * **EACH GROUP IS IMPORTED ONLY IF IT WAS NOT INJECTED, AND THAT IS NOT AN
 * OPTIMISATION.** `@midnight-ntwrk/compact-runtime`,
 * `@midnight-ntwrk/midnight-js-protocol/ledger` and the vault's compiled
 * artefact are WebAssembly or depend on it. A path that loads them
 * unconditionally can only be driven against the real runtime, and the property
 * this module exists to establish, that a committee deploy stores no signing
 * key, would then be a reading of the source rather than an assertion, and an
 * assertion that cannot be run at all is worse than one nobody has watched fail.
 *
 * Nothing here decides anything. It resolves modules and returns them.
 */
export async function resolveVaultDeployPrimitives(
  injected?: Partial<VaultDeployPrimitives>,
): Promise<VaultDeployPrimitives> {
  const runtime = injected?.ContractState && injected?.ContractMaintenanceAuthority
    ? { ContractState: injected.ContractState, ContractMaintenanceAuthority: injected.ContractMaintenanceAuthority }
    : await import('@midnight-ntwrk/compact-runtime');
  const protocol = injected?.Intent && injected?.ContractDeploy
    ? { Intent: injected.Intent, ContractDeploy: injected.ContractDeploy }
    : await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const types = injected?.Transaction && injected?.SucceedEntirely !== undefined
    ? { Transaction: injected.Transaction, SucceedEntirely: injected.SucceedEntirely }
    : await import('@midnight-ntwrk/midnight-js-types');
  const utils = injected?.ttlOneHour && injected?.deserializeContractState
    ? { ttlOneHour: injected.ttlOneHour, deserializeContractState: injected.deserializeContractState }
    : await import('@midnight-ntwrk/midnight-js-utils');
  const networkId = injected?.getNetworkId
    ? { getNetworkId: injected.getNetworkId }
    : await import('@midnight-ntwrk/midnight-js-network-id');
  const vault = injected?.readVaultLedger
    ? { ledger: injected.readVaultLedger }
    : await import('../../contracts/managed-vault/contract/index.js');

  return {
    ContractState: (runtime as any).ContractState,
    ContractMaintenanceAuthority: (runtime as any).ContractMaintenanceAuthority,
    ContractDeploy: (protocol as any).ContractDeploy,
    Intent: (protocol as any).Intent,
    Transaction: (types as any).Transaction,
    SucceedEntirely: (types as any).SucceedEntirely,
    ttlOneHour: (utils as any).ttlOneHour,
    deserializeContractState: (utils as any).deserializeContractState,
    getNetworkId: (networkId as any).getNetworkId,
    readVaultLedger: (vault as any).ledger,
  };
}

/**
 * Deploys a vault whose maintenance authority may be the company's own
 * committee, and which therefore stores no signing key anywhere.
 *
 * **THE ORDER OF THE REFUSALS IS THE DESIGN**, exactly as in
 * `deployVaultContract` above: everything knowable before a fee is spent is
 * checked before a fee is spent, and everything only knowable afterwards is
 * REPORTED rather than thrown, because after the submission the address exists
 * and losing it is worse than any wrong shape it could have.
 *
 * **NOTHING HERE CALLS `deployContract`, `submitDeployTx` OR
 * `findDeployedContract`, AND THAT IS THE PROPERTY, NOT AN INCIDENTAL.** Those
 * are the three SDK entry points that write the signing-key slot:
 * `index.mjs:1184` inside `submitDeployTx`, and `:1953`/`:1961` inside
 * `setOrGetInitialSigningKey`, which `findDeployedContract` reaches at `:2053`.
 * This path uses `createUnprovenDeployTx` and `submitTx`, neither of which
 * touches the slot, and builds its own transaction from the state above.
 * **`src/midnight/vault-contract.test.ts` drives the whole path against a
 * provider that records every store access and asserts the committee case wrote
 * no key, and against fakes that record whether either forbidden entry point
 * was called at all.**
 */
export async function submitHandBuiltVaultDeployTx(
  providers: any,
  options: HandBuiltVaultDeployOptions,
  injected?: Partial<VaultDeployPrimitives>,
): Promise<HandBuiltVaultDeployResult> {
  /* Before anything else: the authority. Dependency 8. */
  const authority = requireHandBuiltVaultAuthority(options.maintenanceAuthority);

  const account = options.accountAddress?.trim();
  if (!account || !/^[0-9a-fA-F]{64}$/.test(account)) {
    throw new Error(
      'a vault is deployed married to ONE account and the address given is not 32 bytes of ' +
        'hex. The account is pinned in the vault\'s ledger at creation and can never be ' +
        'redirected, which is exactly why it is checked here rather than discovered when a ' +
        'payout asks the wrong contract whether it was approved.',
    );
  }

  const {
    createUnprovenDeployTx, submitTx, DeployTxFailedError,
  } = await import('@midnight-ntwrk/midnight-js-contracts');

  const prims = await resolveVaultDeployPrimitives(injected);

  /*
   * EVERY CIRCUIT HAS A KEY ON DISK, ASKED BEFORE A FEE IS SPENT. The
   * same check deployVaultContract makes and for the same reason: the SDK would
   * refuse too, after the wallet, the DUST wait and the proof server, naming one
   * circuit rather than the file that builds them all.
   */
  try {
    await providers.zkConfigProvider.getVerifierKeys([...VAULT_CIRCUITS]);
  } catch (cause) {
    throw new Error(
      'the vault\'s verifier keys are not on disk, so nothing can be deployed: ' +
        `${(cause as Error)?.message ?? String(cause)}\n` +
        'Only the vault\'s own compile step builds them, it takes minutes, and it must ' +
        'run before this. A quick recompile wipes them, and the account\'s key build ' +
        'does not cover the vault.',
      { cause },
    );
  }

  /*
   * The constructor, the witnesses and every compiled key, run by the SDK
   * exactly as a full deploy would run them, and NOTHING ELSE OF THE SDK'S
   * DEPLOY PATH. `signingKey` is passed only in single-key mode; in committee
   * mode the interim authority the runtime builds is REPLACED below before
   * anything is serialized, so no sampled key ever becomes the authority of a
   * deployed vault.
   *
   * **AND A KEY *IS* SAMPLED IN COMMITTEE MODE. SAY IT PLAINLY, BECAUSE THE
   * COMFORTABLE VERSION IS THE ONE THAT GETS SOMEBODY BURNED.** With no
   * `signingKey` passed, `compact-js`'s `createMaintenanceAuthority` takes its
   * none-branch (`ContractExecutable.js:277-280`) and calls `sampleSigningKey`,
   * and that key comes back on `unproven.private.signingKey`. **THE PROPERTY
   * HERE IS THAT IT IS NEVER STORED, NEVER RETURNED AND NEVER THE DEPLOYED
   * AUTHORITY, NOT THAT IT NEVER EXISTS.** So `unproven` carries key material
   * for the length of this function and must never be logged, serialized or put
   * in a report: a report is a plaintext home for anything put in it, and a key
   * that reaches one has left the only place it was meant to be. Nothing below
   * reads
   * `unproven.private.signingKey` and nothing may start to.
   * **Corrected after review found the original sentence, *"no key is passed for
   * the runtime to have sampled from"*, to be false.**
   *
   * NO `privateStateId` AND NO `initialPrivateState`. Dependency 4: the vault
   * deliberately has no SDK private state, so none is passed, none is written,
   * and there is no vault view for a second vault to read.
   */
  const unproven: any = await createUnprovenDeployTx(providers, {
    compiledContract: options.compiledContract,
    /*
     * The constructor's one argument: the account, as a contract reference.
     * `initialState(context, a_0: { bytes: Uint8Array })`, read off
     * `contracts/managed-vault/contract/index.d.ts` rather than guessed.
     */
    args: [{ bytes: Uint8Array.from(Buffer.from(account, 'hex')) }],
    ...(authority.kind === 'single-key' ? { signingKey: authority.signingKey } : {}),
  } as any);

  const tx: any = unproven.private.unprovenTx;
  const { state, circuits } = buildVaultDeployState(prims, {
    constructed: unproven.public.initialContractState,
    offer: {
      newCoins: unproven.private.newCoins?.length ?? 0,
      guaranteed: tx?.guaranteedOffer,
      fallible: tx?.fallibleOffer,
    },
    accountAddress: account,
    authority,
  });

  const ledgerState = prims.deserializeContractState(
    state.serialize(),
    { caller: 'src/midnight/vault-contract.ts:submitHandBuiltVaultDeployTx' } as any,
  );
  const contractDeploy = new prims.ContractDeploy(ledgerState);
  const contractAddress = String(contractDeploy.address);
  const unprovenTx = prims.Transaction.fromParts(
    prims.getNetworkId(),
    undefined,
    undefined,
    prims.Intent.new(prims.ttlOneHour()).addDeploy(contractDeploy),
  );

  const finalizedTxData: any = await submitTx(providers, { unprovenTx } as any);
  if (finalizedTxData.status !== prims.SucceedEntirely) {
    throw new (DeployTxFailedError as any)(finalizedTxData);
  }

  /*
   * THE POST-SUBMIT WRITES, AND WHICH OF `submitDeployTx`'s THREE THIS PATH
   * MAKES. index.mjs:1180-1185 does all three unconditionally-or-nearly; this
   * does one, conditionally.
   *
   *   THE ADDRESS: YES, through the vault's own named rule rather than raw.
   *   Dependency 5.
   *
   *   THE PRIVATE STATE: NO. Dependency 4. The vault has none, so there is
   *   nothing to write and no `<address>:undefined` key to share.
   *
   *   AND THE ORDER OF THOSE TWO IS NOT A PROPERTY, WHICH IS WORTH SAYING SO
   *   THE NEXT ROUND DOES NOT CHASE IT. Swapping them leaves every test in this
   *   file green, deliberately: the level store keys a signing key by the
   *   ADDRESS IT IS GIVEN and not by the closure variable
   *   (`midnight-js-level-private-state-provider/dist/index.mjs:823`), which the
   *   fake in `vault-contract.test.ts:196-201` mirrors and which
   *   `the signing key is filed under the VAULT's address, never the account's`
   *   already pins. The keying is the property; the ordering is not, and a test
   *   pinning it would go red on a correct refactor. Recorded after a review
   *   tried the swap and found it green.
   *   **It is NOT the same as the ADDRESS write's placement, which IS a
   *   property and is pinned: private state must never be touched before the
   *   store points at this vault.**
   *
   *   THE SIGNING KEY: ONLY WHEN THERE IS ONE. Dependency 9, and the reason
   *   this whole function exists. A committee has no single key to store, and
   *   the SDK's maintenance interface could not drive it anyway
   *   (index.mjs:398-399, :470-471, :547-548, all three verified). This is the
   *   line src/midnight/partial-contract.ts:358-360 already has on the
   *   account's path, and the second custody surface is the absence of this
   *   call.
   */
  addressVaultPrivateState(providers, contractAddress);
  if (authority.kind === 'single-key') {
    await providers.privateStateProvider.setSigningKey(contractAddress, authority.signingKey);
  }

  return {
    contractAddress,
    deployTxData: {
      public: { ...finalizedTxData, contractAddress, initialContractState: state },
    },
    circuits,
    authority: describeMaintenanceAuthority(authority),
    custody: vaultDeployCustody(authority),
  };
}
