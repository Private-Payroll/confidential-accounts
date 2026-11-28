/**
 * Every frozen fact of the build on disk, worked out from the compiled contracts themselves: each contract's
 * `contract-info.json` (its fields, witnesses and the circuits it calls), its constructor (how a new contract
 * stores each field), its pure circuits on two fixed input sets, its compiled JavaScript (which fields each proving
 * circuit writes), what a device keeps for it, its own compiled code at fixed addresses, and the wallet's side of the
 * registry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONTRACT_TABLE } from '../../scripts/contract-sources.mjs';
import { addressFactsOf } from './facts-at-an-address.js';
import type {
  CompiledJson,
  ContractFacts,
  DerivationFact,
  LedgerFieldFact,
  RecordedContract,
  VersionFacts
} from './frozen-facts.js';
import { registryFactsInTheWallet } from './registry-facts-in-the-wallet.js';
import { DEVICE_STATE, initialStateOf, PURE } from './the-compiled-contracts.js';
import { fixedInputsOf, fromJson, INPUT_SETS, toJson, type CompiledType, type JsonValue } from './values-in-json.js';
import { writesOfCircuits } from './writes-in-the-compiled-code.js';

const ROOT = join(import.meta.dirname, '..', '..');

interface CompiledCircuit {
  readonly name: string;
  readonly pure: boolean;
  readonly proof: boolean;
  readonly arguments: readonly { readonly name: string; readonly type: CompiledType }[];
}

interface CompiledInfo {
  readonly circuits: readonly CompiledCircuit[];
  readonly witnesses: readonly CompiledJson[];
  readonly contracts: readonly CompiledJson[];
  readonly ledger: readonly LedgerFieldFact[];
}

const compiledFile = (contract: RecordedContract, file: string): string =>
  readFileSync(join(ROOT, CONTRACT_TABLE[contract].compiled, file), 'utf8');

/** A contract's `contract-info.json`, every `maxval` kept as its digits, which a JSON number would round. */
function infoOf(contract: RecordedContract): CompiledInfo {
  const info: CompiledInfo = JSON.parse(
    compiledFile(contract, 'compiler/contract-info.json').replace(/"maxval": (\d+)/gu, '"maxval": "$1"')
  );
  if (
    !Array.isArray(info.circuits) ||
    !Array.isArray(info.ledger) ||
    !Array.isArray(info.witnesses) ||
    !Array.isArray(info.contracts)
  ) {
    throw new Error(`the ${contract}'s contract-info.json is not laid out as a compiled contract's`);
  }
  return info;
}

/** How a new contract stores each field, in order: a cell, a map, an array or a tree. */
async function slotsOf(contract: RecordedContract): Promise<string[]> {
  const fields = (await initialStateOf(contract)).data.state.asArray();
  if (fields === undefined) throw new Error(`a new ${contract}'s state is not an array of fields`);
  return fields.map((f) => f.type());
}

/** One derivation run on its inputs: what it returned, or the words it refused with. */
function runOn(fn: unknown, inputs: readonly JsonValue[], name: string): DerivationFact {
  if (typeof fn !== 'function') throw new Error(`the build has no pure circuit ${name}`);
  try {
    return { inputs, output: toJson(Reflect.apply(fn, undefined, inputs.map(fromJson))) };
  } catch (e) {
    return { inputs, refused: e instanceof Error ? e.message : String(e) };
  }
}

/** Every pure circuit of a contract, run on each input set: the recorded inputs when given, or the fixed ones. */
function derivationsOf(
  contract: RecordedContract,
  info: CompiledInfo,
  recorded?: ContractFacts
): Record<string, DerivationFact[]> {
  return Object.fromEntries(
    info.circuits
      .filter((c) => c.pure)
      .map((c) => [
        c.name,
        INPUT_SETS.map((set, i) => {
          const inputs =
            recorded?.derivations[c.name]?.[i]?.inputs ??
            fixedInputsOf(
              c.arguments.map((a) => a.type),
              set
            );
          return runOn(Reflect.get(PURE[contract], c.name), inputs, c.name);
        })
      ])
  );
}

/** The kind of one value a device keeps: bytes, a number, a flag, nothing, a list or a record. */
const kindOf = (v: unknown): string =>
  v instanceof Uint8Array
    ? 'bytes'
    : v === null
      ? 'nothing'
      : Array.isArray(v)
        ? 'list'
        : typeof v === 'object'
          ? 'record'
          : typeof v;

/** What a device keeps for a contract, by name, sorted. */
const deviceOf = (contract: RecordedContract): Record<string, string> =>
  Object.fromEntries(
    Object.entries(DEVICE_STATE[contract])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, kindOf(v)])
  );

/** Every fact of one contract. */
async function contractFactsOf(contract: RecordedContract, recorded?: ContractFacts): Promise<ContractFacts> {
  const info = infoOf(contract);
  const fields = info.ledger;
  const proving = info.circuits.filter((c) => c.proof).map((c) => c.name);
  return {
    fields,
    slots: await slotsOf(contract),
    derivations: derivationsOf(contract, info, recorded),
    writes: writesOfCircuits(
      compiledFile(contract, 'contract/index.js'),
      proving,
      fields.map((f) => f.name)
    ),
    witnesses: info.witnesses,
    calls: info.contracts,
    device: deviceOf(contract)
  };
}

/**
 * Every frozen fact of the build on disk. Given a version's recorded facts, each derivation runs on the inputs
 * recorded for it, so the two can be compared fact by fact.
 */
export async function factsOfTheBuild(recorded?: VersionFacts): Promise<VersionFacts> {
  const { opensToItsWords, ...inTheWallet } = registryFactsInTheWallet(recorded?.registry.inTheWallet);
  if (!opensToItsWords) throw new Error('the wallet does not open its own sealed registry entry back to its words');
  return {
    account: await contractFactsOf('account', recorded?.account),
    vault: await contractFactsOf('vault', recorded?.vault),
    registry: { ...(await contractFactsOf('registry', recorded?.registry)), inTheWallet },
    atAnAddress: await addressFactsOf(recorded?.atAnAddress)
  };
}
