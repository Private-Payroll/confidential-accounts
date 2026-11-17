/**
 * The partial deploy of the account, and the client that serves it.
 *
 * This is the account's. The vault's is `vault-contract.ts`, and they must not be swapped: every line below
 * exists because the account did not fit in one transaction. The account is now twenty circuits, created in two
 * steps: its deploy carries the eight `FIRST_STEP_CIRCUITS` and one maintenance update then inserts the twelve
 * `SECOND_STEP_CIRCUITS` (`deferral.ts`). This path stays because it also pins the operations map to a decided
 * list rather than to whatever compiled, and because a contract that grows past the ceiling again needs it. A
 * vault fits (four circuits, 16,040 bytesWritten, 49.4% of the ceiling), so it deploys whole through the SDK's
 * ordinary `deployContract` and reads back through its own find. `findDeployedPartialContract` refuses a full
 * deployment on purpose, which is right for the account and wrong for a vault: pointed at one it would compare
 * verifier keys against circuit names a vault has never had.
 *
 * The vault does import the maintenance-authority choice from here (`MaintenanceAuthorityChoice`,
 * `requireMaintenanceAuthority`, `describeMaintenanceAuthority`), deliberately. `deployContract` falls back to
 * `signingKey ?? sampleSigningKey()`, which gives a deployed contract a random unrecorded key, so the rule is not
 * about partiality, and two validators of it would be two copies of one rule to keep in step. The vault narrows
 * the choice further in its own module, because the SDK's full path can express only a single key.
 *
 * Which circuits deploy and which defer is `deferral.ts`'s to say. Nothing in this file carries the count.
 *
 * The SDK cannot express this deployment, in either direction, and both refusals were read out of its source.
 *
 *   Deploying. `deployContract` runs `ContractExecutable.initialize`, which fetches a verifier key for every
 *   provable circuit and raises `ContractConfigurationError("Failed to find a verifier key for circuit...")`
 *   when one is missing, and the midnight-js adapter turns a missing key file into a `ZKConfigurationReadError`
 *   even earlier. There is no silent skip in the SDK deploy path, so a deferral cannot be had by leaving keys
 *   off disk, and it cannot be had by accident, which is the right property for it to have.
 *
 *   Finding. `findDeployedContract` compares the verifier keys of every compiled circuit against the deployed
 *   state and throws `ContractTypeError` naming the deferred circuits as "undefined or have mismatched verifier
 *   keys". Against a partial deployment every call dies there, deferred or not, with an error that reads as key
 *   corruption.
 *
 * What the protocol itself says (`midnight-ledger` at `ledger-9.1.0.0-rc.3`): a partial operations map is a
 * supported state, not a loophole. `ContractDeploy::well_formed` checks that every operation it carries has a
 * verifier key, that the starting authority's counter is zero, that the balance is zero, that the charged state
 * is consistent, and that no entry point or authority exceeds the metadata size limit, and nothing about which
 * operations exist. The operation set is deliberately mutable after deploy (`SingleUpdate::VerifierKeyInsert`
 * and `VerifierKeyRemove`, and at this version `IrInsert` and `IrRemove` too), and a call to an operation the
 * contract does not hold is refused by name, `MalformedTransaction::VerifierKeyNotPresent { address, operation }`.
 * A contract is its operations map.
 *
 * So this module builds the deployment `deferral.ts` describes, a contract state carrying exactly the deployed
 * operations, using the SDK for everything it can do (the constructor run, key attachment, proving, balancing,
 * submission) and doing by hand only the one step it cannot: choosing which operations the deployed state
 * carries, and which maintenance authority sits over them. The crossing between the two WASM modules is
 * serialize and deserialize, which is how the SDK does it too. Because this is hand-built, the read-back keeps
 * the SDK's own property: deployed verifier keys are compared byte for byte against the compiled ones, for the
 * deployed circuits that exist.
 */
