/**
 * THE PARTIAL DEPLOY, AND THE CLIENT THAT SERVES IT. S8c.
 *
 * **THIS IS THE ACCOUNT'S. THE VAULT'S IS `src/midnight/vault-contract.ts`,
 * AND THEY MUST NOT BE SWAPPED.** `S6e`, and the distinction is not stylistic:
 * every line below exists because the ACCOUNT did not fit in one transaction
 * and deployed eleven of thirteen circuits. **Since S23 shed two circuits and
 * S25 emptied the deferred list the account is eleven of eleven and defers
 * nothing** — this path stays because it is also what pins the operations map
 * to a decided list rather than to whatever compiled (`C224`), and because a
 * contract that grows past the ceiling again needs it back. **A vault fits — four circuits,
 * 16,040 bytesWritten, 49.4% of the ceiling — so it deploys whole, through the
 * SDK's ordinary `deployContract`, and reads back through its own find.**
 * `findDeployedPartialContract` below refuses a FULL deployment on purpose
 * (`C231`), which is right for the account and wrong for a vault; pointed at
 * one it would compare verifier keys against circuit names a vault has never
 * had.
 *
 * **The one thing the vault DOES import from here is the maintenance-authority
 * choice** — `MaintenanceAuthorityChoice`, `requireMaintenanceAuthority`,
 * `describeMaintenanceAuthority` — and that is deliberate rather than an
 * oversight. `C225` is `deployContract`'s own `signingKey ?? sampleSigningKey()`
 * default, which is the FULL deploy path's defect before it is anybody else's,
 * so the rule is not about partiality and two validators of it would be
 * `M-104`. The vault narrows the choice further in its own module, because the
 * SDK's full path can express only a single key.
 *
 * How many circuits deploy and which defer is `src/midnight/deferral.ts`'s
 * to say — S8b deferred four of the fifteen; S9 re-decided the split to
 * thirteen deployed, two deferred; S25 emptied the deferred list, so all
 * eleven the contract now compiles deploy. Nothing in this file carries the
 * count, which is why none of that changed a line of code here.
 *
 * The SDK cannot express this deployment, in either direction, and both
 * refusals were read out of source rather than assumed:
 *
 *   DEPLOYING. `deployContract` runs `ContractExecutable.initialize`, which
 *   fetches a verifier key for EVERY provable circuit and raises
 *   `ContractConfigurationError("Failed to find a verifier key for circuit…")`
 *   when one is missing (`@midnight-ntwrk/compact-js/dist/esm/effect/
 *   ContractExecutable.js:100-118`) — and the midnight-js adapter turns a
 *   missing key file into a `ZKConfigurationReadError` failure even earlier
 *   (`midnight-js-types/dist/index.mjs:36-46`). There is NO silent skip in the
 *   SDK deploy path: the skip `S8a` recorded as a hazard lives in our own
 *   instrument (`scripts/measure-deploy-shape.ts:221`), not in the SDK. So a
 *   deferral cannot be had by leaving keys off disk — the SDK would refuse to
 *   deploy at all — and it cannot be had by accident, which is the right
 *   property for it to have.
 *
 *   FINDING. `findDeployedContract` compares the verifier keys of EVERY
 *   compiled circuit against the deployed state
 *   (`midnight-js-contracts/dist/index.mjs:2051-2052`) and throws
 *   `ContractTypeError` naming the deferred circuits as "undefined or
 *   have mismatched verifier keys". Against a partial deployment,
 *   EVERY call dies there — deferred or not — with an error that reads as key
 *   corruption.
 *
 * What the protocol itself says, also from source: a partial operations map is
 * a supported state, not a loophole. `ContractDeploy::well_formed` checks
 * balance-zero and charged-state consistency and nothing about which
 * operations exist (`midnight-src/midnight-ledger/ledger/src/verify.rs:
 * 1707-1730`); the operation set is deliberately mutable after deploy
 * (`SingleUpdate::VerifierKeyInsert`/`Remove`, `structure.rs:2692-2696`); and
 * a call to an operation the contract does not hold is refused by name —
 * `MalformedTransaction::VerifierKeyNotPresent { address, operation }`
 * (`verify.rs:104-119`). A contract IS its operations map.
 *
 * So this module builds the deployment the decision describes — the contract
 * state carrying exactly the deployed operations `src/midnight/deferral.ts`
 * names — using the SDK for everything it CAN do (the constructor run, key
 * attachment, proving, balancing, submission) and doing by hand only the one
 * step it cannot: choosing which operations the deployed state carries, and
 * which maintenance authority sits over them. The crossing between the two
 * WASM modules is serialize/deserialize, which is how the SDK does it too
 * (`index.mjs:934`).
 *
 * M-16 is the standing warning about doing SDK work by hand, and it is
 * answered rather than ignored: the SDK has no partial deploy to call, the
 * assembly below is the instrument's measured construction
 * (`scripts/measure-deploy-shape.ts`, whose transactions produced every number
 * the architecture was chosen on), and the read-back verification keeps M-9's
 * property — deployed verifier keys are compared byte-for-byte against the
 * compiled ones, for the deployed circuits that exist.
 */
