/**
 * **A PRIVATE DEPOSIT FROM THE PAGE IS BUILT ON THE DEVICE, AND NOTHING IT SENDS
 * CARRIES THE NONCE, THE SECRET IT COMES FROM, OR THE UNPROVEN TRANSACTION.**
 *
 * The page's own deposit (`depositFromSource`, with the page's source, ending
 * in `depositIntoCompanyVault`) runs with the worker's
 * own handler (`answerVaultAsk`) behind the page's own client, the vault's real
 * compiled contract and verifier keys, and the ledger's own transaction
 * builder. Everything that leaves the page is caught: every call to the
 * product's service, every record filed or read through the records route,
 * and what the person's wallet is asked to pay for. Each is searched for the
 * deposit's nonce in hex and in bytes, for the key and the secret it is
 * derived from, for the signer's own keys, and for the unproven transaction.
 *
 * The prover is stood in, because a real proof needs the circuit's proving
 * keys and minutes per proof: it hands back bytes that stand for the proven
 * transaction, and the test checks those are what the service receives. The
 * deposit is built with ledger parameters that are not the ledger's starting
 * ones, and the builder is checked to have been given exactly those.
 *
 * What the proof leaves public is read off the same transaction with its
 * proofs erased, and the nonce is not in it. **That is the deposit before the
 * wallet balances it**, and its shielded offer states the token and the amount
 * as a public per-token delta. The person's wallet is stood in by the wallet
 * SDK's own shielded balancing, from the factory, coin choice and key
 * capability the product wallet's shielded wallet is built with, over coins
 * this test gives it: it balances that public part, and the finished
 * transaction the service is sent is read for what the chain sees of the
 * deposit's token and amount.
 *
 * **WHAT THIS DOES NOT SHOW**: a real proof, the wallet's screen, a browser, a
 * chain, the wallet's own path to that balancing (its facade, the token kinds
 * it asks to balance, its signing and finishing), the proofs the wallet adds to
 * what it balanced, the binding the wallet and the service apply, or the fee
 * the service adds afterwards. What the
 * chain sees is read here off proof-erased, unbound bytes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as vaultModule from '../../contracts/managed-vault/contract/index.js';
import { buildVaultDeploy, type VaultBuilderDeps } from './vault-builder.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { vaultBuilderOver, type VaultAnswer } from './vault-worker-client.js';
import { openCompanyVaultPool, type VaultChainView, type VaultService, type DepositInFlight, type DepositsInFlight, } from './vault-operation.js';
import { MemorySealedPoolStore } from '../midnight/vault-pool.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { openNonceSecrets, recordsKeypairFrom, currentDepositNonceKey } from '../midnight/company-nonce-secret.js';
import { newWrappingKeypair, toHex, type Hex } from '../core/crypto.js';
import { StaticAssetRegistry } from '../core/assets.js';
import { depositFromSource, privateTokenFromTheWallet } from './deposit-source.js';
import * as ShieldedV1 from '@midnightntwrk/wallet-sdk-shielded/v1';
import { chooseCoin } from '@midnightntwrk/wallet-sdk-capabilities';
import { Either } from 'effect';

/** Deposits in flight, kept for the length of one test. */
const inFlightInMemory = (): DepositsInFlight => {
  const kept = new Map<string, DepositInFlight>();
  return {
    get: async (v) => kept.get(v) ?? null,
    put: async (v, d) => { kept.set(v, d); },
    forget: async (v) => { kept.delete(v); },
  };
};

const NET = 'undeployed';
const ACCOUNT = 'c0'.repeat(32);
/* A token and an amount no other bytes in a transaction are likely to repeat, so finding either means it is there. */
const TOKEN = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff)).toString('hex');
const OTHER_TOKEN = '5c'.repeat(32);
const VALUE = 0x3a7f19c2d4e5n;