import {
  CREATION_STEPS,
  DEPLOYED_CIRCUITS,
  DEFERRED_CIRCUITS,
  FIRST_STEP_CIRCUITS,
  SECOND_STEP_CIRCUITS,
  assertCreationSteps,
  assertKnownCircuitSet,
} from './deferral.js';
import { buildCreationInsert, type CreationInsertPrimitives } from 'midnight-identity/profile/contract-keys';
import { authorityIn } from 'midnight-identity/profile/contract-authority';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { asContractAddress, type FinalizedTxRead } from '@midnight-ntwrk/midnight-js-types';
import { contractStateAt, servedContractStateAt } from './contract-state-at.js';
import { networkIdOf } from './providers.js';

/** The circuit names a call interface for this deployment carries. */
const DEPLOYED: ReadonlySet<string> = new Set<string>(DEPLOYED_CIRCUITS);
import type { PrivateStateAnswer } from './governed-call.js';
import {
  CIRCUITS_THAT_READ_NO_WITNESS,
  aCallInterfaceThatRefuses,
} from './governed-call.js';

/* ------------------------------------------------------------------ *
 * the maintenance authority, chosen deliberately or not at all
 * ------------------------------------------------------------------ */

/**
 * A signing or verifying key as the runtime structures it: `{ tag, value }`,
 * the tag naming the signature scheme: `'schnorr'` for every key this product
 * makes, while the ledger's committee also admits `'ecdsa'` (`midnight-ledger` at
 * `ledger-9.1.0.0-rc.3`, `onchain-state/src/state.rs:724-728`). Structural rather
 * than imported so this boundary states what it relies on.
 */
export interface TaggedKey {
  tag: string;
  value: string;
}

/**
 * The maintenance authority the deploy is given. There is NO default.
 *
 * `deployContract` falls through to `sampleSigningKey()` when no key is
 * passed, and that default gives a deployed contract a single, random,
 * unrecorded key with the power to change which proofs the contract accepts.
 * This type is the refusal: the deploy takes one of these or does not run.
 *
 *   'committee'       M-of-N, assembled by hand because the SDK helper takes
 *                     exactly one key. The ledger verifies each signature
 *                     against the committee key its index names and refuses
 *                     below the threshold with `ThresholdMissed`
 *                     (`ledger/src/verify.rs`).
 *   'single-key'      one key, DELIBERATELY, as a recorded temporary state.
 *                     `temporary.fixedBy` names what replaces it,
 *                     required, so the record exists the day the state does.
 *   'unmaintainable'  an empty committee at threshold 1 — the ledger's own
 *                     `ContractMaintenanceAuthority::new()`. No maintenance
 *                     update can ever verify, so nobody — not us, not a
 *                     stolen key — can ever change which proofs this
 *                     deployment accepts. Irreversible by construction; the
 *                     runtime documents the over-threshold state as valid
 *                     ("If the threshold is greater than the number of
 *                     committee members, it is impossible for them to sign
 *                     anything").
 */
export type MaintenanceAuthorityChoice =
  | { kind: 'committee'; committee: TaggedKey[]; threshold: number }
  | { kind: 'single-key'; signingKey: TaggedKey; temporary: { fixedBy: string } }
  | { kind: 'unmaintainable' };

/**
 * What the deploy report may say about the authority: shape, never material.
 */
export interface MaintenanceAuthorityDescription {
  kind: MaintenanceAuthorityChoice['kind'];
  committeeSize: number;
  threshold: number;
  /** Present only for 'single-key': what replaces it. */
  fixedBy?: string;
}

