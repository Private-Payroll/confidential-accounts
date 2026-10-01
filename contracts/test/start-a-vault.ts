/**
 * A VAULT TAKES NO MONEY UNTIL ITS ACCOUNT HAS ADOPTED IT AND APPROVED ITS FIRST
 * NONCE SECRET. This starts a test's vault the way the product does: adopted,
 * then one secret run approved by the account, the secret set over a tree of one
 * sealed copy, and that copy written. Every test that puts money in a vault starts it here first.
 */
import { pureCircuits as V } from '../managed-vault/contract/index.js';
import { pureCircuits as P } from '../managed/contract/index.js';
import { AccountSimulator, change, payoutTreeOf, sumArgsOf, type privateStateFor } from './simulator.js';
import { fromHex, toHex } from '../../src/core/crypto.js';
import { copiesTreeOf } from '../../src/midnight/sealed-copies-tree.js';

/** The secret a started test vault holds, unless a test names another. */
export const TEST_VAULT_SECRET = new Uint8Array(32).fill(0x51);

const ZERO = new Uint8Array(32);

/** Carries forward what a vault's call wrote to the account, when it reached the account at all. */
export const carryTheAccount = (sim: AccountSimulator, context: unknown): void => {
  if ((context as { queryContexts?: Record<string, unknown> })?.queryContexts?.[String(sim.address)] === undefined) return;
  sim.adoptFromCall(context);
};

export async function startTheVault(args: {
  sim: AccountSimulator;
  vault: Uint8Array;
  /** Calls one of the vault's circuits with the account reachable, carrying both states forward. */
  call: (circuit: string, ...a: unknown[]) => Promise<unknown>;
  approvers: ReturnType<typeof privateStateFor>[];
  /** The vault's time: the run's window opens an hour before it and closes an hour after. */
  now: number;
  secret?: Uint8Array;
  seed?: number;
}): Promise<{ commitment: Uint8Array }> {
  const { sim, vault, call, approvers, now } = args;
  const secret = args.secret ?? TEST_VAULT_SECRET;
  const seed = args.seed ?? 297;
  if (!sim.ledger.vaults.member(vault)) await sim.adoptVault(vault, approvers, seed + 1);
  const commitment = V.secretCommitmentOf(vault, secret);
  const copy = { reader: new Uint8Array(32).fill(0x31), parts: [1, 2, 3, 4].map((p) => new Uint8Array(32).fill(p)) };
  const copies = copiesTreeOf(V as never, commitment, [copy]);
  const leaves = [{ details: toHex(V.secretRunDetails(vault, ZERO, commitment, copies.root, copies.count)), nonce: toHex(new Uint8Array(32).fill(seed % 256)) }];
  const tree = payoutTreeOf(leaves, [0n]);
  const opensAt = BigInt(now - 3_600);
  const closesAt = BigInt(now + 3_600);
  const c = change(0n, seed);
  await sim.as(sim.applying(approvers[0]!, c)).proposeRun({
    root: fromHex(tree.root), payees: tree.payees, from: opensAt, until: closesAt, vault,
  });
  const id = sim.proposalId(P.runPayload(fromHex(tree.root), tree.payees, opensAt, closesAt, 0n), c.salt, vault);
  for (const a of approvers) await sim.as(sim.applying(a, c)).approve(id);
  const run = {
    proposal: id, runVault: vault, root: fromHex(tree.root), payees: tree.payees, opensAt, closesAt,
    required: 0n, salt: c.salt, nonce: fromHex(leaves[0]!.nonce), ...sumArgsOf(tree, 0),
  };
  delete (run as { amount?: unknown }).amount;
  await call('setNonceSecret', run, ZERO, commitment, copies.root, copies.count);
  await call('writeSecretCopy', commitment, copy.reader, copy.parts, copies.paths[0]);
  return { commitment };
}
