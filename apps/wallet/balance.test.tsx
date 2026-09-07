// @vitest-environment jsdom
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { IDBFactory } from 'fake-indexeddb';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import { NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import { MidnightBech32m } from '@midnightntwrk/wallet-sdk-address-format';
import {
  addressFor, identityFromSecret, identityFromWords, newSecret, secretFromWords,
} from 'midnight-identity';
import type { Identity, Secret } from 'midnight-identity';
import { INDEXER_HTTP_URL, INDEXER_WS_URL, NETWORK } from './config.js';
import {
  VIEWING_KEY_FIELD, mentionsViewingKey,
} from './scripts/viewing-key-tripwire.mjs';
import {
  GIVE_UP_AFTER_MS, QUIET_AFTER_MS, coinPublicKeyOf, walletFor, walletRestoredFrom, withOwnClock,
} from './balance.js';
import type { BalanceEngine, BalanceState } from './balance.js';
import { BalanceEnginesContext } from './balance-context.js';
import type { BalanceEngines } from './balance-context.js';
import { WALLET_ACCOUNTS } from './subwallets.js';
import { dustFromSpecks, exactSpecks, exactStars, nightFromStars } from './amount.js';
import {
  forgetWalletCheckpoints, loadWalletCheckpoint, saveWalletCheckpoint,
} from './storage.js';
import { ORIGINAL_SLOT, forgetOpenWallet, openWallet } from './wallets-held.js';
import { Home } from './screens/home.js';

/*
 * THE BALANCE, HELD TO ITS RULES.
 *
 * The one test that decides whether this milestone is safe is the ADDRESS
 * AGREEMENT test: the wallet that syncs and the address card that is shown
 * must be the same wallet, proved by asking the SDK wallet for ITS address
 * and comparing it byte for byte with `addressFor`'s. `startWithSeed` — the
 * wrong door, one line away — produces a wallet whose address is never
 * displayed, so every balance would read zero for ever while money sits
 * where the interface cannot see. That failure is demonstrated here, not
 * described.
 *
 * None of this touches the network: constructing the SDK wallet and asking
 * its address is local, and the UI tests drive a fake engine — the real one
 * runs only when a person presses "Check the balance".
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const bech32Of = async (wallet: ReturnType<typeof walletFor>): Promise<string> => {
  const address = await wallet.getAddress();
  return MidnightBech32m.encode(NETWORK, address).asString();
};

describe('the right door — §1.1, the address-agreement test', () => {
  const ours: Identity = identityFromWords(TEST_MNEMONIC);

  it('the synced wallet IS the displayed wallet, for the main wallet and the slots', async () => {
    for (const account of [0, 2, 11]) {
      const wallet = walletFor(ours, account);
      const fromWallet = await bech32Of(wallet);
      await wallet.stop().catch(() => {});
      expect(fromWallet).toBe(addressFor(ours.moneyAt(account).zswap, NETWORK).bech32);
    }
  }, 60_000);

  it('the wrong door is a DIFFERENT wallet — demonstrated, not described', async () => {
    /* `startWithSeed(secret)` skips HD derivation entirely: the secret goes
     * straight into `ZswapSecretKeys.fromSeed`, landing at no path at all.
     * Its address matches no wallet this interface has ever displayed. */
    const secret: Secret = secretFromWords(TEST_MNEMONIC);
    const wrong = ShieldedWallet({
      networkId: NETWORK,
      indexerClientConnection: {
        indexerHttpUrl: INDEXER_HTTP_URL, indexerWsUrl: INDEXER_WS_URL,
      },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    }).startWithSeed(secret);
    const fromWrongDoor = await bech32Of(wrong as ReturnType<typeof walletFor>);
    await (wrong as ReturnType<typeof walletFor>).stop().catch(() => {});
    for (const account of WALLET_ACCOUNTS) {
      expect(fromWrongDoor).not.toBe(addressFor(ours.moneyAt(account).zswap, NETWORK).bech32);
    }
  }, 60_000);

  it('refuses the reserved account and slots the picker does not offer', () => {
    expect(() => walletFor(ours, 1)).toThrow(/authority/);
    expect(() => walletFor(ours, 12)).toThrow(/not a wallet/);
  });
});

describe('the network is stagenet, and the endpoints live beside it — §3', () => {
  it('one named constant, and the indexer answers for exactly that network', () => {
    expect(NETWORK).toBe('stagenet');
    expect(new URL(INDEXER_HTTP_URL).protocol).toBe('https:');
    expect(new URL(INDEXER_HTTP_URL).host).toBe('indexer.stagenet.shielded.tools');
    expect(new URL(INDEXER_WS_URL).protocol).toBe('wss:');
    expect(new URL(INDEXER_WS_URL).host).toBe('indexer.stagenet.shielded.tools');
  });

  it('every address the wallet shows carries the network in the string', () => {
    const secret = newSecret();
    expect(addressFor(identityFromSecret(secret).money.zswap, NETWORK).bech32)
      .toMatch(/^mn_shield-addr_stagenet1/);
  });
});

