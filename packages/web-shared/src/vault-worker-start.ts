/**
 * **A VAULT'S START AND ITS SECRET, ANSWERED IN THE PROVING WORKER.** Where the start stands, read off both contracts
 * at one block, and the calls that set the secret and write its sealed copies, each handed back to the page that asked
 * as base64. The seat's signing secret and the vault's secret come from the page on this device and are kept here by
 * nothing.
 */
import { fromBase64, toBase64 } from './base64-bytes.js';
import type { VaultBuilderDeps } from './vault-builder.js';
import { buildSetNonceSecret, buildWriteSecretCopy, type SecretRunOnTheWire } from './vault-secret-built.js';
import {
  secretRunOf, startStandingOf, type AccountLedgerForAStart, type AccountStartPure, type RoundMadeOf, type RoundStanding, type SecretRun,
  type StartStanding, type VaultLedgerForAStart, type VaultStartPure,
} from '../../../src/midnight/vault-start.js';
import { approvalMarkerOf } from './governed-call-builder.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-entry.js';

/**
 * **HOW FAR A VAULT'S START HAS GOT**, as the worker read it off the account's
 * and the vault's ledgers at one block: adopted or not, where the adoption round
 * stands, and, once the company's record of the secret has been read, where the
 * first secret run, the secret and each sealed copy stand.
 */
export interface StartStandingOnTheWire {
  readonly adopted: boolean; readonly removals: number;
  readonly adoption: RoundStanding & RoundMadeOf;
  readonly secret?: {
    readonly set: boolean;
    readonly another: boolean; readonly held: string; readonly landed: readonly string[]; readonly earlier?: { readonly secret: string } | { readonly unheld: true } | null;
    readonly rootIsThisRuns: boolean;
    readonly run: (RoundStanding & RoundMadeOf & { readonly opensAt: string; readonly closesAt: string; readonly inWindow: boolean; readonly beforeARemoval: boolean }) | null;
    readonly raise?: RoundMadeOf & { readonly proposal: string; readonly opensAt: string; readonly closesAt: string };
    readonly written: readonly boolean[];
    readonly started: boolean;
  };
}

type Asked<K extends VaultAsk['ask']> = Extract<VaultAsk, { ask: K }>;
type Answered<K extends VaultAsk['ask']> = Extract<VaultAnswer, { ask: K }>;

/** The first secret run, as it crosses to the page. */
const secretRunToWire = (r: SecretRun): SecretRunOnTheWire => ({
  vault: r.vault, previous: r.previous, commitment: r.commitment, copiesRoot: r.copiesRoot, count: r.count.toString(),
  edge: r.edge.map((s) => ({ sibling: s.sibling.toString(), goesLeft: s.goesLeft })),
  details: r.details, nonce: r.nonce, salt: r.salt, asset: r.asset, root: r.root, payees: r.payees.toString(),
  path: r.path.map((s) => ({ sibling: s.sibling.toString(), siblingSum: s.siblingSum.toString(), goesLeft: s.goesLeft })),
  copies: r.copies.map((c) => ({
    reader: c.reader, parts: [...c.parts], path: c.path.map((s) => ({ sibling: s.sibling.toString(), goesLeft: s.goesLeft })),
  })),
});

/** Where a vault's start stands, as it crosses to the page. */
const standingToWire = (s: StartStanding): StartStandingOnTheWire => {
  if (s.secret === undefined) return { adopted: s.adopted, adoption: s.adoption, removals: s.removals };
  const { run, raise, written, ...rest } = s.secret;
  return {
    adopted: s.adopted,
    adoption: s.adoption, removals: s.removals,
    secret: {
      ...rest,
      run: run === null ? null : { ...run, opensAt: run.opensAt.toString(), closesAt: run.closesAt.toString() },
      ...(raise === undefined ? {} : { raise: { ...raise, opensAt: raise.opensAt.toString(), closesAt: raise.closesAt.toString() } }),
      written: [...written],
    },
  };
};

