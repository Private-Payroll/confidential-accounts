/**
 * **THE VAULT'S NOTES AND ITS SECRET, WORKED OUT IN THE VAULT WORKER** from the state the page hands in and the
 * chain's history: this reader's sealed copy of the vault's secret, when the secret was set, whether a secret is the
 * vault's, what a journalled step kept, a coin's two commitments, and the vault's notes rebuilt from the records.
 */
import { fromBase64 } from './base64-bytes.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { AccountHolds } from './secret-set-on-the-chain.js';
import { historyHere } from './account-history-here.js';
import type { VaultBuilderDeps } from './vault-builder.js';
import type { VaultAnswer, VaultAsk, VaultRebuildAsked, VaultRebuilt } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

type RebuildAsk = Extract<VaultAsk, { ask: 'vault-rebuilt' }> & VaultRebuildAsked;
type CopiesHere = typeof import('../../../src/midnight/sealed-secret-copy.js');
type CopyKeysHere = import('../../../src/midnight/sealed-secret-copy.js').CopyKeys &
  import('../../../src/midnight/sealed-secret-copy.js').EarlierKeys;
const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/** The vault's ledger, read out of the contract state the page handed in. */
const ledgerHere = (d: WorkerDeps, state: string) =>
  d.vault.ledger((d.runtimeState.deserialize(fromBase64(state)) as { data: unknown }).data) as Parameters<
    CopiesHere['readersCopyOnTheChain']
  >[0];

/**
 * **THIS READER'S SEALED COPY OF THE VAULT'S SECRET, READ OFF THE STATE HANDED IN** under the commitment the ask names.
 * Only the page holds the key that opens it; nothing here can.
 */
async function ownChainCopyHere(d: WorkerDeps, ask: Extract<VaultAsk, { ask: 'own-chain-copy' }>) {
  const [copies, runtime] = await Promise.all([
    import('../../../src/midnight/sealed-secret-copy.js'),
    import('@midnight-ntwrk/compact-runtime')
  ]);
  const found = copies.readersCopyOnTheChain(
    ledgerHere(d, ask.state),
    d.vault.pureCircuits as CopyKeysHere,
    (c) => BigInt(runtime.degradeToTransient(c)),
    {
      reader: String(ask.reader).toLowerCase() as Hex,
      of: ask.of === 'copies-written' ? 'copies-written' : 'commitment'
    }
  );
  return { commitment: found.commitment, parts: found.parts === null ? null : found.parts.map(bytesToHex) };
}
/**
 * **THE ACCOUNT'S REMOVAL COUNT BEFORE THE VAULT'S SECRET `commitment` WAS SET**, from the history of the vault and
 * its account at the indexer the person's own wallet names (`removalsWhenTheSecretWasSet`), never from the company's
 * records or its service.
 */
async function secretSetAtHere(d: WorkerDeps, ask: Extract<VaultAsk, { ask: 'secret-set-at' }>): Promise<number> {
  const { removalsWhenTheSecretWasSet } = await import('./secret-set-on-the-chain.js');
  const data = (state: Uint8Array) => (d.runtimeState.deserialize(state) as { data: unknown }).data;
  const [vault, account] = await Promise.all(
    [ask.vault, ask.account].map((a) => historyHere(d, { ...ask, account: a }, "when the vault's secret was set was"))
  );
  return removalsWhenTheSecretWasSet(
    {
      vault: (state) => d.vault.ledger(data(state)),
      account: (state) => d.accountLedger(data(state)) as AccountHolds,
      ...(d.accountPure as { removalCountKey?: () => Uint8Array })
    },
    { vault: vault!.steps, account: account!.steps },
    ask.commitment
  );
}