describe('the viewing key never enters this repository’s CODE — §1.2', () => {
  /* The REAL check is the browser probe, which records every request an
   * actual browser sends and fails if the indexer's viewing-key field appears
   * in any of them. This is the tripwire for the other route in: somebody
   * adding code that would ask the indexer to filter for us — and let its
   * operator read every payment this wallet makes.
   *
   * The first version of this test kept an allowlist, and `balance.ts`
   * was on it because its own comment documents the rule — which put the
   * one file the offending call would be written in outside the tripwire.
   * Writing the rule down had punched the hole in it. So comments are
   * STRIPPED before scanning, documentation stays legal everywhere, and
   * THERE IS NO ALLOWLIST. Exactly one path is outside the scan and it is the
   * file that HOLDS the field name for both ends of the tripwire to import,
   * `scripts/viewing-key-tripwire.mjs`. That is a skip by PATH — one string
   * compared against one resolved path — and not a rule that could match a
   * second file somebody adds later under the same basename.
   *
   * WHY THIS FILE NO LONGER SPELLS THE FIELD EITHER. It used to be the one
   * file allowed to, on the ground that the tripwire's subject is its own. But
   * the network probe needs the same string, so there were two copies, and two
   * copies of a trigger is one copy that can be edited without the other
   * noticing. Both ends now read it from the skipped file, and the assertion
   * below is that NOTHING under the two source trees spells it out. A positive
   * control follows it, because an empty list is also what a scan that visited
   * nothing produces.
   *
   * AND THE SCAN COVERS `scripts/` NOW, WHICH IT DID NOT. It walked `src` and
   * `.ts`/`.tsx` alone, so every `.mjs` and `.d.mts` under `scripts/` —
   * including the programs that talk to the indexer from a Node process — sat
   * outside the one check that would have caught the forbidden call being
   * written there. */

  /* Comments out, code left alone. Line comments are recognised only when
   * not preceded by ':' or a quote, so `https://…` inside a string
   * survives. A tripwire needs to catch a string literal, not parse TS. */
  const stripComments = (source: string): string => source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');

  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  /* THE TREES THIS PRODUCT'S SOURCE LIVES IN, and nothing else in them is
   * source: the rest is configuration, documentation, vendored packages and
   * build output. Naming the trees is what lets the scan run with NO directory
   * exclusions — a skip list of directories is the same habit as a skip list of
   * files, one level up, and this scan is not going to grow one.
   *
   * ── THE MERGE MOVED THESE AND DID NOT CHANGE WHAT THEY COVER ────────────
   *
   * They were `src` and `scripts` of a folder that held this product alone.
   * That folder is now two: `packages/identity` is the library and
   * `apps/wallet` is the application, and the three names below are the same
   * FILES the two old names covered. **Nothing was dropped and nothing was
   * added** — that is the whole of the change here.
   *
   * **AND THE OBVIOUS-LOOKING WIDENING IS REFUSED, WITH THE NUMBER.** This
   * repository now holds payroll too, and pointing the walk at the repository
   * root — which is what the old `src`/`scripts` spelling silently BECAME when
   * the files moved — reports 33 payroll files that spell the field. They are
   * not this tripwire's subject: the rule is that THIS WALLET never asks its
   * indexer to filter for it, and payroll reading its own account is a
   * different product answering a different question. **Widening this scan to
   * cover payroll would be a NEW claim, and it would be red on arrival.** If
   * payroll's own handling of that field deserves a tripwire, it deserves its
   * own, written where somebody can say what it is claiming. */
  const SOURCE_TREES = ['packages/identity/src', 'packages/identity/scripts', 'apps/wallet'];

  /* Every extension source is written in here. `.d.mts` ends in `.mts` and NOT
   * in `.ts`, which is why the type declarations beside the `.mjs` programs
   * were outside the old filter as well. */
  const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|mjs)$/;

  /* The one path outside the scan, resolved once, compared as a whole. */
  const TRIPWIRE_TRIGGER = path.join(REPO, 'apps', 'wallet', 'scripts', 'viewing-key-tripwire.mjs');

  /** Every source file under the named trees, as paths relative to `root`. */
  const sourceFilesUnder = (root: string, trees: readonly string[]): string[] => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!SOURCE_EXTENSIONS.test(name)) continue;
        found.push(path.relative(root, full));
      }
    };
    for (const tree of trees) walk(path.join(root, tree));
    return found.sort();
  };

  const offendersUnder = (root: string, trees: readonly string[], skip: string): string[] =>
    sourceFilesUnder(root, trees).filter((rel) => path.join(root, rel) !== skip
      && mentionsViewingKey(stripComments(readFileSync(path.join(root, rel), 'utf8'))));

  it('stripped of comments, NO source file spells the field — the one that holds it is skipped by path', () => {
    expect(offendersUnder(REPO, SOURCE_TREES, TRIPWIRE_TRIGGER)).toEqual([]);
  });

  it('AND THE SCAN IS ALIVE: it reaches both trees and every extension source is written in', () => {
    /* An empty offender list is also what a scan that visited nothing returns,
     * and a walk pointed at a directory that does not exist returns exactly
     * that, silently. So the files the scan MUST have opened are named. */
    const seen = sourceFilesUnder(REPO, SOURCE_TREES);
    expect(seen).toContain(path.join('apps', 'wallet', 'balance.ts'));
    expect(seen).toContain(path.join('apps', 'wallet', 'balance.test.tsx'));
    expect(seen).toContain(path.join('apps', 'wallet', 'scripts', 'probe-verdict.mjs'));
    expect(seen).toContain(path.join('apps', 'wallet', 'scripts', 'probe-verdict.d.mts'));
    expect(seen).toContain(path.join('apps', 'wallet', 'scripts', 'viewing-key-tripwire.mjs'));
    /* And the library half, which the old two names also covered. */
    expect(seen).toContain(path.join('packages', 'identity', 'src', 'index.ts'));
    expect(seen).toContain(path.join('packages', 'identity', 'scripts', 'check-library-build.mjs'));
  });

  it('AND IT STILL CATCHES ONE: a decoy file naming the field is found, in either tree', () => {
    /* THE POSITIVE CONTROL, and it is built outside this repository so that
     * nothing here is mutated and no other test file can see a dirty tree.
     * Without it, every assertion above passes on a scan that has quietly
     * stopped reading anything. */
    /* THE DECOYS ARE PLACED THROUGH `SOURCE_TREES` AND NOT THROUGH TYPED-OUT
     * DIRECTORY NAMES. This control used to build `src/` and `scripts/` by
     * hand, and when the trees moved it kept building the old two: the scan
     * found nothing, the control reported nothing found, and it was the
     * ENOENT rather than the logic that said so. A positive control that
     * names its own tree independently of the scan is a control that can stop
     * covering the thing it controls. */
    const root = mkdtempSync(path.join(tmpdir(), 'tripwire-'));
    const [LIB_SRC, , APP] = SOURCE_TREES as [string, string, string];
    for (const tree of SOURCE_TREES) mkdirSync(path.join(root, tree), { recursive: true });
    mkdirSync(path.join(root, APP, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, APP, 'clean.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, APP, 'documented.ts'),
      `/* ${VIEWING_KEY_FIELD} is what this must never send */\nexport const b = 2;\n`);
    writeFileSync(path.join(root, APP, 'leaks.ts'),
      `export const q = { ${VIEWING_KEY_FIELD}: 'x' };\n`);
    writeFileSync(path.join(root, APP, 'scripts', 'leaks.mjs'),
      `export const q = { ${VIEWING_KEY_FIELD}: 'x' };\n`);
    writeFileSync(path.join(root, APP, 'scripts', 'leaks.d.mts'),
      `export declare const q: { ${VIEWING_KEY_FIELD}: string };\n`);
    /* And one in the library half, so a control that only ever reaches the
     * application would be red rather than quietly narrower. */
    writeFileSync(path.join(root, LIB_SRC, 'leaks.ts'),
      `export const q = { ${VIEWING_KEY_FIELD}: 'x' };\n`);

    expect(offendersUnder(root, SOURCE_TREES, path.join(root, 'nothing-is-skipped')))
      .toEqual([
        path.join(APP, 'leaks.ts'),
        path.join(APP, 'scripts', 'leaks.d.mts'),
        path.join(APP, 'scripts', 'leaks.mjs'),
        path.join(LIB_SRC, 'leaks.ts'),
      ]);
  });

  it('the skip is one exact path, so a second file of the same NAME is still caught', () => {
    /* The distinction the skip is written for. A skip by basename would let
     * the trigger file shelter a file of that name dropped anywhere else in
     * the tree; a skip by resolved path cannot. */
    const root = mkdtempSync(path.join(tmpdir(), 'tripwire-'));
    const APP = SOURCE_TREES[2] as string;
    mkdirSync(path.join(root, APP, 'scripts', 'nested'), { recursive: true });
    const real = path.join(root, APP, 'scripts', 'viewing-key-tripwire.mjs');
    const impostor = path.join(root, APP, 'scripts', 'nested', 'viewing-key-tripwire.mjs');
    writeFileSync(real, `export const F = '${VIEWING_KEY_FIELD}';\n`);
    writeFileSync(impostor, `export const F = '${VIEWING_KEY_FIELD}';\n`);

    expect(offendersUnder(root, SOURCE_TREES, real))
      .toEqual([path.join(APP, 'scripts', 'nested', 'viewing-key-tripwire.mjs')]);
  });

  it('THE FIELD IS THE INDEXER’S OWN — measured against its schema, not against itself', () => {
    /* THE ASSERTION THIS REPLACES WAS SELF-REFERENTIAL and a review measured
     * it: it checked that the trigger file contains the value the trigger file
     * exports, which is always true. Renaming the constant to anything at all
     * left it green — and then the source scan and the network probe would
     * both be searching for a string nothing will ever send, while a real call
     * passing the field went straight through.
     *
     * The field is the indexer client's own, so it is read off the client
     * rather than remembered: the mutation that hands a viewing key over is
     * declared there in the schema's own words. If this goes red the client
     * has renamed the field and the tripwire is pointed at nothing.
     *
     * IT FAILS RATHER THAN SKIPPING when the package is absent, deliberately:
     * a check that quietly passes when it could not look is worse than no
     * check, because the work looks done. */
    const connect = path.join(REPO, 'node_modules',
      '@midnightntwrk', 'wallet-sdk-indexer-client', 'dist', 'graphql', 'queries', 'Connect.js');
    expect(existsSync(connect), 'the indexer client is not installed, so whether the tripwire '
      + 'names the real field is unknown').toBe(true);
    const schema = readFileSync(connect, 'utf8');
    expect(schema).toContain(`${VIEWING_KEY_FIELD}: ViewingKey!`);
    expect(schema).toContain(`connect(${VIEWING_KEY_FIELD}:`);

    expect(typeof VIEWING_KEY_FIELD).toBe('string');
    expect(VIEWING_KEY_FIELD.length).toBeGreaterThan(6);
    /* And the file that holds it holds it ONCE as a value, so the two ends
     * cannot drift against each other either. */
    const trigger = readFileSync(TRIPWIRE_TRIGGER, 'utf8');
    expect(trigger).toContain(`'${VIEWING_KEY_FIELD}'`);
    expect(stripComments(trigger).split(VIEWING_KEY_FIELD).length - 1).toBe(1);
  });

  it('AND THE SKIPPED FILE CANNOT ITSELF BE WHERE THE CALL IS WRITTEN', () => {
    /* THE HOLE THE SKIP OPENS, CLOSED. One path is outside the scan, so it is
     * the one place the forbidden call could be written — and using the
     * exported constant rather than a second literal would slip past the
     * once-only assertion above. The answer is that the skipped file cannot
     * reach a network at all: it imports nothing, and it names nothing that
     * could build, send or address a request. It is a string and a predicate.
     * RED WHEN: that file gains an import, or anything that talks to a host. */
    const trigger = readFileSync(TRIPWIRE_TRIGGER, 'utf8');
    const code = stripComments(trigger);
    expect(code).not.toMatch(/\bimport\b/u);
    expect(code).not.toMatch(/\brequire\b/u);
    for (const reach of [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'http', 'https', 'URL', 'axios',
      'process', 'eval', 'Function(',
    ]) {
      expect(code.includes(reach), `the skipped file names \`${reach}\``).toBe(false);
    }
    /* And it exports exactly the two things both ends read from it. */
    expect([...code.matchAll(/export\s+(?:const|function)\s+(\w+)/gu)].map((m) => m[1]).sort())
      .toEqual(['VIEWING_KEY_FIELD', 'mentionsViewingKey']);
  });

  it('mentions are a string question: absent bodies are not hits', () => {
    /* The probe hands over request bodies that are frequently missing, and a
     * scanner that treated absence as a mention would fail every run for the
     * wrong reason. */
    expect(mentionsViewingKey(`{"${VIEWING_KEY_FIELD}":"x"}`)).toBe(true);
    expect(mentionsViewingKey('{"address":"x"}')).toBe(false);
    expect(mentionsViewingKey(undefined)).toBe(false);
    expect(mentionsViewingKey(null)).toBe(false);
    expect(mentionsViewingKey('')).toBe(false);
  });

  it('the stripper keeps code and drops commentary — proved on the shapes that matter', () => {
    expect(stripComments(`/* ${VIEWING_KEY_FIELD} documented */ const a = 1;`))
      .not.toContain(VIEWING_KEY_FIELD);
    expect(stripComments(`// ${VIEWING_KEY_FIELD} noted\nconst a = 1;`))
      .not.toContain(VIEWING_KEY_FIELD);
    expect(stripComments(`const leak = '${VIEWING_KEY_FIELD}';`)).toContain(VIEWING_KEY_FIELD);
    /* A URL is not a comment. */
    expect(stripComments(`const u = 'https://x/${VIEWING_KEY_FIELD}';`)).toContain(VIEWING_KEY_FIELD);
  });
});