const AUTHORITY_OPTIONS_TEXT =
  'The deploy will not run without a maintenance authority, and it will not sample one:\n' +
  'a sampled key is one party able to change which proofs the contract accepts, alone,\n' +
  'outside the company\'s threshold — and if it is lost the contract can never be\n' +
  'maintained. Choose one of:\n' +
  '\n' +
  '  { kind: "committee", committee: [{tag,value}…], threshold: N }\n' +
  '      M-of-N verifying keys. Costs: the keys must be generated, held and\n' +
  '      recoverable by their owners before the deploy; the SDK\'s maintenance\n' +
  '      interface signs with one key, so an actual M-of-N update must also be\n' +
  '      assembled by hand when one is ever needed.\n' +
  '  { kind: "single-key", signingKey: {tag,value}, temporary: { fixedBy: "<what replaces it>" } }\n' +
  '      One key, deliberately, as a recorded temporary state. Costs: one lost\n' +
  '      or stolen key changes which proofs the contract accepts, knowingly, until\n' +
  '      what fixedBy names replaces this deployment.\n' +
  '  { kind: "unmaintainable" }\n' +
  '      No maintenance is ever possible on this deployment. Costs: a verifier-key\n' +
  '      bug is fixable only by the migration Option B already owes; there is no\n' +
  '      undo.\n' +
  '\n' +
  'The choice is a governance decision, recorded in the deploy report either way.';

/**
 * The choice, validated, or a refusal that lays the options out. Never a
 * default: an absent choice is the state where `deployContract` samples a random, unrecorded key.
 */
export function requireMaintenanceAuthority(
  choice: MaintenanceAuthorityChoice | undefined,
): MaintenanceAuthorityChoice {
  if (!choice) {
    throw new Error('no maintenance authority was given.\n\n' + AUTHORITY_OPTIONS_TEXT);
  }
  if (choice.kind === 'committee') {
    if (!Array.isArray(choice.committee) || choice.committee.length === 0) {
      throw new Error('a committee maintenance authority needs at least one verifying key. ' +
        'For "no maintenance, ever", say { kind: "unmaintainable" } — deliberately, not an empty list.');
    }
    if (!Number.isInteger(choice.threshold) || choice.threshold < 1 ||
        choice.threshold > choice.committee.length) {
      throw new Error(`a committee of ${choice.committee.length} cannot have threshold ${choice.threshold}: ` +
        'it must be an integer between 1 and the committee size. A threshold above the size ' +
        'is the unmaintainable state — say { kind: "unmaintainable" } if that is the intent.');
    }
    /* Measured on ledger 9: one holder of `K` signs once and attaches that one signature at every seat
     * holding `K`, and the update is well formed, because the signed data does not cover the signer index.
     * `[K,K,K]` at threshold 3 is not a 3-of-3, and size and range alone do not catch it.
     * `authorityValueRefusals` is the twin of this check when an update is built. */
    const seats = choice.committee.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`);
    if (new Set(seats).size !== seats.length) throw new Error(`this committee of ${seats.length} lists at least one key more than once, so it is not the ${choice.threshold}-of-${seats.length} it appears to be: one holder signs once and attaches that signature at every seat holding their key. Give each seat a distinct verifying key, or set the threshold to what the distinct holders can actually meet.`);
  }
  if (choice.kind === 'single-key' && !choice.temporary?.fixedBy?.trim()) {
    throw new Error(
      'a single-key maintenance authority is accepted only as a RECORDED temporary state: ' +
        'temporary.fixedBy must name what replaces it. A single unrecorded key is one omitted ' +
        'parameter away, and the record is the difference.',
    );
  }
  return choice;
}

export function describeMaintenanceAuthority(
  choice: MaintenanceAuthorityChoice,
): MaintenanceAuthorityDescription {
  switch (choice.kind) {
    case 'committee':
      return { kind: 'committee', committeeSize: choice.committee.length, threshold: choice.threshold };
    case 'single-key':
      return { kind: 'single-key', committeeSize: 1, threshold: 1, fixedBy: choice.temporary.fixedBy };
    case 'unmaintainable':
      return { kind: 'unmaintainable', committeeSize: 0, threshold: 1 };
  }
}

/* ------------------------------------------------------------------ *
 * the deploy
 * ------------------------------------------------------------------ */

export interface PartialDeployOptions {
  compiledContract: unknown;
  privateStateId: string;
  initialPrivateState: unknown;
  args: unknown[];
  maintenanceAuthority: MaintenanceAuthorityChoice | undefined;
}

export interface PartialDeployResult {
  deployTxData: {
    public: Record<string, unknown> & { contractAddress: string };
    private: { initialPrivateState: unknown };
  };
  /**
   * `deployed` is what this transaction carried, `inserted` what the second
   * step of the creation must still add (`submitCreationInsertTx`).
   */
  circuits: { deployed: string[]; inserted: string[]; deferred: string[] };
  authority: MaintenanceAuthorityDescription;
}

/**
 * Refuses an authority that could never sign the second step of a company's
 * creation, BEFORE anything is deployed or spent. A company is created in two
 * steps, and the second is a maintenance update signed by the authority the
 * deploy installs; with no authority, or one whose keys are not in this
 * process, the deploy would leave an account that can never be finished.
 */
export function requireCreatableAuthority(
  choice: MaintenanceAuthorityChoice | undefined,
): Extract<MaintenanceAuthorityChoice, { kind: 'single-key' }> {
  const authority = requireMaintenanceAuthority(choice);
  if (authority.kind === 'single-key') return authority;
  throw new Error(
    authority.kind === 'unmaintainable'
      ? 'an unmaintainable account cannot be created: a company is created in two steps, a deploy ' +
          'and then one maintenance update that adds the payment circuits, and an account with no ' +
          'maintenance authority can never take the second. Nothing was deployed.'
      : `a committee of ${authority.committee.length} cannot finish a company's creation from here: ` +
          'the second step is a maintenance update its members must sign, and this process holds ' +
          'none of their signing keys. Create the company with the recorded single key, and hand ' +
          'the account to the committee afterwards. Nothing was deployed.',
  );
}

