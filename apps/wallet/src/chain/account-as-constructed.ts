import { base64 } from '@scure/base';
import { companyLabelBytes, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { readAccountDeploy } from '../../../../src/midnight/account-deploy.js';
import { heldStateFromTheStart, type HeldStateDeps } from '../../../../src/midnight/held-from-the-start.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { zkConfigOver } from '../../../../packages/web-shared/src/zk-config.js';
import { seatsInAccountState } from './company-label-on-chain.js';
import { operationsFromContractState } from 'midnight-identity/profile/contract-keys';
import type { ThisBuildsAccountKeys } from 'midnight-identity/profile/creation-sign';

/**
 * **THE ACCOUNT A DEPLOY CREATES, COMPARED WHOLE WITH THE ONE ITS CONSTRUCTOR
 * MAKES, BEFORE THIS WALLET KEEPS IT AS THE COMPANY'S.**
 *
 * The account is kept for good the moment the founding signer presses, so this
 * wallet does not take the service's word that it starts as it should. It runs
 * the account's own constructor itself, over the one seat the deploy seats and
 * the label this wallet drew, assembles the state held by this person's key
 * alone with this build's first circuits, and reads the deploy against it with
 * the very reading the service makes before it pays (`readAccountDeploy`):
 * one deploy, nothing else, held by this person's key at a threshold of one,
 * starting with nothing, and starting from exactly that state, byte for byte.
 * A second seat, a proposal already open or any field set is refused here,
 * before anything is signed or kept. The one seat is read from the deploy: this
 * wallet cannot tell whose seat it is, only that there is exactly one and that
 * the account is held by this person's key alone.
 *
 * **THE KEYS IT IS RUN WITH ARE THIS BUILD'S, CHECKED HERE**: the first step's
 * as the deploy carries them and the second step's as the page sent them, each
 * compared with this build's digests before anything is run. A key not among
 * them is refused, never fetched.
 */
export interface ConstructionDeps extends HeldStateDeps {
  /** The company account's compiled contract, with its witnesses. */
  readonly compiled: unknown;
}

/** Why the deploy is not the account its constructor makes for this person and this label, or null when it is. */
export async function startingStateRefusal(
  deps: ConstructionDeps,
  input: {
    readonly deploy: string;
    readonly label: CompanyLabel;
    readonly foundingKey: { readonly tag: string; readonly value: string };
    /** The second step's keys, as the page sent them. */
    readonly insert: ReadonlyArray<{ readonly circuit: string; readonly key: string }>;
    /** This build's digests of every key, and how a key's digest is taken. */
    readonly build: ThisBuildsAccountKeys;
    readonly digest: (b: Uint8Array) => Uint8Array;
  },
): Promise<string | null> {
  const L = deps.ledger;
  let tx: { intents?: Map<unknown, { actions?: Array<{ address?: unknown; initialState?: { serialize(): Uint8Array } }> }> };
  try {
    tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', base64.decode(input.deploy));
  } catch {
    return 'What the page sent as the deploy is not a transaction this wallet can read.';
  }
  const action = tx.intents instanceof Map && tx.intents.size === 1 ? [...tx.intents.values()][0]?.actions?.[0] : undefined;
  const state = action?.initialState;
  let seats: readonly string[];
  try {
    seats = seatsInAccountState(state!.serialize()).seats;
  } catch {
    return 'The account the deploy creates is not laid out as a company\'s account.';
  }
  if (seats.length !== 1) return 'The account the deploy creates seats someone besides you.';
  const leaf = Uint8Array.from(seats[0]!.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
  /* Every key the constructor is run with, each this build's: the first step's as the deploy carries them, the second's as sent. */
  const deployed = operationsFromContractState(state, String(action?.address ?? ''));
  if (deployed.state !== 'read') return 'The circuits the deploy runs cannot be read.';
  const keys = new Map<string, Uint8Array>([
    ...deployed.operations.map((o) => [o.name, o.verifierKey] as [string, Uint8Array]),
    ...input.insert.map((k) => [k.circuit, base64.decode(k.key)] as [string, Uint8Array]),
  ]);
  const same = (a: Uint8Array, b: Uint8Array | undefined) => b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
  for (const [step, wanted] of [['first', input.build.first], ['second', input.build.second]] as const) {
    for (const [circuit, digest] of wanted) {
      const key = keys.get(circuit);
      if (key === undefined || !same(input.digest(key), digest)) return `The ${step} step's key for "${circuit}" is not this build's.`;
    }
  }
  const zkConfig = zkConfigOver({
    artefact: async (kind: string, circuit: string) => {
      const key = keys.get(circuit);
      if (kind !== 'verifier' || key === undefined) throw new Error(`this wallet holds no checked ${kind} for "${circuit}".`);
      return key;
    },
  } as never, (circuit) => circuit);
  let expected: Uint8Array;
  try {
    const made = await heldStateFromTheStart(deps, {
      compiled: deps.compiled, zkConfig, args: [leaf, companyLabelBytes(input.label)], circuits: CREATION_STEPS.first,
      holders: { committee: [{ tag: input.foundingKey.tag, value: input.foundingKey.value.toLowerCase() }], threshold: 1 },
    });
    expected = made.serialize();
  } catch (e) {
    return `This wallet could not make the account's starting state itself (${e instanceof Error ? e.message : 'it did not run'}).`;
  }
  const verdict = readAccountDeploy(tx, {
    foundingKey: input.foundingKey,
    verifierKeys: new Map(CREATION_STEPS.first.map((c) => [c, keys.get(c)!] as [string, Uint8Array])),
    circuits: CREATION_STEPS.first,
    expectedState: expected,
  });
  return 'refusal' in verdict ? 'The account the deploy creates does not start as its own constructor makes it for you and this label.' : null;
}

/** What the constructor is run with in this wallet, loaded when the creation screen first needs it. */
export const liveConstruction = async (): Promise<ConstructionDeps> => {
  const [L, runtime, contracts, compactJs, account, accountWitnesses] = await Promise.all([
    import('@midnightntwrk/ledger-v9'),
    import('@midnight-ntwrk/compact-runtime'),
    import('@midnight-ntwrk/midnight-js-contracts'),
    import('@midnight-ntwrk/compact-js'),
    import('../../../../contracts/managed/contract/index.js'),
    import('../../../../contracts/src/witnesses.js'),
  ]);
  const CompiledContract = (compactJs as { CompiledContract: any }).CompiledContract;
  return {
    ledger: L,
    runtimeState: (runtime as { ContractState: unknown }).ContractState,
    contracts: contracts as unknown as HeldStateDeps['contracts'],
    compiled: CompiledContract.make('ConfidentialAccount', (account as { Contract: unknown }).Contract).pipe(
      CompiledContract.withWitnesses((accountWitnesses as { witnesses: unknown }).witnesses)),
  };
};
