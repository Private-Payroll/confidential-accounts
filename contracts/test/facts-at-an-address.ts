/**
 * The frozen facts that depend on a contract's own address, worked out by the build's own compiled code at fixed
 * addresses: the derivations inside the account's circuits that approvals, holds, run ids and batch payees are keyed
 * on, each place a circuit derives a key from the account's address, and the colour of each receipt a vault mints.
 * None of these is a pure circuit the contract exports, so each is reached by its compiled name.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';

import { CONTRACT_TABLE } from '../../scripts/contract-sources.mjs';
import { pureCircuits as Vault } from '../managed-vault/contract/index.js';
import type { AccountPrivateState } from '../src/witnesses.js';
import { callSitesOf } from './call-sites-in-the-compiled-code.js';
import type { AddressFacts, CallSiteFact, DerivationFact } from './frozen-facts.js';
import { compiledCall, DEVICE, initialStateOf, newAccount, newVault, NO_KEY, PURE } from './the-compiled-contracts.js';
import { fromJson, toJson, type JsonValue } from './values-in-json.js';

const ACCOUNT_AT = '11'.repeat(32);
const VAULT_AT = '22'.repeat(32);
const b = (byte: string): JsonValue => `0x${byte.repeat(32)}`;
const slot = (live: boolean): JsonValue => ({ live, details: b('c3'), nonce: b('d4'), amount: live ? '7n' : '0n' });

/** Each internal derivation, the compiled function that works it out, whether it reads the address, and its inputs. */
const INTERNAL: Readonly<Record<string, { readonly method: string; readonly atTheAccount: boolean; readonly inputs: readonly JsonValue[] }>> = {
  releaseNullifier: { method: '_releaseNullifier_0', atTheAccount: true, inputs: [b('a1'), b('b2'), '3n'] },
  approvalNullifier: { method: '_approvalNullifier_0', atTheAccount: true, inputs: [b('a1'), b('b2')] },
  governanceIdOf: { method: '_governanceIdOf_0', atTheAccount: false, inputs: [b('e5'), b('f6')] },
  runIdOf: { method: '_runIdOf_0', atTheAccount: false, inputs: [b('17'), '4n', '100n', '200n', '2n', b('28'), b('39')] },
  'batchPayeeLeaf, a vault\'s run': { method: '_batchPayeeLeaf_0', atTheAccount: false, inputs: [slot(true), false, b('4a')] },
  'batchPayeeLeaf, a company-wide run': { method: '_batchPayeeLeaf_0', atTheAccount: false, inputs: [slot(true), true, b('4a')] },
  'batchPayeeLeaf, an unused place': { method: '_batchPayeeLeaf_0', atTheAccount: false, inputs: [slot(false), true, b('4a')] },
};

/** A circuit context for the account at `ACCOUNT_AT`, as the account's circuits read their own address from. */
async function accountContext() {
  return createCircuitContext<AccountPrivateState>({
    circuitId: 'approve', contractAddress: ACCOUNT_AT, coinPublicKeyOrZswapState: NO_KEY,
    contractState: (await initialStateOf('account')).data, privateState: DEVICE,
  });
}

/** One internal derivation on its inputs, by the account's compiled code; refusals recorded as words. */
async function internalOf(name: string, inputs: readonly JsonValue[]): Promise<DerivationFact> {
  const { method, atTheAccount } = INTERNAL[name]!;
  const proof = { input: { value: [], alignment: [] }, output: undefined, publicTranscript: [], privateTranscriptOutputs: [] };
  const args = [...(atTheAccount ? [await accountContext(), proof] : []), ...inputs.map(fromJson)];
  try {
    return { inputs, output: toJson(await compiledCall(newAccount(), method, args)) };
  } catch (e) {
    return { inputs, refused: e instanceof Error ? e.message : String(e) };
  }
}

/** The bytes an argument at a call site stands for: the account's own address, or fixed bytes for its last name part. */
const argumentBytes = (arg: string): Uint8Array =>
  (arg === 'self' ? Uint8Array.from(Buffer.from(ACCOUNT_AT, 'hex')) : new Uint8Array(createHash('sha256').update(arg.split('.').pop()!).digest()));

/** Each call of a derivation keyed on the account's address, with the key its arguments give in that order. */
function callSitesFor(derivation: string): CallSiteFact[] {
  const js = readFileSync(join(import.meta.dirname, '..', '..', CONTRACT_TABLE.account.compiled, 'contract/index.js'), 'utf8');
  const fn: unknown = Reflect.get(PURE.account, derivation);
  if (typeof fn !== 'function') throw new Error(`the build has no pure circuit ${derivation}`);
  return callSitesOf(js, derivation).map((site) => {
    const key = toJson(Reflect.apply(fn, undefined, site.args.map(argumentBytes)));
    if (typeof key !== 'string') throw new Error(`${derivation} gives no key`);
    return { ...site, key };
  });
}

/** The colour of a receipt minted under `tag` by the vault at `vault`, as one build's compiled code works it out. */
export async function receiptColourIn(build: 'account' | 'vault', tag: Uint8Array, vault: string = VAULT_AT): Promise<string> {
  const contract = build === 'vault' ? newVault() : newAccount();
  const colour = toJson(await compiledCall(contract, '_tokenType_0', [tag, { bytes: fromJson(`0x${vault}`) }]));
  if (typeof colour !== 'string') throw new Error('a receipt\'s colour is 32 bytes');
  return colour;
}

/** Every fact that depends on a contract's own address; given the recorded ones, each runs on its recorded inputs. */
export async function addressFactsOf(recorded?: AddressFacts): Promise<AddressFacts> {
  const internal: Record<string, DerivationFact> = {};
  for (const name of Object.keys(INTERNAL)) internal[name] = await internalOf(name, recorded?.internal[name]?.inputs ?? INTERNAL[name]!.inputs);
  return {
    account: ACCOUNT_AT,
    vault: VAULT_AT,
    internal,
    callSites: { holderKeyOf: callSitesFor('holderKeyOf'), anchorTagOf: callSitesFor('anchorTagOf') },
    receiptColours: {
      payment: await receiptColourIn('vault', Vault.paymentReceiptTag()),
      change: await receiptColourIn('vault', Vault.changeReceiptTag()),
      retire: await receiptColourIn('vault', Vault.retireReceiptTag()),
    },
  };
}