/** Whether the secret asked about is the one the vault's state commits to. */
async function secretIsTheVaultsHere(
  d: WorkerDeps,
  ask: Extract<VaultAsk, { ask: 'secret-is-the-vaults' }>
): Promise<Extract<VaultAnswer, { ask: 'secret-is-the-vaults' }>> {
  /* The vault's own commitment function over the secret, against the commitment the vault's state holds. */
  const hex = /^[0-9a-f]{64}$/iu;
  if (!hex.test(ask.vault) || !hex.test(ask.secret))
    throw new Error('that is not a vault and a secret, so nothing was compared.');
  const bytes = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
  const held = (
    d.vault.ledger((d.runtimeState.deserialize(fromBase64(ask.state)) as { data: unknown }).data) as {
      nonceCommitment: Uint8Array;
    }
  ).nonceCommitment;
  const worked = (
    d.vault.pureCircuits as { secretCommitmentOf(v: Uint8Array, s: Uint8Array): Uint8Array }
  ).secretCommitmentOf(bytes(ask.vault), bytes(ask.secret));
  const matches = held.length === worked.length && held.every((b, i) => b === worked[i]) && held.some((b) => b !== 0);
  return { id: ask.id, ok: true, ask: 'secret-is-the-vaults', matches };
}
const HEX64_ASKED = /^[0-9a-f]{64}$/u;

/**
 * **HOW A REBUILD NAMES THE VAULT'S COINS: ITS SECRETS AND SPLIT JOURNAL, AND THIS SIGNER'S SEALED COPY.** With the
 * vault's state handed in, the secrets given are joined by every earlier secret the vault links to the one it holds
 * now, this signer's sealed copy is read when `copyFor` asks for it, and the secret the page opened it to
 * (`copySecret`) is named with first only when it is the one the vault holds now (`secretsForARebuild`). No secret, no naming:
 * a split journal left unnamed is said.
 */
async function namingForTheRebuild(d: WorkerDeps, ask: RebuildAsk, vault: Hex, said: string[]) {
  const read = String(ask.chain.nonceCommitment ?? '');
  const commitment = read.toLowerCase() as Hex;
  const splitJournal = new Map<Hex, Hex>(
    (ask.chain.splitJournal ?? []).map(([k, v]) => [String(k).toLowerCase() as Hex, String(v).toLowerCase() as Hex])
  );
  let secrets: readonly Hex[] = ask.secrets
    .map((x) => String(x).toLowerCase() as Hex)
    .filter((x) => HEX64_ASKED.test(x));
  let copy: string[] | null = null;
  if (ask.state !== undefined && HEX64_ASKED.test(read)) {
    const [copies, runtime] = await Promise.all([
      import('../../../src/midnight/sealed-secret-copy.js'),
      import('@midnight-ntwrk/compact-runtime')
    ]);
    const state = ask.state;
    const found = copies.secretsForARebuild(
      () => ledgerHere(d, state),
      d.vault.pureCircuits as CopyKeysHere,
      (c) => BigInt(runtime.degradeToTransient(c)),
      {
        vault,
        commitment,
        secrets,
        ...(ask.copyFor === undefined ? {} : { copyFor: String(ask.copyFor).toLowerCase() as Hex }),
        ...(HEX64_ASKED.test(String(ask.copySecret ?? '').toLowerCase())
          ? { copySecret: String(ask.copySecret).toLowerCase() as Hex }
          : {})
      }
    );
    said.push(...found.said);
    ({ secrets } = found);
    copy = found.copy === null ? null : found.copy.map(bytesToHex);
  }
  const naming =
    secrets.length > 0 && HEX64_ASKED.test(read)
      ? { nonceSecrets: { secrets: [...secrets], commitment }, splitJournal }
      : null;
  if (naming === null && splitJournal.size > 0)
    said.push(
      `the vault's split journal holds ${splitJournal.size} split(s), and no secret was read to name their pieces`
    );
  return { copy, naming };
}

/**
 * **THE VAULT'S NOTES, REBUILT IN THIS WORKER**, the one place the compact runtime and the vault's compiled circuits
 * are loaded. The records' coins are believed only where the chain holds their commitment (`reconcileVaultPool`), and
 * the walk's only where the chain made them (`walkCompanyRecords`). A secret that is not the vault's current one, a
 * note described two ways, or nothing to reconcile at all is said, never taken as a vault holding nothing. The coins
 * are named with the secrets given and every earlier one the vault links to its current secret; when `copyFor` is
 * given, this signer's sealed copy of the vault's secret is read off the vault's state and handed back sealed: only
 * the page holds the key that opens it (`namingForTheRebuild`).
 */
