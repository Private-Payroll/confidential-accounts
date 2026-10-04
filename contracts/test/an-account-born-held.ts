/**
 * **A COMPANY'S ACCOUNT, CREATED AS ITS FOUNDING SIGNER'S BROWSER CREATES ONE**:
 * the device's own builder deploys it held by the founding signer's committee
 * key for the label, the wallet's own code reads that deploy and signs the
 * second step, and the device builds that step with the signature on it.
 * Nothing is sent: a test applies the two to its own chain, in order.
 *
 * One place every test that needs a company's account makes it, so no test
 * makes one another way.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { Identity } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { REQUEST_SCHEMA, parseAsk, type CreationRequest } from 'midnight-identity/profile/request';
import { creationSignatureFor, type CreationSignature, type ThisBuildsAccountKeys } from 'midnight-identity/profile/creation-sign';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import * as account from '../managed/contract/index.js';
import { witnesses } from '../src/witnesses.js';
import { buildAccountDeploy, finishedCreation } from '../../packages/web-shared/src/vault-builder.js';
import { labelInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { CREATION_STEPS } from '../../src/midnight/deferral.js';

const MANAGED = join(import.meta.dirname, '..', 'managed');
const ORIGIN = 'https://payroll.example';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const fromHex = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));

/** One of this build's account verifier key files. */
export const accountKeyFile = (c: string): Uint8Array => new Uint8Array(readFileSync(join(MANAGED, 'keys', `${c}.verifier`)));

/** SHA-256, as the wallet takes a key's digest. */
export const digest = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());

/** This build's account keys as the wallet holds them: the digests the compiler wrote beside the keys it made. */
export const thisBuilds: ThisBuildsAccountKeys = {
  first: new Map(CREATION_STEPS.first.map((c) => [c, fromHex((account as any).expectedVk[c])] as [string, Uint8Array])),
  second: new Map(CREATION_STEPS.second.map((c) => [c, fromHex((account as any).expectedVk[c])] as [string, Uint8Array])),
};

/** The device's builder's deps for an account, as the vault worker loads them. Nothing is proved: a deploy and an update call no circuit. */
export const accountBuilderDeps = (network: string) => {
  setNetworkId(network as never);
  return {
    ledger: L,
    runtimeState: (runtime as any).ContractState,
    contracts: contracts as any,
    network,
    accountCompiled: CompiledContract.make('ConfidentialAccount', (account as any).Contract).pipe(
      CompiledContract.withWitnesses(witnesses as never)),
    accountKeys: new NodeZkConfigProvider(MANAGED),
    prove: async (tx: any) => tx.prove({
      check: async () => { throw new Error('asked to check a circuit'); },
      prove: async () => { throw new Error('asked to prove a circuit'); },
      lookupKey: async () => undefined,
    } as never, L.CostModel.initialCostModel()),
  };
};

/** The page's ask of the founding signer's wallet for the second press. */
export const creationAskOf = (
  label: CompanyLabel, deploy: Uint8Array, address: string, now: number, over: Record<string, unknown> = {},
): CreationRequest => parseAsk({
  schema: REQUEST_SCHEMA, kind: 'creation',
  requester: { name: 'Payroll', rdns: 'example.payroll' }, purpose: 'To finish creating your company.',
  nonce: 'n-1', expiresAt: now + 600_000,
  company: label, account: address, deploy: b64(deploy),
  insert: CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(accountKeyFile(c)) })),
  ...over,
}, ORIGIN, now) as CreationRequest;

export interface AnAccountBornHeld {
  /** The deploy, held by the founding signer's committee key at 1, counter 0. */
  readonly deploy: Awaited<ReturnType<typeof buildAccountDeploy>>;
  /** What the founding signer's wallet handed back for the second press. */
  readonly answer: CreationSignature;
  /** The second step, signed by that key, inserting the rest of this build's circuits. */
  readonly insert: { proven: Uint8Array; bytesWritten: number };
  /** The founding signer's committee key for the company: what holds the account. */
  readonly foundingKey: { tag: string; value: string };
}

/** A company's account as its founding signer's two presses make it, not sent. */
export async function anAccountBornHeld(input: {
  readonly network: string; readonly founder: Identity; readonly label: CompanyLabel; readonly foundingLeaf: string;
  readonly now?: number;
}): Promise<AnAccountBornHeld> {
  const now = input.now ?? Date.now();
  const foundingKey = committeeKeyFor(input.founder, input.label);
  const deps = accountBuilderDeps(input.network);
  const deploy = await buildAccountDeploy(deps, { foundingLeaf: input.foundingLeaf, label: input.label, foundingKey });
  const answer = creationSignatureFor(L as never, input.founder, creationAskOf(input.label, deploy.proven, deploy.address, now), now,
    thisBuilds, digest, labelInAccountState);
  const keys = new Map(CREATION_STEPS.second.map((c) => [c, accountKeyFile(c)] as [string, Uint8Array]));
  const insert = await finishedCreation(deps, { account: deploy.address, keys, signature: answer.signature });
  return { deploy, answer, insert, foundingKey: { tag: foundingKey.tag, value: foundingKey.value } };
}