/*
 * **THE DEPOSIT BELOW IS BUILT FROM THE VAULT'S VERIFIER KEYS, WHICH ONLY A FULL
 * VAULT COMPILE PRODUCES.** The general checks compile without them, so this is
 * skipped there by name, and the job that builds the keys runs this file by name.
 * Derived from this file's own location, not the working directory.
 */
const KEYS_ON_DISK = existsSync(new URL('../../contracts/managed-vault/keys/deposit.verifier', import.meta.url));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the vault\'s verifier keys are not on disk, so a deposit was not built on the'
    + ' device and searched for what it sends. `npm run compact:vault -- --full` builds them.',
  );
}

/** Every string and byte array inside a value, however deep, whatever holds it. */
const leaves = (x: unknown, out: Array<string | Uint8Array> = []): Array<string | Uint8Array> => {
  if (typeof x === 'string') out.push(x);
  else if (x instanceof Uint8Array) out.push(x);
  else if (x instanceof ArrayBuffer) out.push(new Uint8Array(x));
  else if (ArrayBuffer.isView(x)) out.push(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
  else if (typeof x === 'bigint' || typeof x === 'number') out.push(String(x));
  else if (x instanceof Map) [...x.entries()].forEach((e) => leaves(e, out));
  else if (x instanceof Set) [...x.values()].forEach((y) => leaves(y, out));
  else if (Array.isArray(x)) x.forEach((y) => leaves(y, out));
  else if (x !== null && typeof x === 'object') Object.values(x).forEach((y) => leaves(y, out));
  return out;
};
/*
 * A 32-byte secret is searched for as every 16-byte run of it, forwards and
 * reversed, not only whole: the ledger writes a nonce into a transaction as a
 * field element, whose last byte is not beside the other thirty-one, so a
 * whole-value search would miss the nonce in the very transaction that
 * carries it (the control below). It is also searched for as a decimal number,
 * either way round.
 */
const WINDOW = 16;
const runsOf = (secret: Uint8Array): Buffer[] => {
  if (secret.length > 32) return [Buffer.from(secret)];
  const forwards = Array.from({ length: secret.length - WINDOW + 1 }, (_, i) => Buffer.from(secret.subarray(i, i + WINDOW)));
  return [...forwards, ...forwards.map((r) => Buffer.from(r).reverse())];
};
const decimalsOf = (secret: Uint8Array): string[] => (secret.length > 32 ? [] : [
  BigInt(`0x${Buffer.from(secret).toString('hex')}`).toString(),
  BigInt(`0x${Buffer.from(secret).reverse().toString('hex')}`).toString(),
]);
/** Every stretch of a string that could be base64 or base64url, decoded from each of its four alignments. */
const decodedRuns = (l: string): Buffer[] => (l.match(/[A-Za-z0-9+/_-]{22,}/gu) ?? []).flatMap((run) => {
  const std = run.replace(/-/gu, '+').replace(/_/gu, '/');
  return [0, 1, 2, 3].map((skip) => Buffer.from(std.slice(skip), 'base64'));
});
/** Whether any leaf carries these bytes: raw, as hex in any case, as a number, or inside base64 of anything. */
const carries = (caught: unknown[], secret: Uint8Array): boolean => {
  const runs = runsOf(secret);
  const hexRuns = runs.map((r) => r.toString('hex'));
  const decimals = decimalsOf(secret);
  const within = (b: Uint8Array) => runs.some((r) => Buffer.from(b).indexOf(r) >= 0);
  return caught.some((c) => leaves(c).some((l) => {
    if (l instanceof Uint8Array) return within(l);
    const lower = l.toLowerCase();
    if (hexRuns.some((h) => lower.includes(h)) || decimals.some((d) => l.includes(d))) return true;
    return decodedRuns(l).some(within);
  }));
};

/*
 * **EVERY PART OF THE UNPROVEN TRANSACTION THE PROOF DOES NOT LEAVE PUBLIC.**
 * Each 16-byte run of it that is not anywhere in its proof-erased form, nor in
 * what the service served the device to build it with (the vault's address, as
 * bytes and as text, its state and the ledger parameters), and is not a run of
 * a few repeated bytes that any bytes could hold. Searching for
 * these finds a piece of the unproven transaction however it was cut, not only
 * the whole of it or the runs of one secret.
 */
const privateRunsOf = (unprovenTx: Uint8Array, publicParts: readonly Uint8Array[]): Set<string> => {
  const inPublic = new Set<string>();
  for (const publicPart of publicParts) {
    for (let i = 0; i + WINDOW <= publicPart.length; i += 1) inPublic.add(Buffer.from(publicPart.subarray(i, i + WINDOW)).toString('hex'));
  }
  const out = new Set<string>();
  for (let i = 0; i + WINDOW <= unprovenTx.length; i += 1) {
    const run = unprovenTx.subarray(i, i + WINDOW);
    if (new Set(run).size < 8) continue;
    const hex = Buffer.from(run).toString('hex');
    if (!inPublic.has(hex)) out.add(hex);
  }
  return out;
};
/** Whether any leaf holds one of these runs: raw, as hex at either nibble, or inside base64 of anything. */
const carriesAnyRun = (caught: unknown[], runs: ReadonlySet<string>): boolean => {
  const within = (b: Uint8Array) => {
    for (let i = 0; i + WINDOW <= b.length; i += 1) if (runs.has(Buffer.from(b.subarray(i, i + WINDOW)).toString('hex'))) return true;
    return false;
  };
  const hexRuns = (l: string): Buffer[] => (l.match(/[0-9a-fA-F]{32,}/gu) ?? []).flatMap((h) => [h, h.slice(1)]
    .map((x) => Buffer.from(x.slice(0, x.length - (x.length % 2)), 'hex')));
  return caught.some((c) => leaves(c).some((l) => (l instanceof Uint8Array
    ? within(l)
    : within(Buffer.from(l, 'latin1')) || hexRuns(l).some(within) || decodedRuns(l).some(within))));
};
/*
 * An amount as the ledger may write it: its significant bytes and nothing
 * around them, either way round, as itself and as its 128-bit negative, and
 * as a decimal number. The amount chosen below has six significant bytes, so
 * a match is the amount and not a coincidence.
 */
const significantBytesOf = (v: bigint): Buffer => Buffer.from(v.toString(16).padStart(v.toString(16).length + (v.toString(16).length % 2), '0'), 'hex');
const amountRunsOf = (value: bigint): Buffer[] => [value, (1n << 128n) - value].flatMap((v) => {
  const low = significantBytesOf(v & ((1n << 48n) - 1n));
  return [low, Buffer.from(low).reverse()];
});
const holdsAmount = (bytes: Uint8Array, value: bigint): boolean =>
  amountRunsOf(value).some((r) => Buffer.from(bytes).indexOf(r) >= 0)
  || Buffer.from(bytes).toString('latin1').includes(value.toString());

/**
 * **THE PERSON'S WALLET, AS FAR AS ITS PRIVATE BALANCING GOES.** The wallet SDK's
 * shielded balancing, from the same factory, coin choice and key capability the
 * product wallet's shielded wallet is built with, over coins of the deposit's
 * token and one of another. It answers the deposit it was asked to pay for,
 * merged with what it added, as the wallet finishes a page's transaction.
 */
const aWalletHolding = (network: string) => {
  const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(32).map((_, i) => 91 + i));
  let wallet: unknown = (ShieldedV1 as any).CoreWallet.initEmpty(keys, network);
  for (const [token, value] of [[TOKEN, (VALUE * 6n) / 10n], [TOKEN, (VALUE * 7n) / 10n], [OTHER_TOKEN, VALUE * 3n]] as const) {
    const coin = L.createShieldedCoinInfo(token, value);
    const output = L.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
    wallet = (ShieldedV1 as any).CoreWallet.apply(wallet, keys, L.ZswapOffer.fromOutput(output, token, value));
  }
  const context = {
    coinSelection: chooseCoin,
    coinsAndBalancesCapability: (ShieldedV1 as any).CoinsAndBalances.makeDefaultCoinsAndBalancesCapability(),
    keysCapability: (ShieldedV1 as any).Keys.makeDefaultKeysCapability(),
  };
  const balancing = (ShieldedV1 as any).Transacting.makeDefaultTransactingCapability({ networkId: network }, () => context);
  return {
    /** The deposit as the chain would receive it once this wallet has paid for it. */
    payFor: (publicPart: any): any => {
      const answered = balancing.balanceTransaction(keys, wallet, publicPart);
      if (Either.isLeft(answered)) throw answered.left;
      const [added] = answered.right;
      if (added === undefined) throw new Error('the wallet found nothing to pay for');
      return publicPart.merge(added.eraseProofs());
    },
  };
};