/** Entry-point names as strings, whatever the runtime hands back. */
/**
 * The refusal for a deploy the chain did not apply whole. It names the chain's status and the address the deploy
 * took, and carries no key: the deploy's signing key never travels in an error, since errors are logged.
 */
export const notDeployed = (record: FinalizedTxRead, contractAddress: string): Error => new Error(
  `the chain did not apply this deploy whole (it answered ${record.status}), so the contract at '${contractAddress}' `
    + 'may hold none of the state this deploy gave it. Nothing was written to this device. Read the address on the '
    + 'chain before deploying again.',
);

const opNames = (state: { operations(): Array<string | Uint8Array> }): string[] =>
  state.operations().map((n) => (typeof n === 'string' ? n : new TextDecoder().decode(n)));

/**
 * Builds, proves, balances and submits the partial deploy.
 *
 * The SDK runs the constructor and attaches EVERY compiled verifier key — this
 * project holds them all; deferral is a property of the deployment, not of
 * the key directory. The state is then REBUILT carrying only the deployed
 * circuits, because `setOperation` cannot remove: a fresh `ContractState` takes
 * the constructor's own `data` and the chosen authority, and only the kept
 * operations. Everything a deploy writes except the operations map is
 * therefore the constructor's own work, unmodified.
 */
export async function submitPartialDeployTx(
  providers: any,
  options: PartialDeployOptions,
): Promise<PartialDeployResult> {
  const authority = requireCreatableAuthority(options.maintenanceAuthority);
  assertCreationSteps();

  const { createUnprovenDeployTx, submitTx } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { SucceedEntirely, LedgerTransaction } = await import('@midnight-ntwrk/midnight-js-types');
  const { ttlOneHour, deserializeLedger9ContractState } = await import('@midnight-ntwrk/midnight-js-utils');
  const { Intent, ContractDeploy, Transaction } = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const networkId = networkIdOf(providers);
  /* Dynamic like every other WASM-adjacent import in this layer: the runtime
   * loads when a deploy actually runs, not when the module is looked at. */
  const { ContractState, ContractMaintenanceAuthority } = await import('@midnight-ntwrk/compact-runtime');

  /*
   * The constructor, the witnesses and every compiled key, run by the SDK
   * exactly as a full deploy would run them. `signingKey` is passed only in
   * single-key mode; in the other modes the interim authority the runtime
   * builds is REPLACED below before anything is serialized, so no sampled key
   * ever becomes the authority of a deployed contract.
   */
  const unproven: any = await createUnprovenDeployTx(providers, {
    compiledContract: options.compiledContract,
    args: options.args,
    privateStateId: options.privateStateId,
    initialPrivateState: options.initialPrivateState,
    ...(authority.kind === 'single-key' ? { signingKey: authority.signingKey } : {}),
  } as any);

  /*
   * This path carries no zswap offer, so it refuses a constructor that made
   * one. The account's constructor mints nothing — it writes commitments — and
   * if that ever changes, this deploy must learn to carry the offer rather
   * than silently dropping coins the constructor produced.
   */
  const tx: any = unproven.private.unprovenTx;
  if ((unproven.private.newCoins?.length ?? 0) > 0 || tx.guaranteedOffer || tx.fallibleOffer) {
    throw new Error(
      'the constructor produced a zswap offer, and the partial deploy path does not carry ' +
        'offers. This is new behaviour — the account constructor has never minted — and it ' +
        'needs a deliberate change here, not a retry.',
    );
  }

  const full: any = unproven.public.initialContractState;
  assertKnownCircuitSet(opNames(full));

  /* The state the chain gets: the constructor's data, the chosen authority,
   * and exactly the first step's operations. The second step inserts the rest. */
  const pruned: any = new ContractState();
  pruned.data = full.data;
  // Single key: built by the runtime from the key passed above. The other two kinds are
  // refused before this point, because neither could sign the second step.
  pruned.maintenanceAuthority = full.maintenanceAuthority;
  void ContractMaintenanceAuthority;
  for (const name of FIRST_STEP_CIRCUITS) {
    const op = full.operation(name);
    if (!op || !op.verifierKey) {
      throw new Error(
        `circuit "${name}" is in the deployed list and the compiled contract has no verifier ` +
          'key for it. A keyless contract is unmeasurable, not cheap, and not ' +
          'deployable either. Rebuild the keys and run again.',
      );
    }
    pruned.setOperation(name, op);
  }

  const ledgerState = deserializeLedger9ContractState(pruned.serialize(), { caller: 'submitPartialDeployTx' });
  const contractDeploy = new ContractDeploy(ledgerState);
  const contractAddress = String(contractDeploy.address);
  const unprovenTx = LedgerTransaction.seal('v9', 'Unproven', Transaction.fromParts(
    networkId,
    undefined,
    undefined,
    Intent.new(ttlOneHour()).addDeploy(contractDeploy),
  ));

  const finalizedTxData = await submitTx(providers, { unprovenTx });
  if (finalizedTxData.status !== SucceedEntirely) throw notDeployed(finalizedTxData, contractAddress);

  /*
   * The same post-submit writes `submitDeployTx` performs
   * (in the SDK's `midnight-js-contracts`), against the PRUNED
   * deploy's address: the provider's contract address is set BEFORE the
   * private state is written, so the state lands under this contract's prefix
   * and no other. The signing key is stored only when a single key
   * exists — a committee has no single key to store, and the SDK's
   * maintenance interface could not drive it anyway.
   */
  await providers.privateStateProvider.forContract(contractAddress)
    .set(options.privateStateId, unproven.private.initialPrivateState);
  if (authority.kind === 'single-key') {
    await providers.privateStateProvider.setSigningKey(contractAddress, authority.signingKey);
  }

  return {
    deployTxData: {
      public: { ...finalizedTxData, contractAddress },
      private: { initialPrivateState: unproven.private.initialPrivateState },
    },
    circuits: {
      deployed: [...FIRST_STEP_CIRCUITS],
      inserted: [...SECOND_STEP_CIRCUITS],
      deferred: [...DEFERRED_CIRCUITS],
    },
    authority: describeMaintenanceAuthority(authority),
  };
}