/* ---------- the four sentences on screen — §4 ---------- */

interface FakeEngine {
  readonly engine: BalanceEngine;
  readonly calls: { account: number }[];
  readonly stops: number[];
  emit(state: BalanceState): void;
}

function fakeEngine(): FakeEngine {
  const calls: { account: number }[] = [];
  const stops: number[] = [];
  let onState: ((s: BalanceState) => void) | null = null;
  return {
    calls,
    stops,
    engine: (_identity, account, tell) => {
      calls.push({ account });
      onState = tell;
      const mine = calls.length;
      return () => stops.push(mine);
    },
    emit: (state) => { act(() => { onState?.(state); }); },
  };
}

/* An engine that never answers — the truthful stand-in for the side a test
 * is not exercising, since the real ones say nothing until asked either. */
const inert: BalanceEngine = () => () => {};

function renderHome(secret: Secret, engines: Partial<BalanceEngines>): ReturnType<typeof render> {
  return render(
    <BalanceEnginesContext.Provider
      value={{ shielded: inert, unshielded: inert, dust: inert, ...engines }}
    >
      <Home identity={identityFromSecret(secret)} secret={secret} />
    </BalanceEnginesContext.Provider>,
  );
}

/* ANY number on the card — for the "never show a number" assertions, which
 * must hold across both lines, not just the one under test. */