import {
  DEPLOYED_CIRCUITS,
  DEFERRED_CIRCUITS,
  assertKnownCircuitSet,
} from './deferral.js';

/* ------------------------------------------------------------------ *
 * the maintenance authority, chosen deliberately or not at all
 * ------------------------------------------------------------------ */

/**
 * A signing or verifying key as the runtime structures it: `{ tag, value }`,
 * the tag naming the signature scheme (today `'schnorr'`). Structural rather
 * than imported so this boundary states what it relies on.
 */
export interface TaggedKey {
  tag: string;
  value: string;
}

/**
 * The maintenance authority the deploy is given. There is NO default. C225.
 *
 * `deployContract` falls through to `sampleSigningKey()` when no key is
 * passed (`midnight-js-contracts/dist/index.mjs:1907`), and that default is
 * how every account this project ever deployed acquired a single, random,
 * unrecorded key with the power to change which proofs the contract accepts.
 * This type is the refusal: the deploy takes one of these or does not run.
 *
 *   'committee'       M-of-N, assembled by hand because the SDK helper takes
 *                     exactly one key. The ledger verifies each signature
 *                     against the committee key its index names and refuses
 *                     below the threshold with `ThresholdMissed`
 *                     (`ledger/src/verify.rs:1775-1795`).
 *   'single-key'      one key, DELIBERATELY, as a recorded temporary state.
 *                     `temporary.fixedBy` names the round that replaces it —
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
  /** Present only for 'single-key': the round that replaces it. */
  fixedBy?: string;
}

const AUTHORITY_OPTIONS_TEXT =
  'The deploy will not run without a maintenance authority, and it will not sample one:\n' +
  'a sampled key is one party able to change which proofs the contract accepts, alone,\n' +
  'outside the company\'s threshold — and if it is lost the contract can never be\n' +
  'maintained (C225). Choose one of:\n' +
  '\n' +
  '  { kind: "committee", committee: [{tag,value}…], threshold: N }\n' +
  '      M-of-N verifying keys. Costs: the keys must be generated, held and\n' +
  '      recoverable by their owners before the deploy; the SDK\'s maintenance\n' +
  '      interface signs with one key, so an actual M-of-N update must also be\n' +
  '      assembled by hand when one is ever needed.\n' +
  '  { kind: "single-key", signingKey: {tag,value}, temporary: { fixedBy: "<round>" } }\n' +
  '      One key, deliberately, as a recorded temporary state. Costs: everything\n' +
  '      C225 says, knowingly, until the named round replaces this deployment.\n' +
  '  { kind: "unmaintainable" }\n' +
  '      No maintenance is ever possible on this deployment. Costs: a verifier-key\n' +
  '      bug is fixable only by the migration Option B already owes; there is no\n' +
  '      undo.\n' +
  '\n' +
  'The choice is a governance decision, recorded in the deploy report either way.';