/* ------------------------------------------------------------------ *
 * the second step of a company's creation
 * ------------------------------------------------------------------ */

/*
 * The second step's builder, and how a key file's version is read, are one
 * module the founding signer's wallet, the page and this service share; they
 * are re-exported here so every existing caller keeps its import.
 */
export {
  buildCreationInsert, operationVersionOfKeyFile, type CreationInsertPrimitives,
} from 'midnight-identity/profile/contract-keys';

/**
 * THE SECOND STEP, SIGNED AND SUBMITTED. Reads the account, builds the insert,
 * signs it with the single key the deploy installed, and submits it.
 *
 * It can be run again after a failure: it reads what the account carries first,
 * does nothing when the step has already landed, and refuses a half-landed one
 * rather than inserting twice.
 */
export async function submitCreationInsertTx(
  providers: any,
  options: {
    contractAddress: string;
    maintenanceAuthority: MaintenanceAuthorityChoice | undefined;
  },
): Promise<{ inserted: string[]; public: Record<string, unknown> }> {
  const authority = requireCreatableAuthority(options.maintenanceAuthority);
  assertCreationSteps();
  const { submitTx, TxFailedError } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { SucceedEntirely, LedgerTransaction } = await import('@midnight-ntwrk/midnight-js-types');
  const { ttlOneHour } = await import('@midnight-ntwrk/midnight-js-utils');
  const L = await import('@midnight-ntwrk/midnight-js-protocol/v9');
  const networkId = networkIdOf(providers);

  const state = await contractStateAt(providers.publicDataProvider, options.contractAddress);
  if (!state) throw new Error(`no contract is deployed at '${options.contractAddress}'`);
  const held = authorityIn(state);
  if ('why' in held) {
    throw new Error(`the account at '${options.contractAddress}' carries a maintenance authority that cannot be read (${held.why.replace(/\.$/u, '')}); nothing was built.`);
  }
  const counter = held.counter;
  // Already landed, for instance by an earlier attempt whose answer was lost: nothing to do.
  // `verifyContractState` in the read-back still compares every key byte for byte.
  if (SECOND_STEP_CIRCUITS.every((name) => opNames(state).includes(name))) {
    return { inserted: [], public: {} };
  }
  const keys = new Map<string, Uint8Array>(
    await providers.zkConfigProvider.getVerifierKeys([...SECOND_STEP_CIRCUITS]) as Array<[string, Uint8Array]>,
  );
  const built = buildCreationInsert(L as CreationInsertPrimitives, {
    address: options.contractAddress,
    counter,
    onChain: opNames(state),
    keys,
    steps: CREATION_STEPS,
  });
  const update = built.update as any;
  const signed = update.addSignature(0n, L.signData(authority.signingKey as any, update.dataToSign));
  const unprovenTx = LedgerTransaction.seal('v9', 'Unproven', L.Transaction.fromParts(
    networkId, undefined, undefined, L.Intent.new(ttlOneHour()).addMaintenanceUpdate(signed),
  ));
  const result = await submitTx(providers, { unprovenTx });
  if (result.status !== SucceedEntirely) {
    throw new TxFailedError('insert-verifier-key', result, {
      contractAddress: asContractAddress(options.contractAddress), circuitId: built.inserted.join(','),
    });
  }
  return { inserted: built.inserted, public: { ...result } };
}