const bigBalance = (container: HTMLElement): string | null =>
  container.querySelector('.balance-big')?.textContent ?? null;

const bigBalanceOf = (container: HTMLElement, kind: 'shielded' | 'unshielded'): string | null =>
  container.querySelector(`[data-kind="${kind}"] .balance-big`)?.textContent ?? null;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  /* Which compartment a window has open is module state and outlives a
   * test. The mid-flight test below sets it deliberately; every other test
   * here must start from none. */
  forgetOpenWallet();
});

describe('zero and “I do not know” are different sentences — §4', () => {
  it('nothing is asked and nothing leaves until the button is pressed', () => {
    const shielded = fakeEngine();
    const unshielded = fakeEngine();
    const { container } = renderHome(newSecret(), {
      shielded: shielded.engine, unshielded: unshielded.engine,
    });
    expect(screen.getByText(/Not asked yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing is sent until you press/)).toBeTruthy();
    expect(shielded.calls).toHaveLength(0);
    expect(unshielded.calls).toHaveLength(0);
    expect(bigBalance(container)).toBeNull();
  });

  it('the press starts ALL THREE engines, on the OPEN wallet, not account 0 by habit', () => {
    const shielded = fakeEngine();
    const unshielded = fakeEngine();
    const dust = fakeEngine();
    renderHome(newSecret(), {
      shielded: shielded.engine, unshielded: unshielded.engine, dust: dust.engine,
    });
    /* Switch to Subwallet 1 (account 2), then check. */
    fireEvent.click(screen.getByText('Switch wallet'));
    fireEvent.click(document.querySelector('[data-wallet-row][data-account="2"]')!);
    fireEvent.click(screen.getByText('Check the balance'));
    /* One press, three engines, the SAME account — a sync of a
     * different slot would read a different wallet's money onto this card. */
    expect(shielded.calls).toEqual([{ account: 2 }]);
    expect(unshielded.calls).toEqual([{ account: 2 }]);
    expect(dust.calls).toEqual([{ account: 2 }]);
  });

  it('connecting and syncing never show a number', () => {
    const fake = fakeEngine();
    const { container } = renderHome(newSecret(), { shielded: fake.engine });
    fireEvent.click(screen.getByText('Check the balance'));

    fake.emit({ name: 'connecting' });
    expect(screen.getByText(/this is a wait, not a zero/)).toBeTruthy();
    expect(bigBalance(container)).toBeNull();

    fake.emit({ name: 'syncing', applied: 5n, highest: 9n });
    expect(screen.getByText(/No number until the wallet has seen them all/)).toBeTruthy();
    expect(bigBalance(container)).toBeNull();
  });

  it('a failure says it is NOT a zero, and offers the retry', () => {
    const fake = fakeEngine();
    const { container } = renderHome(newSecret(), { shielded: fake.engine });
    fireEvent.click(screen.getByText('Check the balance'));
    fake.emit({ name: 'failed', message: 'socket refused' });

    expect(screen.getByText(/socket refused/)).toBeTruthy();
    expect(screen.getByText(/not a zero/)).toBeTruthy();
    expect(bigBalance(container)).toBeNull();

    fireEvent.click(screen.getByText('Try again'));
    expect(fake.calls).toHaveLength(2);
    /* The retry stopped the first run before starting the second. */
    expect(fake.stops).toContain(1);
  });

  it('the number appears only when synced — in NIGHT, with the exact STARs beside it', () => {
    const fake = fakeEngine();
    const { container } = renderHome(newSecret(), { shielded: fake.engine });
    fireEvent.click(screen.getByText('Check the balance'));
    fake.emit({ name: 'synced', night: 1234567n, asOf: Date.now() });

    /* §7.17: divide by the atomic unit, say which token, keep the exact
     * figure available — never round. */
    expect(bigBalance(container)).toContain('1.234567');
    expect(bigBalance(container)).toContain('tNIGHT');
    expect(screen.getByText(/Exactly 1,234,567 STARs/)).toBeTruthy();
    expect(screen.getByText(/as of/)).toBeTruthy();
    expect(screen.getByText(/1 NIGHT = 1,000,000 STARs/)).toBeTruthy();
    /* §7.17 is MEASURED since 19 Aug (5000 tNIGHT → 5,000,000,000 STARs),
     * so the card states the measurement — and the old assumption sentence
     * must be GONE: a caveat that outlives its answer teaches people to
     * skim caveats. (This test asserted that sentence once; edited the
     * day the measurement landed, declared in the log.) */
    expect(screen.getByText(/measured on stagenet/)).toBeTruthy();
    expect(screen.queryByText(/assumption still riding/)).toBeNull();
    /* The owner rule, extended: the number sits under the wallet's own name.
     * `.card` -> `[data-hero]`: the hero is a kit `Card`, which
     * deliberately does not wear the `.card` class (`kit/card.tsx` — `app.css`
     * owns that name and eleven screens are built on it). Same claim, same
     * `.wallet-owner strong` inside it. */
    const card = container.querySelector('.balance-big')?.closest('[data-hero]');
    expect(card?.querySelector('.wallet-owner strong')?.textContent).toBe('Main wallet');
  });

  it('each side has its own line, and one side answering never invents the other', () => {
    const shielded = fakeEngine();
    const unshielded = fakeEngine();
    const { container } = renderHome(newSecret(), {
      shielded: shielded.engine, unshielded: unshielded.engine,
    });
    fireEvent.click(screen.getByText('Check the balance'));
    /* The faucet's 5000 tNIGHT arriving unshielded: 5,000,000,000 STARs. */
    unshielded.emit({ name: 'synced', night: 5_000_000_000n, asOf: Date.now() });
    expect(bigBalanceOf(container, 'unshielded')).toContain('5,000');
    expect(bigBalanceOf(container, 'unshielded')).toContain('tNIGHT');
    expect(screen.getByText(/Exactly 5,000,000,000 STARs/)).toBeTruthy();
    /* The shielded side has NOT answered — no number may appear there. */
    expect(bigBalanceOf(container, 'shielded')).toBeNull();
    shielded.emit({ name: 'synced', night: 1_000_000n, asOf: Date.now() });
    expect(bigBalanceOf(container, 'shielded')).toContain('1');
    /* And the lines say which is which, on the card itself. */
    expect(screen.getByText(/Unshielded NIGHT — ordinary transfers, the faucet/)).toBeTruthy();
    expect(screen.getByText(/Shielded — private payments/)).toBeTruthy();
  });

  it('the DUST line renders in its OWN unit, and its zero says what it is', () => {
    const dust = fakeEngine();
    const { container } = renderHome(newSecret(), { dust: dust.engine });
    fireEvent.click(screen.getByText('Check the balance'));

    /* Half a DUST: 5 × 10^14 SPECKs. A millionfold-style unit mistake —
     * rendering SPECKs through the NIGHT divider — would print a nonsense
     * number here instead of 0.5. */
    dust.emit({ name: 'synced', night: 500_000_000_000_000n, asOf: Date.now() });
    const line = container.querySelector('[data-kind="dust"] .balance-big');
    expect(line?.textContent).toContain('0.5');
    expect(line?.textContent).toContain('tDUST');
    expect(screen.getByText(/Exactly 500,000,000,000,000 SPECKs/)).toBeTruthy();

    /* And a zero is a REAL zero with its reason — DUST is generated by
     * registered NIGHT, and none is registered — never a bare 0 that reads
     * like missing money. */
    dust.emit({ name: 'synced', night: 0n, asOf: Date.now() });
    expect(container.querySelector('[data-kind="dust"] .balance-big')?.textContent)
      .toContain('0');
    expect(screen.getByText(/A real zero, not an unknown/)).toBeTruthy();
    expect(screen.getByText(/registered none yet/)).toBeTruthy();
    expect(screen.getByText(/Without DUST no fee can be paid/)).toBeTruthy();
  });

  it('switching wallets stops BOTH syncs and returns to the honest idle state', () => {
    const fake = fakeEngine();
    const unshielded = fakeEngine();
    const { container } = renderHome(newSecret(), {
      shielded: fake.engine, unshielded: unshielded.engine,
    });
    fireEvent.click(screen.getByText('Check the balance'));
    fake.emit({ name: 'synced', night: 42n, asOf: Date.now() });
    expect(bigBalance(container)).toContain('0.000042');

    fireEvent.click(screen.getByText('Switch wallet'));
    fireEvent.click(document.querySelector('[data-wallet-row][data-account="2"]')!);

    /* Both of the old wallet's engines are stopped, and no number survives
     * onto the new wallet's card. */
    expect(fake.stops).toContain(1);
    expect(unshielded.stops).toContain(1);
    expect(bigBalance(container)).toBeNull();
    expect(screen.getByText(/Not asked yet/)).toBeTruthy();
  });
});