async function vaultRebuiltHere(d: WorkerDeps, ask: RebuildAsk): Promise<VaultRebuilt> {
  const vault = String(ask.vault).toLowerCase() as Hex;
  if (!HEX64_ASKED.test(vault)) throw new Error('that is not a vault, so nothing was rebuilt.');
  if (ask.chain.nonceCommitment === undefined || ask.chain.splitJournal === undefined) {
    throw new Error(
      "the vault was read without its secret's commitment or its split journal, so nothing was rebuilt: a journal not read " +
        'is not an empty one.'
    );
  }
  const [{ walkCompanyRecords, compiledOutputCommitment }, recovery, { depositNonceKeyFor }] = await Promise.all([
    import('../../../src/midnight/rebuild-from-records.js'),
    import('../../../src/midnight/vault-recovery.js'),
    import('../../../src/midnight/deposit-nonce.js')
  ]);
  const said: string[] = [];
  const hexToBytes = (h: string) => Uint8Array.from(h.match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
  const coinOf = (c: { nonce: string; token: string; value: string }) =>
    ({ nonce: String(c.nonce).toLowerCase(), token: c.token, value: BigInt(c.value) }) as {
      nonce: Hex;
      token: Hex;
      value: bigint;
    };
  const circuits = d.vault.pureCircuits;

  const { copy, naming } = await namingForTheRebuild(d, ask, vault, said);
  const chainNotes = ask.chain.notes.map((n) => String(n).toLowerCase() as Hex);

  const output = await compiledOutputCommitment();
  const rebuild = async (withNaming: typeof naming) => {
    let named = (ask.named ?? []).map(coinOf);
    if (ask.walk !== undefined) {
      const walked = await walkCompanyRecords({
        vault,
        keys:
          withNaming === null
            ? []
            : withNaming.nonceSecrets.secrets.map((x) => depositNonceKeyFor(hexToBytes(x), vault)),
        records: {
          deposited: (
            ask.walk.deposited.map((x) => ({ token: x.token, value: BigInt(x.value) })) as Array<{
              token: Hex;
              value: bigint;
            }>
          ).filter((x) => x.value > 0n),
          paid:
            withNaming === null
              ? []
              : (
                  ask.walk.paid.map((x) => ({ token: x.token, amount: BigInt(x.amount) })) as Array<{
                    token: Hex;
                    amount: bigint;
                  }>
                ).filter((x) => x.amount > 0n)
        },
        everCreated: new Set(ask.chain.everCreated.map((c) => String(c).toLowerCase().replace(/^0x/u, ''))),
        commitmentOf: output,
        ...(withNaming === null
          ? {}
          : { nonceSecrets: withNaming.nonceSecrets, splitJournal: withNaming.splitJournal }),
        circuits
      });
      named = [...named, ...walked.coins];
    }
    return recovery.reconcileVaultPool({
      vault,
      chain: chainNotes,
      versions: ask.versions.map((v) => ({ version: v.version, notes: v.notes.map(coinOf) })),
      attempted: {
        deposits: ask.attempted.deposits.map(coinOf),
        payments: ask.attempted.payments.map((p) => ({
          spent: coinOf(p.spent),
          amount: BigInt(p.amount),
          ...(p.further === undefined || p.further.length === 0 ? {} : { further: p.further.map(coinOf) }),
          ...(p.merge === true ? { merge: true } : {})
        }))
      },
      named,
      circuits,
      ...(withNaming === null ? {} : { nonceSecrets: withNaming.nonceSecrets, splitJournal: withNaming.splitJournal })
    });
  };
  const nothingHeld = { held: [], unexplained: chainNotes, copy, said };
  let result: Awaited<ReturnType<typeof rebuild>>;
  try {
    result = await rebuild(naming);
  } catch (e) {
    const name = (e as Error)?.name;
    if (naming !== null && (name === 'NonceSecretNotTheVaults' || name === 'NonceSecretNeeded')) {
      said.push(`${(e as Error).message} The notes the records name are still read without it.`);
      try {
        result = await rebuild(null);
      } catch (again) {
        said.push((again as Error)?.message ?? String(again));
        return nothingHeld;
      }
    } else {
      said.push((e as Error)?.message ?? String(e));
      return nothingHeld;
    }
  }
  if ((result.unnamedWithoutTheSecret?.length ?? 0) > 0) {
    said.push(
      `${result.unnamedWithoutTheSecret!.length} step(s) the journals name kept coins that are named only with the vault's secret, which was not read`
    );
  }
  return {
    held: result.held.map((n) => ({
      nonce: n.nonce,
      token: n.token,
      value: n.value.toString(),
      held: n.commitment,
      output: output(n, vault)
    })),
    unexplained: result.unexplained,
    copy,
    said
  };
}

/** The asks about the vault's notes and its secret; any other ask is answered elsewhere, so this gives undefined. */
export const vaultNotesAnswered = async (
  d: WorkerDeps,
  _withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'own-chain-copy':
      return { id: ask.id, ok: true, ask: 'own-chain-copy', copy: await ownChainCopyHere(d, ask) };
    case 'secret-set-at':
      return { id: ask.id, ok: true, ask: 'secret-set-at', removals: await secretSetAtHere(d, ask) };
    case 'secret-is-the-vaults':
      return secretIsTheVaultsHere(d, ask);
    case 'step-kept': {
      /* The coin a journalled step kept, worked out with the vault's own functions: a merge's, or a payment's change. */
      const [{ keptByAStep }, { nonceCircuitsFrom }] = await Promise.all([
        import('../../../src/midnight/vault-recovery.js'),
        import('../../../src/midnight/vault-coin-nonces.js')
      ]);
      const coinOf = (n: { nonce: string; token: string; value: string }) => {
        const c = n as unknown as { readonly nonce: Hex; readonly token: Hex; readonly value: string };
        return { nonce: c.nonce, token: c.token, value: BigInt(c.value) };
      };
      const kept = keptByAStep(
        {
          spent: coinOf(ask.step.spent),
          further: (ask.step.further ?? []).map(coinOf),
          amount: BigInt(ask.step.amount),
          ...(ask.step.merge === true ? { merge: true } : {})
        },
        {
          circuits: nonceCircuitsFrom(d.vault.pureCircuits as never),
          vault: ask.vault as Hex,
          secret: ask.secret as Hex
        }
      );
      return {
        id: ask.id,
        ok: true,
        ask: 'step-kept',
        kept: kept === undefined ? null : { nonce: kept.nonce, token: kept.token, value: kept.value.toString() }
      };
    }
    case 'commitments': {
      /* The two commitments a coin has: as an output the ledger records, and as the note the vault holds. */
      const [{ compiledOutputCommitment }, { commitmentForNote }] = await Promise.all([
        import('../../../src/midnight/rebuild-from-records.js'),
        import('../../../src/midnight/vault-recovery.js')
      ]);
      const handed = ask.coin as unknown as Record<'nonce' | 'token', never> & { readonly value: string };
      const coin = { nonce: handed.nonce, token: handed.token, value: BigInt(handed.value) };
      const output = (await compiledOutputCommitment())(coin, ask.vault as never);
      const held = commitmentForNote(d.vault.pureCircuits, ask.vault as never, coin);
      return { id: ask.id, ok: true, ask: 'commitments', output, held };
    }
    case 'vault-rebuilt': {
      /*
       * Every note the vault holds that the records handed in, the chain and the company's own amounts name: reconcile
       * over what was read, with the walk's coins named when the walk is asked. Only the chain decides what is held.
       */
      return { id: ask.id, ok: true, ask: 'vault-rebuilt', ...(await vaultRebuiltHere(d, ask)) };
    }
    default:
      return undefined;
  }
};
