import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aNetworkIsNamed, theNetwork } from '../../../../src/midnight/network.js';
import { networkIsReal, networkRecord } from '../../../../src/core/networks.js';
import { settingOrProjectToken } from '../../../../src/midnight/project-token-setting.js';
import {
  balancedAndGivenBack,
  depositShaped,
  partReading,
  verdicts,
  withoutTheToken,
  type BalancingSeen,
  type PartName,
  type PartProgress,
  type PartSeen,
  type Seen
} from './facade-on-a-network.js';

/*
 * **THE WALLET'S OWN FACADE READS A LIVE TEST NETWORK AND BALANCES A DEPOSIT ON IT.** The facade is built as the wallet
 * builds it (`facadeFor`, started with `seedsFor`) from a throwaway test identity kept in one gitignored file, and
 * each of its three parts is watched while it reads the chain. A transaction shaped as a private deposit is then
 * balanced twice, as the wallet pays a deposit today (the fee left to the fee payer) and with the wallet's own DUST
 * paying the fee, and every coin is given back each time. The verdicts say what the run showed.
 *
 * NOTHING IS PROVED, SIGNED OR SENT, AND NO NIGHT IS REGISTERED FOR DUST: the proving service the facade is given
 * refuses to prove, and no call here submits. A network where real money settles is refused.
 *
 * It stands down without a network: it waits for `MIDNIGHT_NETWORK_ID` naming a test network and for the test
 * identity's file, `.midnight/<network>/wallet-facade-test.seed`, holding 32 bytes of hex.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const READ_DEADLINE_MS = 30 * 60_000;
const ACCOUNT = 0;
const DEPOSIT_UNITS = 1n;
const PARTS: readonly PartName[] = ['shielded', 'unshielded', 'dust'];

const NAMED = aNetworkIsNamed();
const NETWORK_ID = NAMED ? theNetwork() : '';
const REAL = NAMED && networkIsReal(NETWORK_ID);
const ID_FILE = join(ROOT, '.midnight', NETWORK_ID, 'wallet-facade-test.seed');

/** What this run waits for, in words a reader can act on; null when it can run (a real network is not waited for, it is refused). */
const WAITS_FOR = !NAMED
  ? 'MIDNIGHT_NETWORK_ID naming a test network'
  : !REAL && !existsSync(ID_FILE)
    ? `a test identity at .midnight/${NETWORK_ID}/wallet-facade-test.seed`
    : null;
const READY = WAITS_FOR === null;
if (!READY)
  console.log(`  NOT CHECKED HERE: the wallet's facade was not read on a network, because it waits for ${WAITS_FOR}`);