describe('a NIGHT figure is exact or it is not shown', () => {
  it('divides by the atomic unit and never rounds', () => {
    expect(nightFromStars(0n)).toBe('0');
    expect(nightFromStars(1n)).toBe('0.000001');
    expect(nightFromStars(1_000_000n)).toBe('1');
    expect(nightFromStars(1_234_567n)).toBe('1.234567');
    expect(nightFromStars(2_500_000n)).toBe('2.5');
    expect(nightFromStars(1_234_567_890_123n)).toBe('1,234,567.890123');
  });

  it('keeps the exact smallest-unit figure available — the both-ends habit for amounts', () => {
    expect(exactStars(1_234_567n)).toBe('1,234,567 STARs');
    expect(exactStars(0n)).toBe('0 STARs');
  });

  it('divides DUST by ITS atomic unit — fifteen decimals, never six — measured', () => {
    /* The millionfold trap, squared: DUST has fifteen decimals, and running
     * SPECKs through the NIGHT divider would overstate a balance by 10^9. */
    expect(dustFromSpecks(0n)).toBe('0');
    expect(dustFromSpecks(1n)).toBe('0.000000000000001');
    expect(dustFromSpecks(1_000_000_000_000_000n)).toBe('1');
    expect(dustFromSpecks(500_000_000_000_000n)).toBe('0.5');
    expect(dustFromSpecks(1_234_500_000_000_000_000n)).toBe('1,234.5');
    expect(exactSpecks(1_234_567n)).toBe('1,234,567 SPECKs');
    expect(exactSpecks(0n)).toBe('0 SPECKs');
  });
});