describe.skipIf(!KEYS_ON_DISK)('A DEPOSIT FROM THE PAGE, BUILT ON THE DEVICE [needs contracts/managed-vault/keys; `npm run compact:vault -- --full` builds them]', () => {
  const zk = new NodeZkConfigProvider(new URL('../../contracts/managed-vault', import.meta.url).pathname);
  const compiled = CompiledContract.make('Vault', (vaultModule as any).Contract).pipe(
    CompiledContract.withWitnesses({ noteToSpend: () => { throw new Error('a deposit spends no note'); } } as never));
  const PROVEN = new Uint8Array(96).map((_, i) => (i * 37 + 11) & 0xff);
  /* Parameters the chain could hold that are not the ledger's starting ones: one field of them changed. */
  const STARTING = L.LedgerParameters.initialParameters().serialize();
  const CHAIN_PARAMETERS = STARTING.slice();
  CHAIN_PARAMETERS[CHAIN_PARAMETERS.length - 1] ^= 0x01;
  let unproven: Uint8Array[];
  let erased: Uint8Array[];
  let builtWith: Uint8Array[];
  const deps = (): VaultBuilderDeps & { vault: unknown } => ({
    ledger: L, vault: vaultModule, runtimeState: (runtime as any).ContractState, compiled, zkConfig: zk, network: NET,
    contracts: {
      ...(contracts as any),
      createUnprovenCallTxFromInitialStates: (zkc: unknown, options: any, ...rest: unknown[]) => {
        builtWith.push(options.ledgerParameters.serialize());
        return (contracts as any).createUnprovenCallTxFromInitialStates(zkc, options, ...rest);
      },
    },
    prove: async (tx: any) => {
      unproven.push(tx.serialize());
      erased.push(tx.eraseProofs().serialize());
      return { serialize: () => PROVEN };
    },
  });
  let vault: Hex;
  let state: string;

  beforeAll(async () => {
    setNetworkId(NET as never);
    unproven = []; erased = []; builtWith = [];
    const built = await buildVaultDeploy({ ...deps(), prove: async (tx: any) => tx }, { account: ACCOUNT });
    vault = built.vault as Hex;
    const deploy = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', built.proven) as any;
    state = Buffer.from(deploy.intents.values().next().value.actions[0].initialState.serialize()).toString('base64');
  });

  it('SENDS THE SERVICE ONLY THE DEPOSIT THE WALLET FINISHED, WHICH SHOWS NO TOKEN OR AMOUNT, AND NOTHING SENT ANYWHERE CARRIES THE NONCE, ITS SECRET OR ANY PART OF THE UNPROVEN TRANSACTION', async () => {
    unproven = []; erased = []; builtWith = [];
    const wallet = aWalletHolding(NET);
    const finished: Uint8Array[] = [];
    const caught: Array<{ to: string; what: unknown }> = [];
    const catching = (to: string, what: unknown) => { caught.push({ to, what }); };

    /* The worker's own handler behind the page's own client, on this device. */
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const builder = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(async () => deps() as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, NET);
    let chosen: { nonce: string; token: string; value: string } | null = null;
    const watched = { ...builder, deposit: async (i: Parameters<typeof builder.deposit>[0]) => { chosen = i.coin; return builder.deposit(i); } };

    /* The records route: every record filed or asked for, as the device hands it over. */
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    const records = (r: WireRecord) => {
      const s = kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
      return new Proxy(s, {
        get: (target, p) => {
          const v = (target as any)[p];
          return typeof v === 'function' ? (...args: unknown[]) => { catching(`records ${r} ${String(p)}`, args); return v.apply(target, args); } : v;
        },
      });
    };

    /* The product's service, which answers what the chain holds. */
    const notes: string[] = [];
    const view = (): VaultChainView => ({
      vault, onChain: true, committee: null, heldByCommittee: true, fundable: true, state, notes: [...notes], everCreated: [],
    });
    const PARAMETERS = Buffer.from(CHAIN_PARAMETERS).toString('base64');
    const service: VaultService = {
      keys: async () => { catching('service keys', []); return { committee: null, why: null, readers: [] }; },
      deploy: async () => { throw new Error('no deploy'); },
      handover: async () => { throw new Error('no handover'); },
      chain: async (v) => { catching('service chain', [v]); return view(); },
      payoutState: async (v) => {
        catching('service payout-state', [v]);
        return { vault, account: ACCOUNT as Hex, blockHash: 'b1'.repeat(32), vaultState: state, zswapState: '', parameters: PARAMETERS, accountState: '' };
      },
      deposit: async (v, tx) => {
        catching('service deposit', [v, tx]);
        /* The chain shows the note: its held commitment, worked out by the test from what the device chose. */
        notes.push((await builder.commitments({ vault, coin: chosen! })).held);
        return { txRef: 'r1', transactionHash: null };
      },
      events: async () => { throw new Error('no events'); },
      payout: async () => { throw new Error('no payout'); },
      payoutPublicly: async () => { throw new Error('no payout'); },
    };
    const wrapping = newWrappingKeypair();
    const companyKey = new Uint8Array(32).map((_, i) => 200 - i);
    const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey };
    const doors = {
      sleep: async () => {}, waitMs: 3, everyMs: 1, service, me, records,
      myRecordsKey: recordsKeypairFrom(companyKey).publicKey,
      signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    };
    await openCompanyVaultPool(doors, vault);
    /* The page's own source, a private token paid in by the person's wallet, over an asset whose private token is this test's. */
    const source = privateTokenFromTheWallet(async (ask) => {
        catching('wallet', ask);
        /*
         * The wallet is asked with the proven bytes, and pays for the transaction they stand for: the one the prover
         * was given, whose public part is what a proof leaves for the chain.
         */
        const paid = wallet.payFor(L.Transaction.deserialize('signature', 'no-proof', 'no-binding', erased[erased.length - 1]!));
        finished.push(paid.serialize());
        return { transaction: Buffer.from(finished[0]!).toString('base64'), leaves: [] };
    }, new StaticAssetRegistry([{
      code: 'DEP', name: 'DEP', kind: 'token', decimals: 0, chain: 'midnight', enabled: true, sortOrder: 1,
      ledger: { shielded: TOKEN, unshielded: null } as never,
    }]));
    const done = await depositFromSource({
      ...doors, company: ACCOUNT as Hex, builder: watched, inFlight: inFlightInMemory(),
    }, vault, source, { code: 'DEP', value: VALUE });

    /* ---- the deposit happened, and what the service was sent is what the wallet finished ---- */
    expect(done.note.value).toBe(VALUE);
    expect(unproven, 'the deposit was built once, on this device').toHaveLength(1);
    const asked = caught.filter((c) => c.to === 'wallet').map((c) => (c.what as { transaction: string }).transaction);
    /* RED WHEN: the builder hands back the unproven transaction, or the wallet is asked with anything but the proven one. */
    expect(asked).toEqual([Buffer.from(PROVEN).toString('base64')]);
    const sent = caught.filter((c) => c.to === 'service deposit').map((c) => (c.what as unknown[])[1]);
    /* RED WHEN: the page sends the service anything but what the wallet answered. */
    expect(sent).toEqual([Buffer.from(finished[0]!).toString('base64')]);
    /* RED WHEN: the deposit is built with the ledger's starting parameters, or with anything but what the chain served. */
    expect(Buffer.from(CHAIN_PARAMETERS).equals(Buffer.from(STARTING)), 'the parameters served are the starting ones').toBe(false);
    expect(builtWith.map((b) => Buffer.from(b).toString('hex')), 'the deposit was not built with the chain\'s parameters')
      .toEqual([Buffer.from(CHAIN_PARAMETERS).toString('hex')]);
    /* Every door a deposit uses was watched, so a search over them searched something. */
    expect([...new Set(caught.map((c) => c.to.split(' ').slice(0, 2).join(' ')))].sort(), 'RED WHEN: a door stops being watched').toEqual([
      'records deposit-journal', 'records nonce-secret', 'records pool', 'service chain', 'service deposit', 'service keys',
      'service payout-state', 'wallet',
    ]);

    /* ---- what the chain is sent states neither the deposit's token nor its amount ---- */
    const onChain = L.Transaction.deserialize('signature', 'no-proof', 'no-binding', finished[0]!) as any;
    const before = L.Transaction.deserialize('signature', 'no-proof', 'no-binding', erased[0]!) as any;
    const deltasOf = (t: any) => [t.guaranteedOffer, ...(t.fallibleOffer?.values() ?? [])]
      .filter((o: any) => o !== undefined).flatMap((o: any) => [...o.deltas.entries()]);
    const shieldedImbalancesOf = (t: any) => [0, ...(t.intents?.keys() ?? []), ...(t.fallibleOffer?.keys() ?? [])]
      .flatMap((segment: number) => [...t.imbalances(segment).entries()].filter(([k]: any) => k.tag === 'shielded'));
    /* The control: before the wallet pays, the chain would see the token and the amount, and the searches below see them too. */
    expect(deltasOf(before), 'the deposit before the wallet pays states its token and amount').toEqual([[TOKEN, -VALUE]]);
    expect(carries([erased[0]!], Buffer.from(TOKEN, 'hex')), 'the search cannot see the token where the chain would').toBe(true);
    expect(holdsAmount(erased[0]!, VALUE), 'the search cannot see the amount where the chain would').toBe(true);
    /* RED WHEN: the wallet pays in another section than the deposit's, or short, or not at all - a delta is left. */
    expect(deltasOf(onChain), 'the finished deposit states a token and amount in public').toEqual([]);
    expect(shieldedImbalancesOf(onChain), 'the finished deposit leaves a private token unbalanced').toEqual([]);
    /* RED WHEN: the token or the amount appears anywhere in what the chain is sent, however it is written. */
    expect(carries([finished[0]!], Buffer.from(TOKEN, 'hex')), 'the finished deposit names its token').toBe(false);
    expect(holdsAmount(finished[0]!, VALUE), 'the finished deposit names its amount').toBe(false);

    /* ---- and nothing any of them was sent carries a secret ---- */
    const inside = (x: string) => `{"note":"${x}"}`;
    const opened = openNonceSecrets((await kept.get('nonce-secret')!.get(vault))!, vault, recordsKeypairFrom(companyKey));
    const nonce = Buffer.from(done.note.nonce, 'hex');
    const secrets: Array<[string, Uint8Array]> = [
      ['the deposit\'s nonce', nonce],
      ['the key the nonce is derived from', currentDepositNonceKey(opened)],
      ...opened.secrets.map((s, i) => [`the vault's nonce secret, epoch ${i + 1}`, Buffer.from(s, 'hex')] as [string, Uint8Array]),
      ['the key the wallet released for the company', companyKey],
      ['the signer\'s records key', Buffer.from(recordsKeypairFrom(companyKey).secret, 'hex')],
      ['the signer\'s wrapping key', Buffer.from(wrapping.secret, 'hex')],
      ['the unproven transaction', unproven[0]!],
    ];
    const leaked = secrets.flatMap(([name, secret]) =>
      caught.filter((c) => carries([c.what], secret)).map((c) => `${name}, in: ${c.to}`));
    /* RED WHEN: any request, record or wallet ask carries one of them - in hex, in bytes, or inside base64. */
    expect(leaked, 'these left the device').toEqual([]);
    /*
     * RED WHEN: any request, record, wallet ask or wallet answer carries any part of the unproven transaction the
     * proof does not leave public - the part that carries the nonce, or any other - cut anywhere, not only whole.
     */
    const privateRuns = privateRunsOf(unproven[0]!, [
      erased[0]!, Buffer.from(vault, 'hex'), Buffer.from(vault, 'latin1'), Buffer.from(state, 'base64'), CHAIN_PARAMETERS,
    ]);
    expect(privateRuns.size, 'the unproven transaction has no part the proof hides, so this search searches nothing').toBeGreaterThan(64);
    expect(caught.filter((c) => carriesAnyRun([c.what], privateRuns)).map((c) => c.to), 'part of the unproven transaction left the device').toEqual([]);
    const at = Buffer.from(unproven[0]!).indexOf(Buffer.from(nonce.subarray(0, WINDOW)));
    expect(at, 'the unproven transaction does not carry the nonce where the search looks').toBeGreaterThanOrEqual(0);
    const aroundTheNonce = unproven[0]!.subarray(Math.max(0, at - 24), at + 24);
    const elsewhere = [...privateRuns][Math.floor(privateRuns.size / 2)]!;
    for (const [how, what] of [
      ['a piece around the nonce, raw', aroundTheNonce],
      ['a piece around the nonce, in base64 inside a longer string', inside(Buffer.from(aroundTheNonce).toString('base64'))],
      ['a piece around the nonce, in hex at an odd nibble', `f${Buffer.from(aroundTheNonce).toString('hex')}`],
      ['one hidden run from elsewhere in it, in base64url', Buffer.from(elsewhere, 'hex').toString('base64url')],
    ] as Array<[string, unknown]>) {
      expect(carriesAnyRun([what], privateRuns), `the search cannot see ${how}`).toBe(true);
    }
    expect(carriesAnyRun([erased[0]!, finished[0]!, PROVEN], privateRuns), 'the search finds hidden parts in public bytes').toBe(false);

    /* ---- the search finds a nonce where one is: the unproven transaction carries it ---- */
    expect(carries([unproven[0]!], nonce), 'the search cannot see the nonce, so the searches above prove nothing').toBe(true);
    expect(carries([Buffer.from(unproven[0]!).toString('base64')], nonce), 'the search cannot see inside base64').toBe(true);
    expect(carries([toHex(nonce).toUpperCase()], nonce), 'the search cannot see hex in capitals').toBe(true);
    const controls: Array<[string, unknown]> = [
      ['a decimal number', BigInt(`0x${toHex(nonce)}`)],
      ['a decimal number, the bytes reversed', BigInt(`0x${Buffer.from(nonce).reverse().toString('hex')}`).toString()],
      ['base64url', Buffer.from(nonce).toString('base64url')],
      ['base64 inside a longer string', inside(Buffer.from(nonce).toString('base64'))],
      ['base64 at an odd place in a longer string', `x${Buffer.concat([Buffer.from([1]), nonce]).toString('base64')}`],
      ['the bytes reversed', Buffer.from(nonce).reverse()],
      ['an ArrayBuffer', new Uint8Array(nonce).buffer],
      ['a Map', new Map([['k', toHex(nonce)]])],
      ['a Set', new Set([toHex(nonce)])],
    ];
    for (const [how, what] of controls) {
      expect(carries([what], nonce), `the search cannot see the nonce as ${how}`).toBe(true);
    }
    /* ---- and the transaction's public part, which is what a proof leaves for the chain, does not ---- */
    expect(carries([erased[0]!], nonce), 'the deposit\'s public part names its nonce').toBe(false);
    expect(carries([finished[0]!], nonce), 'the finished deposit names its nonce').toBe(false);
  }, 120_000);
});