interface Observed<T> {
  subscribe(observer: { next: (value: T) => void; error: (e: unknown) => void }): { unsubscribe(): void };
}
interface PartState {
  readonly progress?: PartProgress;
}
interface WholeState {
  readonly activeProtocolVersion: bigint;
  readonly dust?: { readonly balance?: (at: Date) => bigint };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a watched part has shown so far. */
function watched(): {
  seen: Record<PartName, PartSeen>;
  watch: (part: PartName, states: Observed<PartState>, since: number) => { unsubscribe(): void };
} {
  const seen: Record<PartName, PartSeen> = {
    shielded: { reading: 'no answer', readInMs: null, failed: null },
    unshielded: { reading: 'no answer', readInMs: null, failed: null },
    dust: { reading: 'no answer', readInMs: null, failed: null }
  };
  const watch = (part: PartName, states: Observed<PartState>, since: number) =>
    states.subscribe({
      next: (state) => {
        const reading = partReading(state.progress);
        if (seen[part].readInMs === null)
          seen[part] = { ...seen[part], reading, readInMs: reading === 'read' ? Date.now() - since : null };
      },
      error: (e) => {
        seen[part] = { ...seen[part], failed: said(e) };
      }
    });
  return { seen, watch };
}

/** The deposit, balanced as asked and the coins given back; what the wallet said either way. */
async function balancedOnce(
  facade: Awaited<ReturnType<typeof import('./facade.js').facadeFor>>,
  ledger: Parameters<typeof depositShaped>[0],
  token: string,
  kinds: ReadonlyArray<'shielded' | 'dust'>
): Promise<BalancingSeen> {
  const { BalancingRecipe } = await import('@midnightntwrk/wallet-sdk-facade');
  const { carriedBy } = await import('./carried.js');
  const shape = depositShaped(ledger, NETWORK_ID, token, DEPOSIT_UNITS) as { serialize(): Uint8Array };
  return balancedAndGivenBack(
    facade as never,
    shape,
    kinds,
    (recipe) => BalancingRecipe.getTransactions(recipe as never).map(carriedBy),
    said
  );
}

describe.skipIf(!READY)(
  "THE WALLET'S OWN FACADE READS A LIVE TEST NETWORK AND BALANCES A DEPOSIT ON IT [needs MIDNIGHT_NETWORK_ID naming a test network and a test identity at .midnight/<network>/wallet-facade-test.seed]",
  () => {
    // RED WHEN: a run that is asked to use a network where real money settles goes on.
    it(
      'every part reads the chain, the wallet learns the ledger, and a deposit balances both ways and is given back',
      async () => {
        if (REAL)
          throw new Error(
            `${NETWORK_ID} is a network where real money settles; this check runs a throwaway test identity on a test network only.`
          );
        const record = networkRecord(NETWORK_ID);
        const token = record.testToken ?? '';
        expect(token, `${record.label} has no test token in its record, so no deposit can be shaped`).not.toBe('');
        const setting = record.endpoints?.projectToken?.setting;
        let secret = '';
        if (setting !== undefined) {
          const value = settingOrProjectToken(process.env, join(ROOT, '.env'))(setting);
          if (typeof value === 'string' && value !== '') {
            process.env[setting] = value;
            secret = value;
          }
        }
        const hex = readFileSync(ID_FILE, 'utf8').trim();
        expect(hex, 'the test identity file is 32 bytes of hex').toMatch(/^[0-9a-f]{64}$/u);

        const { identityFromSecret } = await import('midnight-identity');
        const { NETWORK } = await import('../config.js');
        expect(NETWORK, 'the wallet is built for the network this run names').toBe(NETWORK_ID);
        const { facadeFor, seedsFor, failingProving } = await import('./facade.js');
        const { DefaultForkSchedule } = await import('@midnightntwrk/wallet-sdk');
        const ledger = await import('@midnightntwrk/ledger-v9');
        const identity = identityFromSecret(Uint8Array.from(Buffer.from(hex, 'hex')));

        const facade = await facadeFor(identity, ACCOUNT, failingProving);
        const since = Date.now();
        const { seen, watch } = watched();
        const subs = PARTS.map((part) => watch(part, facade[part].state as Observed<PartState>, since));
        let onLedger9 = false;
        let latest: WholeState | null = null;
        subs.push(
          (facade.state() as Observed<WholeState>).subscribe({
            next: (s) => {
              latest = s;
              if (s.activeProtocolVersion >= DefaultForkSchedule.v9) onLedger9 = true;
            },
            error: () => {
              /* the combined state failing leaves the ledger unlearned, which the verdict reports */
            }
          })
        );
        try {
          await facade.start(seedsFor(identity, ACCOUNT));
          while (
            Date.now() - since < READ_DEADLINE_MS &&
            !PARTS.every((p) => seen[p].readInMs !== null || seen[p].failed !== null)
          )
            await sleep(1_000);
          const holdsDust = BigInt((latest as WholeState | null)?.dust?.balance?.(new Date()) ?? 0n) > 0n;
          const today = await balancedOnce(facade, ledger as never, token, ['shielded']);
          const ownDust = await balancedOnce(facade, ledger as never, token, ['shielded', 'dust']);
          const lines: Seen = {
            first: seen,
            onLedger9,
            restartedInMs: null,
            asTheWalletPaysToday: today,
            withItsOwnDust: ownDust
          };
          /* A wallet holding no DUST cannot pay its own fee: that one balancing is excused, found by what it says. */
          const failing = verdicts(lines).filter(
            (line) => line.startsWith('SEEN FAILING') && (holdsDust || !line.includes('own DUST'))
          );
          // RED WHEN: a part that never finished, a ledger never learned or a refused balancing is let through as working.
          expect(failing.map((line) => withoutTheToken(line, secret))).toEqual([]);
        } finally {
          for (const s of subs) s.unsubscribe();
          await facade.stop();
        }
      },
      READ_DEADLINE_MS + 15 * 60_000
    );
  }
);