describe('the wallet’s own clock — because the socket does not report its own death', () => {
  /* A probe measured the reason: 150 seconds of refused connections, no
   * error on the SDK's state stream. The clock is pure and is tested pure:
   * a silent inner engine, fake timers, and the two promised escalations. */
  const silentEngine = (): { engine: BalanceEngine; stops: number[]; tell: (s: BalanceState) => void } => {
    const stops: number[] = [];
    let onState: ((s: BalanceState) => void) | null = null;
    return {
      stops,
      tell: (s) => onState?.(s),
      engine: (_i, _a, tell) => { onState = tell; return () => stops.push(1); },
    };
  };
  const identity = identityFromSecret(newSecret());

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('says the silence out loud, then gives up into the failed state and stops the sync', () => {
    const inner = silentEngine();
    const seen: BalanceState[] = [];
    withOwnClock(inner.engine, 10_000, 45_000)(identity, 0, (s) => seen.push(s));

    vi.advanceTimersByTime(10_001);
    expect(seen.at(-1)).toEqual({ name: 'connecting', quietMs: 10_000 });

    vi.advanceTimersByTime(35_000);
    const last = seen.at(-1);
    expect(last?.name).toBe('failed');
    expect(last?.name === 'failed' && last.message).toMatch(/nothing answered in 45 seconds/);
    /* And it stopped the sync itself — a give-up that leaves the socket
     * grinding is not a give-up. */
    expect(inner.stops).toHaveLength(1);
  });

  it('any real answer disarms it — a number, progress, or an honest error', () => {
    for (const answer of [
      { name: 'synced', night: 5n, asOf: 1 },
      { name: 'syncing', applied: 1n, highest: 2n },
      { name: 'failed', message: 'real error' },
    ] as const) {
      const inner = silentEngine();
      const seen: BalanceState[] = [];
      withOwnClock(inner.engine, 10_000, 45_000)(identity, 0, (s) => seen.push(s));
      inner.tell(answer);
      vi.advanceTimersByTime(60_000);
      expect(seen.at(-1)).toEqual(answer);
      expect(inner.stops).toHaveLength(0);
    }
  });

  it('once the silence is said, a bare "connecting" cannot quietly unsay it', () => {
    const inner = silentEngine();
    const seen: BalanceState[] = [];
    withOwnClock(inner.engine, 10_000, 45_000)(identity, 0, (s) => seen.push(s));
    vi.advanceTimersByTime(10_001);
    inner.tell({ name: 'connecting' });
    expect(seen.at(-1)).toEqual({ name: 'connecting', quietMs: 10_000 });
  });

  it('the SHIPPED thresholds are finite, ordered, and inside a sane ceiling', () => {
    /* The clock's LOGIC was pinned earlier; these pin its NUMBERS. Before this
     * test, setting GIVE_UP_AFTER_MS to effectively-never left every test
     * green — the give-up existed and never came. Two minutes is the
     * ceiling: nobody watches a spinner longer than that, and a probe measured
     * a healthy first sync completing well inside it. */
    expect(Number.isSafeInteger(QUIET_AFTER_MS)).toBe(true);
    expect(Number.isSafeInteger(GIVE_UP_AFTER_MS)).toBe(true);
    expect(QUIET_AFTER_MS).toBeGreaterThan(0);
    expect(QUIET_AFTER_MS).toBeLessThan(GIVE_UP_AFTER_MS);
    expect(GIVE_UP_AFTER_MS).toBeLessThanOrEqual(120_000);
  });

  it('with nothing injected, the clock escalates at the shipped numbers', () => {
    /* `withOwnClock(engine)` — no test values. This is the wiring the app
     * ships, run to its own give-up under fake timers. */
    const inner = silentEngine();
    const seen: BalanceState[] = [];
    withOwnClock(inner.engine)(identity, 0, (s) => seen.push(s));

    vi.advanceTimersByTime(QUIET_AFTER_MS - 1);
    expect(seen.some((s) => s.name === 'connecting' && s.quietMs !== undefined)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(seen.at(-1)).toEqual({ name: 'connecting', quietMs: QUIET_AFTER_MS });

    vi.advanceTimersByTime(GIVE_UP_AFTER_MS - QUIET_AFTER_MS);
    expect(seen.at(-1)?.name).toBe('failed');
    expect(inner.stops).toHaveLength(1);
  });

  it('stopping from outside cancels both timers', () => {
    const inner = silentEngine();
    const seen: BalanceState[] = [];
    const stop = withOwnClock(inner.engine, 10_000, 45_000)(identity, 0, (s) => seen.push(s));
    stop();
    vi.advanceTimersByTime(60_000);
    expect(seen.filter((s) => s.name === 'failed')).toHaveLength(0);
    expect(inner.stops).toHaveLength(1);
  });
});

/*
 * THE COMPARTMENT IS NAMED AT EVERY CALL NOW, AND THESE TESTS NAME IT
 * TOO.
 *
 * It used to default to `openWalletId()`. A default argument is evaluated
 * where the call RUNS, and the writer runs inside an SDK subscription that
 * fires long after the engine started — so a checkpoint computed for one
 * wallet could be written into whichever compartment was open when the sync
 * finished. Making the argument required is what turns that into a compile
 * error rather than a defect; these call sites are the ones the compiler
 * found.
 *
 * `HERE` is the original compartment, which is where a browser holding one
 * wallet keeps everything — so nothing about these tests' subject moves.
 */
const HERE = ORIGINAL_SLOT;

describe('checkpoints: sealed, named by their wallet, and only ever a cache', () => {
  const identity = identityFromSecret(newSecret());
  const CP = { serialized: '{"fake":"snapshot"}', night: 123_456n, asOf: 1_700_000_000_000 };

  it('round-trips for the wallet that wrote it, and is null for any other', async () => {
    const mine = coinPublicKeyOf(identity, 2);
    await saveWalletCheckpoint(mine, 2, CP, HERE);
    expect(await loadWalletCheckpoint(mine, 2, HERE)).toEqual(CP);
    /* Another wallet's key — a replaced account, a different subwallet —
     * must read nothing: a stale cache dressing a new wallet's balance is
     * §4's failure delivered from disk. */
    expect(await loadWalletCheckpoint(coinPublicKeyOf(identity, 3), 2, HERE)).toBeNull();
    expect(await loadWalletCheckpoint(mine, 3, HERE)).toBeNull();
  });

  it('is sealed at rest: the snapshot is not readable off the record', async () => {
    const mine = coinPublicKeyOf(identity, 0);
    await saveWalletCheckpoint(mine, 0, CP, HERE);
    /* Read the raw IndexedDB record and look for the plaintext. */
    const raw = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('midnight-identity', 1);
      open.onsuccess = () => {
        const request = open.result.transaction('keys', 'readonly')
          .objectStore('keys').get('balance-checkpoints');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    });
    const flattened = JSON.stringify(raw);
    expect(flattened).not.toContain('fake');
    expect(flattened).not.toContain(CP.serialized);
    /* Encoding is not sealing: DECODE the stored blob and look again — a
     * base64 of the plaintext must fail here, only ciphertext passes. */
    const entry = (raw as { perAccount: Record<string, { sealed: string }> }).perAccount['0']!;
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(entry.sealed.replace(/-/gu, '+').replace(/_/gu, '/')),
        (c) => c.charCodeAt(0)));
    expect(decoded).not.toContain('fake');
    expect(decoded).not.toContain('123456');
    expect(decoded).not.toContain('coinPublicKey');
  });

  it('damage is absence, never a dead end — a cache must not block a screen', async () => {
    const mine = coinPublicKeyOf(identity, 0);
    await saveWalletCheckpoint(mine, 0, CP, HERE);
    /* Corrupt the sealed blob in place. */
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('midnight-identity', 1);
      open.onsuccess = () => {
        const store = open.result.transaction('keys', 'readwrite').objectStore('keys');
        const get = store.get('balance-checkpoints');
        get.onsuccess = () => {
          const record = get.result as { perAccount: Record<string, { sealed: string }> };
          record.perAccount['0'] = { ...record.perAccount['0']!, sealed: 'AAAA' };
          const put = store.put(record, 'balance-checkpoints');
          put.onsuccess = () => resolve();
          put.onerror = () => reject(put.error);
        };
        get.onerror = () => reject(get.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(await loadWalletCheckpoint(mine, 0, HERE)).toBeNull();
  });

  it('forgetting the wallet forgets the checkpoints', async () => {
    const mine = coinPublicKeyOf(identity, 0);
    await saveWalletCheckpoint(mine, 0, CP, HERE);
    forgetWalletCheckpoints(HERE);
    await waitFor(async () => expect(await loadWalletCheckpoint(mine, 0, HERE)).toBeNull());
  });

  it('the RESTORE door agrees with the address card too', async () => {
    /* The checkpoint path constructs the wallet through `restore` rather
     * than `startWithSecretKeys`; a restore that came back as a different
     * wallet would be the §1.1 failure sneaking in through the cache. */
    const ours = identityFromWords(TEST_MNEMONIC);
    const cold = walletFor(ours, 2);
    const serialized = await cold.serializeState();
    await cold.stop().catch(() => {});
    const restored = walletRestoredFrom(serialized);
    const fromRestored = await bech32Of(restored);
    await restored.stop().catch(() => {});
    expect(fromRestored).toBe(addressFor(ours.moneyAt(2).zswap, NETWORK).bech32);
  }, 60_000);
});