/**
 * **HOW FAR A VAULT'S START HAS GOT, READ HERE FROM BOTH CONTRACTS AS ONE
 * BLOCK SAW THEM.** With the secret the page opened from the company's
 * record, the first secret run is made here too, with the contracts' own
 * functions, and handed back for the steps the page then asks for.
 */
export function startStandingAnswered(d: WorkerDeps, ask: Asked<'start-standing'>): Answered<'start-standing'> {
  const circuits = { vault: d.vault.pureCircuits as VaultStartPure, account: d.accountPure as unknown as AccountStartPure };
  const run = ask.secret === undefined
    ? undefined
    : secretRunOf(circuits, { vault: ask.vault, secret: ask.secret, readers: ask.readers ?? [], ...(ask.previous === undefined ? {} : { previous: ask.previous }) });
  const ledgerOf = (b64: string, read: (data: unknown) => unknown) =>
    read((d.runtimeState.deserialize(fromBase64(b64)) as { data: unknown }).data);
  const account = ledgerOf(ask.accountState, d.accountLedger) as AccountLedgerForAStart & { readonly approvals: { member(m: Uint8Array): boolean } };
  /* This seat's approval marker, made with the account's own derivation; the signing secret stays in this worker. */
  const markerOf = ask.seat === undefined ? undefined : approvalMarkerOf(d, { account: ask.account, signingSecret: ask.seat });
  const standing = startStandingOf(circuits, {
    vault: ask.vault,
    account,
    vaultLedger: ledgerOf(ask.vaultState, d.vault.ledger) as VaultLedgerForAStart,
    ...(run === undefined ? {} : { run, ...(ask.earlier === undefined ? {} : { earlier: ask.earlier }) }),
    now: BigInt(ask.now),
    ...(ask.window === undefined ? {} : { window: { opensAt: BigInt(ask.window.opensAt), closesAt: BigInt(ask.window.closesAt) } }),
    ...(markerOf === undefined ? {} : { approvedHere: (id: Uint8Array) => account.approvals.member(markerOf(id)) }),
    ...(ask.again === undefined ? {} : { again: ask.again }),
  });
  return {
    id: ask.id, ok: true, ask: 'start-standing', standing: standingToWire(standing),
    ...(run === undefined ? {} : { run: secretRunToWire(run) }),
  };
}

/** The vault's secret set under its approved run, built against one block's view of both contracts. */
export async function setNonceSecretAnswered(withNetwork: VaultBuilderDeps, ask: Asked<'set-nonce-secret'>): Promise<Answered<'set-nonce-secret'>> {
  const built = await buildSetNonceSecret(withNetwork, {
    vault: ask.vault, account: ask.account, run: ask.run, secret: ask.secret, earlier: ask.earlier, proposal: ask.proposal, opensAt: ask.opensAt, closesAt: ask.closesAt,
    chain: {
      blockHash: ask.chain.blockHash,
      vaultState: fromBase64(ask.chain.vaultState),
      zswapState: fromBase64(ask.chain.zswapState),
      parameters: fromBase64(ask.chain.parameters),
      accountState: fromBase64(ask.chain.accountState),
    },
  });
  return { id: ask.id, ok: true, ask: 'set-nonce-secret', tx: toBase64(built.proven) };
}

/** One sealed copy of the run's secret written into the vault. */
export async function writeSecretCopyAnswered(withNetwork: VaultBuilderDeps, ask: Asked<'write-secret-copy'>): Promise<Answered<'write-secret-copy'>> {
  const built = await buildWriteSecretCopy(withNetwork, {
    vault: ask.vault, run: ask.run, place: ask.place, state: fromBase64(ask.state),
    parameters: typeof ask.parameters === 'string' ? fromBase64(ask.parameters) : new Uint8Array(0),
  });
  return { id: ask.id, ok: true, ask: 'write-secret-copy', tx: toBase64(built.proven) };
}