/* ------------------------------------------------------------------ *
 * the find, partial-aware
 * ------------------------------------------------------------------ */

/**
 * `findDeployedContract`, for the deployment we actually made: the account's.
 *
 * A vault has its own, `findDeployedVaultContract` in `vault-contract.ts`. This one refuses a full deployment by
 * design (see the deferred-absence check below), which is correct for the account and would be a confusing
 * failure against a vault.
 *
 * It compares the deployed verifier keys byte for byte against the compiled ones, through the SDK's own
 * `verifyContractState`, for the circuits the deployment carries, and adds the check the SDK cannot express: the
 * deferred circuits must be absent. An operation appearing under a deferred name means this is not the
 * deployment the address file describes, or someone has maintained the contract; either way it is not a state to
 * build calls on.
 *
 * That second check is inert while `DEFERRED_CIRCUITS` is empty. It iterates the deferred list, so with nothing
 * deferred it can never fire, and a deployment carrying an operation nobody decided on, one inserted by a
 * maintenance update say, is not refused by name. The key comparison still refuses a deployment that is missing
 * or has changed any of the circuits it deploys. Refusing "any operation outside `DEPLOYED_CIRCUITS`" would be a
 * new check and is not made here.
 */
export async function findDeployedPartialContract(
  providers: any,
  options: {
    compiledContract: unknown;
    contractAddress: string;
    /**
     * Where this contract's private state is filed. It is required: the interface this function hands back is the
     * one every governed call on the account is eventually made through, so an omitted answer would be a whole call
     * interface whose every circuit ran with no private state and therefore no signer behind it, silently, because
     * the scheme omits the field on a falsy value and then tests for it by presence.
     *
     * `null` is the answer for a read that calls no circuit, and for the
     * circuits the contract leaves open to anybody. It is a claim rather than
     * a shrug, and it is checked against the circuit when one is named.
     */
    privateStateId: PrivateStateAnswer;
  },
): Promise<{ callTx: any }> {
  const { verifyContractState, createCircuitCallTxInterface } =
    await import('@midnight-ntwrk/midnight-js-contracts');

  const { compiledContract, contractAddress } = options;
  const served = await servedContractStateAt(providers.publicDataProvider, contractAddress);
  const state = served === null ? null : served.deserialize({ v9: ContractState });
  if (!served || !state) {
    throw new Error(`no contract is deployed at '${contractAddress}'`);
  }

  /* A company whose second step has not landed is not finished, and is refused by
   * name before the key comparison would report it as a key mismatch. */
  const unfinished = SECOND_STEP_CIRCUITS.filter((name) => !state.operation(name));
  if (unfinished.length > 0 && FIRST_STEP_CIRCUITS.every((name) => state.operation(name))) {
    throw new Error(
      `the account at '${contractAddress}' was deployed and its creation was not finished: it does ` +
        `not carry ${unfinished.join(', ')}, which the second step of a company's creation inserts. ` +
        'Run the second step (submitCreationInsertTx) with the authority the deploy installed; ' +
        'until then the account can pay nothing.',
    );
  }

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys([...DEPLOYED_CIRCUITS]);
  await verifyContractState(verifierKeys, served, asContractAddress(contractAddress));

  const present = DEFERRED_CIRCUITS.filter((name) => state.operation(name));
  if (present.length > 0) {
    throw new Error(
      `the contract at '${contractAddress}' holds operations this client defers: ` +
        `${present.join(', ')}. This client serves the ${DEPLOYED_CIRCUITS.length}-circuit ` +
        'deployment `deferral.ts` describes; a contract carrying a deferred circuit is either a ' +
        'different deployment or one whose operations were changed by a maintenance update. ' +
        'Refusing to call it is the safe answer either way.',
    );
  }

  /*
   * `createCircuitCallTxInterface` sets the provider's contract address
   * itself (the SDK's `findDeployedContract` does the same), so
   * every call built from this interface stages against this address.
   *
   * A circuit that reads no witness is answered `null` here and handed to the SDK as no id at all: the SDK
   * carries any id other than `undefined` onto the call and refuses a `null` one there, so a `null` passed
   * through would refuse every such call, the sweep of an expired run among them.
   *
   * The interface carries the answer it was given, so that naming a circuit the answer does not suit is a refusal
   * rather than a call. The check cannot be made here: this function is handed one answer for every circuit and
   * does not know which one anybody will name. Made at the moment a circuit is named, it also reaches callers that
   * go nowhere near the account client.
   */
  return {
    callTx: aCallInterfaceThatRefuses(
      createCircuitCallTxInterface(
        providers, compiledContract as any, contractAddress as any,
        options.privateStateId ?? undefined) as object,
      options.privateStateId,
      CIRCUITS_THAT_READ_NO_WITNESS,
      /*
       * The names this interface carries, from the same list the verifier-key
       * comparison above is made against - so the guard is switched on by this
       * client's own decision about the deployment rather than by the shape of
       * the object the scheme happened to build.
       */
      DEPLOYED,
    ),
  };
}