/**
 * The choice, validated, or a refusal that lays the options out. Never a
 * default: an absent choice is exactly the state C225 describes.
 */
export function requireMaintenanceAuthority(
  choice: MaintenanceAuthorityChoice | undefined,
): MaintenanceAuthorityChoice {
  if (!choice) {
    throw new Error('no maintenance authority was given.\n\n' + AUTHORITY_OPTIONS_TEXT);
  }
  if (choice.kind === 'committee') {
    if (!Array.isArray(choice.committee) || choice.committee.length === 0) {
      throw new Error(
        'a committee maintenance authority needs at least one verifying key. ' +
          'For "no maintenance, ever", say { kind: "unmaintainable" } — deliberately, not as an empty list.',
      );
    }
    if (
      !Number.isInteger(choice.threshold) ||
      choice.threshold < 1 ||
      choice.threshold > choice.committee.length
    ) {
      throw new Error(
        `a committee of ${choice.committee.length} cannot have threshold ${choice.threshold}: ` +
          'it must be an integer between 1 and the committee size. A threshold above the size ' +
          'is the unmaintainable state — say { kind: "unmaintainable" } if that is the intent.',
      );
    }
  }
  if (choice.kind === 'single-key' && !choice.temporary?.fixedBy?.trim()) {
    throw new Error(
      'a single-key maintenance authority is accepted only as a RECORDED temporary state: ' +
        'temporary.fixedBy must name the round that replaces it. C225 is one omitted ' +
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
  circuits: { deployed: string[]; deferred: string[] };
  authority: MaintenanceAuthorityDescription;
}

/** Entry-point names as strings, whatever the runtime hands back. */
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
  const authority = requireMaintenanceAuthority(options.maintenanceAuthority);

  const {
    createUnprovenDeployTx, submitTx, DeployTxFailedError,
  } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { SucceedEntirely, Transaction } = await import('@midnight-ntwrk/midnight-js-types');
  const { ttlOneHour, deserializeContractState } = await import('@midnight-ntwrk/midnight-js-utils');
  const { getNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  const { Intent, ContractDeploy } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
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
   * and exactly the deployed operations the deferral list names. */
  const pruned: any = new ContractState();
  pruned.data = full.data;
  pruned.maintenanceAuthority =
    authority.kind === 'committee'
      ? new ContractMaintenanceAuthority(authority.committee as any, authority.threshold, 0n)
      : authority.kind === 'unmaintainable'
        ? new ContractMaintenanceAuthority([], 1, 0n)
        : full.maintenanceAuthority; // single-key: built by the runtime from the key we passed
  for (const name of DEPLOYED_CIRCUITS) {
    const op = full.operation(name);
    if (!op || !op.verifierKey) {
      throw new Error(
        `circuit "${name}" is in the deployed list and the compiled contract has no verifier ` +
          'key for it. A keyless contract is unmeasurable, not cheap (C224) — and not ' +
          'deployable either. Rebuild the keys and run again.',
      );
    }
    pruned.setOperation(name, op);
  }

  const ledgerState = deserializeContractState(
    pruned.serialize(),
    { caller: 'src/midnight/partial-contract.ts:submitPartialDeployTx' } as any,
  );
  const contractDeploy: any = new (ContractDeploy as any)(ledgerState);
  const contractAddress = String(contractDeploy.address);
  const unprovenTx = (Transaction as any).fromParts(
    getNetworkId(),
    undefined,
    undefined,
    (Intent as any).new(ttlOneHour()).addDeploy(contractDeploy),
  );

  const finalizedTxData: any = await submitTx(providers, { unprovenTx } as any);
  if (finalizedTxData.status !== SucceedEntirely) {
    throw new (DeployTxFailedError as any)(finalizedTxData);
  }

  /*
   * The same post-submit writes `submitDeployTx` performs
   * (`midnight-js-contracts/dist/index.mjs:1180-1185`), against the PRUNED
   * deploy's address: the provider's contract address is set BEFORE the
   * private state is written, so the state lands under this contract's prefix
   * and no other (C228). The signing key is stored only when a single key
   * exists — a committee has no single key to store, and the SDK's
   * maintenance interface could not drive it anyway.
   */
  providers.privateStateProvider.setContractAddress(contractAddress);
  await providers.privateStateProvider.set(options.privateStateId, unproven.private.initialPrivateState);
  if (authority.kind === 'single-key') {
    await providers.privateStateProvider.setSigningKey(contractAddress, authority.signingKey);
  }

  return {
    deployTxData: {
      public: { ...finalizedTxData, contractAddress },
      private: { initialPrivateState: unproven.private.initialPrivateState },
    },
    circuits: { deployed: [...DEPLOYED_CIRCUITS], deferred: [...DEFERRED_CIRCUITS] },
    authority: describeMaintenanceAuthority(authority),
  };
}

/* ------------------------------------------------------------------ *
 * the find, partial-aware
 * ------------------------------------------------------------------ */

/**
 * `findDeployedContract`, for the deployment we actually made — THE ACCOUNT'S.
 *
 * A vault has its own: `findDeployedVaultContract` in
 * `src/midnight/vault-contract.ts`. This one refuses a full deployment by
 * design (see the deferred-absence check below), which is correct for the
 * account and would be a confusing failure against a vault. `S6e`.
 *
 * Keeps M-9's property — the deployed verifier keys are compared
 * byte-for-byte against the compiled ones via the SDK's own
 * `verifyContractState` — for the circuits the deployment carries, and
 * adds the check the SDK cannot express: the deferred circuits must be
 * ABSENT. An operation appearing under a deferred name means this is not the
 * deployment the address file describes, or someone has
 * maintained the contract — either way, not a state to build calls on.
 *
 * **THAT SECOND CHECK IS INERT AS OF S25, BECAUSE `DEFERRED_CIRCUITS` IS
 * EMPTY.** It iterates the deferred list, so with nothing deferred it can
 * never fire, and a deployment carrying an operation NOBODY DECIDED ON — one
 * inserted by a maintenance update, say — is no longer refused by name. The
 * key comparison above still refuses a deployment that is missing or has
 * changed any of the eleven, which is what catches the live 28 Aug contract.
 * Widening this to "no operation outside `DEPLOYED_CIRCUITS`" is a new check,
 * not a deletion, so S25 filed it rather than writing it.
 */
export async function findDeployedPartialContract(
  providers: any,
  options: { compiledContract: unknown; contractAddress: string; privateStateId?: string },
): Promise<{ callTx: any }> {
  const { verifyContractState, createCircuitCallTxInterface } =
    await import('@midnight-ntwrk/midnight-js-contracts');

  const { compiledContract, contractAddress } = options;
  const state: any = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    throw new Error(`no contract is deployed at '${contractAddress}'`);
  }

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys([...DEPLOYED_CIRCUITS]);
  verifyContractState(verifierKeys as any, state);

  const present = DEFERRED_CIRCUITS.filter((name) => state.operation(name));
  if (present.length > 0) {
    throw new Error(
      `the contract at '${contractAddress}' holds operations this client defers: ` +
        `${present.join(', ')}. This client serves the ${DEPLOYED_CIRCUITS.length}-circuit ` +
        'deployment src/midnight/deferral.ts describes (S8b Option B; the split re-decided ' +
        'by S9); a contract carrying a deferred circuit is either a ' +
        'different deployment or one whose operations were changed by a maintenance update. ' +
        'Refusing to call it is the safe answer either way.',
    );
  }

  /*
   * `createCircuitCallTxInterface` sets the provider's contract address
   * itself (`index.mjs:1876` does the same in `findDeployedContract`), so
   * every call built from this interface stages against this address.
   */
  return {
    callTx: createCircuitCallTxInterface(
      providers, compiledContract as any, contractAddress as any, options.privateStateId as any),
  };
}