/* `.wallet-balance-row` -> `[data-wallet-balance-row]`. The rows are kit
 * `ListRow`s now; the class carried an `app.css` rule as well as being the
 * hook, so the hook is an attribute and the look comes from the kit. Every
 * assertion below — eleven rows, the exact accounts, the warning words, the
 * age beside the number, the sweep's order — is the one that was here.
 *
 * ============================================================================
 * THE ELEVEN MOVED INTO THE SWITCHER, SO THESE TESTS GO AND LOOK
 * THERE. Not one assertion below is different. What changed is the number of
 * steps to reach the rows: Home shows a preview and its header chevron opens
 * the switcher, which is where the full list and the sweep now live, and the
 * rows carry `[data-wallet-balance-row]` there.
 *
 * The one assertion that did NOT move is the warning sentence about a wallet
 * nobody has checked — it is the rule speaking about Home's own preview, and it
 * is still read off Home. It appears exactly once in the document, which is
 * why `getByText` can still find it with the dialog open.
 * ============================================================================
 */

/** Home's every-wallet card -> the switcher, through the chevron. */
function openEveryWallet(): void {
  fireEvent.click(screen.getByLabelText('See every wallet'));
}

/** The switcher offers six up front; the rest are one press away, as they
 * were before this list carried balances. */
function revealEverySlot(): void {
  fireEvent.click(screen.getByText('Show every slot'));
}

describe('every wallet, honestly — §5 decided, and the invisible-money answer', () => {
  it('all eleven are always listed; unknown wallets say so in warning words', async () => {
    const fake = fakeEngine();
    renderHome(newSecret(), { shielded: fake.engine });
    /* Home's own claim first: the sentence that says an unchecked slot can be
     * holding money is on the screen a person lands on, not behind a press. */
    await waitFor(() =>
      expect(screen.getByText(/can be holding money nobody was told about/)).toBeTruthy());
    openEveryWallet();
    revealEverySlot();
    const listed = (): NodeListOf<Element> =>
      document.querySelectorAll('[data-wallet-balance-row]');
    await waitFor(() => expect(listed()).toHaveLength(11));
    /* SCOPED TO THE DIALOG, because Home's preview is still behind it and says
     * the same true thing about the slots it shows. The claim is unchanged:
     * every one of the eleven says *never checked* — a claim about the eleven,
     * so it is counted where the eleven are. */
    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(within(panel).getAllByText('never checked')).toHaveLength(11);
    /* Never account 1, never a twelfth. */
    const accounts = [...listed()].map((row) => row.getAttribute('data-account'));
    expect(accounts).toEqual(['0', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  });

  it('a checkpointed wallet shows its last number WITH ITS AGE, not as a fresh fact', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 3), 3, {
      serialized: 'x', night: 2_500_000n, asOf: new Date(2026, 7, 18, 9, 30).getTime(),
    }, HERE);
    const fake = fakeEngine();
    render(
      <BalanceEnginesContext.Provider value={{ shielded: fake.engine, unshielded: inert, dust: inert }}>
        <Home identity={identity} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/2\.5 tNIGHT/)).toBeTruthy());
    /* The moment travels with the number — locale renders it either way
     * round, so assert the parts rather than the order. The row also SAYS the
     * number is the shielded side only: a row silent about the kind
     * would read as the whole wallet. */
    const row = screen.getByText(/2\.5 tNIGHT shielded ·/);
    expect(row.textContent).toContain('Aug');
    expect(row.textContent).toMatch(/9:30/);
  });

  it('the sweep checks every slot in turn through the engine — none skipped, none invented', async () => {
    /* An auto-engine that answers instantly: each wallet "holds" its
     * account number in Stars, so the rows can be told apart. */
    const calls: number[] = [];
    const auto: BalanceEngine = (_identity, account, tell) => {
      calls.push(account);
      tell({ name: 'synced', night: BigInt(account) * 1_000_000n, asOf: Date.now() });
      return () => {};
    };
    /* The sweep reads the SHIELDED side (and says so on the card) — wiring
     * it through the unshielded engine here would fail the calls assertion. */
    renderHome(newSecret(), { shielded: auto });
    openEveryWallet();
    revealEverySlot();
    await waitFor(() =>
      expect(document.querySelectorAll('[data-wallet-balance-row]')).toHaveLength(11));
    fireEvent.click(screen.getByText('Check all 11 wallets'));
    await waitFor(() => expect(calls).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    /* NOT ONE ROW ANYWHERE still says it — the dialog's eleven and the preview
     * behind it. A sweep that left *never checked* on the screen a person
     * returns to would be false about money the moment they closed this. */
    await waitFor(() => expect(screen.queryAllByText('never checked')).toHaveLength(0));
    /* Subwallet 10 (account 11) shows its own number — 11 NIGHT. Scoped to the
     * dialog: the preview behind it now shows that slot too, because it holds
     * money and the rule says a funded slot is listed. Same claim, counted where
     * the sweep's own rows are. */
    const swept = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(within(swept).getByText(/11 tNIGHT/)).toBeTruthy();
    /* And the card admits the sweep's limit out loud rather than implying
     * the rows are the whole balance. */
    expect(screen.getByText(/read the SHIELDED balance only/)).toBeTruthy();

    /*
     * AND THE PREVIEW BEHIND THE DIALOG HAS THE ANSWERS, NOT A SPINNER.
     * ADDED, nothing above loosened. FOUND BY MUTATION: deleting the sweep's
     * `announce` left every assertion above green, because the preview stopped
     * at *checking…* — which is not the words `never checked` this test was
     * looking for. **A row that says it is checking, for ever, over a slot
     * that answered a minute ago is worse than the sentence being pinned**,
     * and nothing was watching for it. Every preview row carries a number
     * here, because the fake engine answers for every slot.
     */
    const preview = [...document.querySelectorAll('[data-wallet-preview-row]')];
    expect(preview.length).toBeGreaterThan(0);
    for (const row of preview) {
      expect(row.textContent, row.getAttribute('data-account') ?? '')
        .toMatch(/tNIGHT shielded ·/);
    }
  });

  /*
   * ==========================================================================
   * THE RULE IS WHAT MAKES "THE FIRST THREE" LEGAL, AND THIS IS THE
   * TEST THE DESIGN ASKS FOR BY NAME: *"a funded slot outranks an empty
   * one for a place in that list, and the test says so."*
   * ==========================================================================
   */
  it('a funded slot outranks an empty one for a place in the preview', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    /* Account 9 is EIGHTH in slot order — it could never be in the first
     * three by position, and it holds money. Account 11 has been checked and
     * holds nothing, so it is a real zero rather than an unknown. */
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 9), 9, {
      serialized: 'x', night: 4_000_000n, asOf: Date.now(),
    }, HERE);
    await saveWalletCheckpoint(coinPublicKeyOf(identity, 11), 11, {
      serialized: 'x', night: 0n, asOf: Date.now(),
    }, HERE);
    render(
      <BalanceEnginesContext.Provider
        value={{ shielded: inert, unshielded: inert, dust: inert }}
      >
        <Home identity={identity} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    const previewed = (): string[] =>
      [...document.querySelectorAll('[data-wallet-preview-row]')]
        .map((row) => row.getAttribute('data-account') ?? '');
    /* The funded slot is IN, the checked-empty one is not, and the preview is
     * still three rows long. */
    await waitFor(() => expect(previewed()).toEqual(['0', '2', '9']));
  });

  it('and the preview GROWS rather than hiding money — five funded slots are five rows', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    for (const account of [3, 5, 7, 9, 11]) {
      await saveWalletCheckpoint(coinPublicKeyOf(identity, account), account, {
        serialized: 'x', night: BigInt(account) * 1_000_000n, asOf: Date.now(),
      }, HERE);
    }
    render(
      <BalanceEnginesContext.Provider
        value={{ shielded: inert, unshielded: inert, dust: inert }}
      >
        <Home identity={identity} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    /* Three is a FLOOR. Ranking alone would still have hidden two of these
     * five, which is the rule happening through a layout decision. */
    await waitFor(() => expect(
      [...document.querySelectorAll('[data-wallet-preview-row]')]
        .map((row) => row.getAttribute('data-account')),
    ).toEqual(['3', '5', '7', '9', '11']));
  });
});

/*
 * ════════════════════════════════════════════════════════════════════════════
 * WHICH WALLET AN ASYNCHRONOUS PIECE OF WORK IS FOR IS DECIDED WHEN IT
 * STARTS, NEVER WHEN IT FINISHES.
 *
 * `saveWalletCheckpoint` and `loadWalletCheckpoint` took the compartment from
 * a default argument, `openWalletId()`. **A default argument is evaluated
 * where the call RUNS.** Both callers are asynchronous and one of them —
 * `balance.ts`'s writer — runs inside an SDK subscription that fires whenever
 * a sync completes, which can be long after the person turned to another
 * wallet. A checkpoint computed for wallet A was then written into whichever
 * compartment happened to be open.
 *
 * **NO READER-SIDE CHECK CATCHES THAT.** The same discipline makes a foreign
 * entry read as absent, so nobody is shown a wrong number — but B's own entry
 * for that account has been evicted by A's, and A's map of its money is left
 * in B's compartment, where removing A will not remove it.
 * ════════════════════════════════════════════════════════════════════════════
 */
describe('a wallet switch mid-flight does not move where the work lands', () => {
  it('THE WRITER WRITES WHERE IT IS TOLD, not where the person now is', async () => {
    /* The engine started while A was open; the sync answers after the person
     * has turned to B. The compartment the engine captured is the argument. */
    openWallet('wallet-b');
    await saveWalletCheckpoint('coin-key-a', 3,
      { serialized: 'A-STATE', night: 5n, asOf: 1_000 }, 'wallet-a');

    /* It landed in A's compartment... */
    expect((await loadWalletCheckpoint('coin-key-a', 3, 'wallet-a'))?.serialized)
      .toBe('A-STATE');
    /* ...and B's compartment never heard of it. Before this was an argument,
     * this is where the entry went. */
    expect(await loadWalletCheckpoint('coin-key-a', 3, 'wallet-b')).toBeNull();
  });

  it('AND THE READER TOO: rows started for one wallet finish reading its own', async () => {
    const secret = newSecret();
    const identity = identityFromSecret(secret);
    /* Five funded slots in A's compartment. The eleven-slot read loop awaits
     * once per slot, so all but the first resolve after the switch below. */
    openWallet('wallet-a');
    for (const account of [3, 5, 7, 9, 11]) {
      await saveWalletCheckpoint(coinPublicKeyOf(identity, account), account, {
        serialized: 'x', night: BigInt(account) * 1_000_000n, asOf: Date.now(),
      }, 'wallet-a');
    }

    render(
      <BalanceEnginesContext.Provider
        value={{ shielded: inert, unshielded: inert, dust: inert }}
      >
        <Home identity={identity} secret={secret} />
      </BalanceEnginesContext.Provider>,
    );
    /* THE SWITCH, while the loop is in flight. */
    openWallet('wallet-b');

    /* Every funded slot is still found. Without the capture the later
     * iterations read `wallet-b`'s empty store and those rows go `unknown`,
     * which drops them out of the preview. */
    await waitFor(() => expect(
      [...document.querySelectorAll('[data-wallet-preview-row]')]
        .map((row) => row.getAttribute('data-account')),
    ).toEqual(['3', '5', '7', '9', '11']));
  });
});
