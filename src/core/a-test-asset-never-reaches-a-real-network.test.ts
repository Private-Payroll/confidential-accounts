import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NETWORKS, NETWORK as THE_NETWORK_THIS_BUILD_IS_ON } from 'midnight-identity/network';

import {
  SEED_ASSETS, StaticAssetRegistry, assets as productAssets,
  TEST_SETTLEMENT_ASSET, TEST_SETTLEMENT_MINTED_ON,
  aTestAssetMayExistOn, aTestAssetMayExistOnAKindOf, testAssetsFor, isATestAsset,
  refuseATestAssetOffItsNetwork,
  ledgerFormOf, ledgerTokenOf, privateForm,
  type Asset,
} from './assets.js';
import { NETWORK_IDS, networkRecord } from './networks.js';

/**
 * **A TEST ASSET IS BACKED BY NOTHING, AND THE ONLY THING STANDING BETWEEN IT
 * AND SOMEBODY'S REAL PAY IS THIS.**
 *
 * A payroll run settling in a worthless token is not a run that fails. It is a
 * run that succeeds: real approvals, a real proof, a real settlement, and six
 * people paid nothing at all, with no way back. Every other defect in this
 * repository is smaller than that one.
 *
 * So this file asks the question for EVERY network this toolchain knows,
 * including the ones nobody has ever run, and then asks whether there is any
 * way to answer it differently without editing source.
 */

/**
 * **THE NETWORKS WHERE REAL MONEY SETTLES, ASKED OF THE RECORDS RATHER THAN
 * WRITTEN DOWN HERE.**
 *
 * This used to be the literal `['mainnet']`, which asked the question only of
 * the network somebody had thought of. A second real network added to the
 * records would have been tested by nothing at all; now it is tested by
 * existing.
 */
const REAL_NETWORKS: readonly string[] = NETWORK_IDS.filter(id => networkRecord(id).kind === 'real');

/** The registry's own source, and the same source with every comment blanked. */
const registrySource = readFileSync(
  fileURLToPath(new URL('./assets.js', import.meta.url)).replace(/\.js$/, '.ts'), 'utf8');

/**
 * Comments out, newlines kept.
 *
 * **A SENTENCE SAYING THE REGISTRY DOES NOT READ `process.env` CONTAINS
 * `process.env`**, so a scan over the raw text would fail on the paragraph that
 * promises the thing it is checking. Only code is scanned.
 */
const codeOnly = ((src: string): string => {
  let out = ''; let i = 0;
  while (i < src.length) {
    const c = src[i]!; const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
})(registrySource);

describe('§1 which networks a test asset may exist on, asked for every one of them', () => {
  it('EVERY network whose record says real money settles there gets no test asset', () => {
    /*
     * RED WHEN this list empties, which would make every assertion in the loop
     * below vacuous rather than satisfied.
     */
    expect(REAL_NETWORKS.length).toBeGreaterThan(0);
    for (const real of REAL_NETWORKS) {
      /* RED WHEN a network whose own record says real money settles there is
       * admitted - by having its name added to the asset's list, or by its
       * record's `kind` being changed, which are now two separate edits and
       * BOTH are needed. */
      expect(aTestAssetMayExistOn(real), real).toBe(false);
      expect(testAssetsFor(real), real).toEqual([]);
      expect(TEST_SETTLEMENT_MINTED_ON).not.toContain(real);
    }
  });

  it('AND THE KIND ALONE REFUSES IT, with the name list saying yes', () => {
    /*
     * **THE CONTROL FOR THE CONDITION THAT MATTERS.** The two conditions could
     * hide each other: with the colour's own list refusing every real network,
     * a broken `kind` check would never show. So this drives `kind` on its own,
     * against a network the colour list DOES admit.
     *
     * RED WHEN the kind stops being consulted - at which point a real network
     * that somebody had also listed as a home for the colour would be admitted,
     * and a name would be the only thing standing between a worthless token and
     * somebody's pay.
     */
    const listed = TEST_SETTLEMENT_MINTED_ON[0]!;
    expect(networkRecord(listed).kind).toBe('test');
    expect(aTestAssetMayExistOn(listed)).toBe(true);
    /*
     * RED WHEN the kind stops being consulted. The colour's own list says yes
     * to this network; the only thing refusing here is the record's `kind`, so
     * this is the assertion that dies the day a name is all that stands between
     * a worthless token and somebody's pay.
     */
    expect(aTestAssetMayExistOnAKindOf('real', listed)).toBe(false);
    expect(aTestAssetMayExistOnAKindOf('test', listed)).toBe(true);
    /* RED WHEN the colour's own home stops being consulted: a test network the
     * colour was never minted on would get a row naming money nobody minted. */
    for (const id of NETWORK_IDS.filter(n => !TEST_SETTLEMENT_MINTED_ON.includes(n))) {
      expect(aTestAssetMayExistOnAKindOf('test', id), id).toBe(false);
    }
    /*
     * `expect(networkRecord(real).kind).toBe('real')` stood here and could not
     * fail: `REAL_NETWORKS` is DEFINED as the ids whose kind is `real`, so it
     * restated the filter that built the list.
     */
    for (const real of REAL_NETWORKS) {
      expect(TEST_SETTLEMENT_MINTED_ON.includes(real), real).toBe(false);
    }
  });

  it('every network this toolchain knows gets an answer, and only stagenet gets the row', () => {
    const allowed: string[] = [];
    for (const network of NETWORKS) {
      const rows = testAssetsFor(network);
      /* RED WHEN a network silently gets some other number of test rows. */
      expect(rows.length, network).toBe(aTestAssetMayExistOn(network) ? 1 : 0);
      if (rows.length > 0) allowed.push(network);
    }
    /* RED WHEN the permitted set widens. It is one network and this is the list. */
    expect(allowed).toEqual(['stagenet']);
  });

  it('a network nobody has thought of is refused by DEFAULT, not admitted by default', () => {
    for (const invented of ['', ' ', 'STAGENET', 'stagenet2', 'mainnet-2', 'prod', 'production',
      'stagenet ', 'main', 'localhost', 'undefined', 'null', 'devnet', 'testnet']) {
      /*
       * RED WHEN the rule is written as a list of networks a test asset may NOT
       * exist on. A deny-list answers "yes" for every name nobody wrote down,
       * and the name nobody wrote down is the one a future network has.
       */
      expect(aTestAssetMayExistOn(invented), JSON.stringify(invented)).toBe(false);
      expect(testAssetsFor(invented), JSON.stringify(invented)).toEqual([]);
    }
  });
});

describe('§2 a registry carrying the row off its network does not build at all', () => {
  const theRow: Asset = {
    code: TEST_SETTLEMENT_ASSET, name: 'Test Dollar', kind: 'token', decimals: 6,
    chain: 'midnight', ledger: { shielded: 'ab'.repeat(32), unshielded: null },
    enabled: true, sortOrder: 90,
  };

  it('REFUSES the row on every network it may not exist on, whoever assembled the list', () => {
    for (const network of [...NETWORKS, 'prod', 'something-new']) {
      if (aTestAssetMayExistOn(network)) continue;
      /*
       * RED WHEN the seed is the only thing that keeps the row off a network.
       * A row can reach a registry by being spread in from a fixture, copied
       * into a server's own list, or read out of a record; the seed is one way
       * in and this is the only way to a registry.
       */
      expect(() => refuseATestAssetOffItsNetwork([theRow], network), network).toThrow(
        `${TEST_SETTLEMENT_ASSET} is a test asset`);
      expect(() => refuseATestAssetOffItsNetwork([theRow], network), network)
        .toThrow(/pays real people nothing at all/);
      /* RED WHEN the refusal offers a way to permit it, which is the thing that must not exist. */
      expect(() => refuseATestAssetOffItsNetwork([theRow], network), network)
        .toThrow(/no setting that permits it and none may be added/);
    }
  });

  it('DROPS NOTHING SILENTLY: it throws rather than returning a registry a row short', () => {
    /*
     * RED WHEN the refusal becomes a filter. A registry quietly missing an
     * asset is a payroll run refused for a reason nobody can find, on a screen
     * that still lists the currency it was set up with.
     */
    let threw = false;
    try { refuseATestAssetOffItsNetwork([theRow], 'mainnet'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('lets an ordinary registry build on any network, so the refusal is not a wall', () => {
    for (const network of [...NETWORKS, 'prod']) {
      /* RED WHEN the refusal fires on rows that are not test assets. */
      expect(() => refuseATestAssetOffItsNetwork(
        SEED_ASSETS.filter(a => !isATestAsset(a.code)), network), network).not.toThrow();
    }
  });

  /**
   * **THE HALF THIS BUILD CANNOT EXERCISE, SAID OUT LOUD RATHER THAN SKIPPED.**
   *
   * The refusal above is pure and is driven for every network. Whether the
   * REGISTRY runs it cannot be driven here, because this build is compiled for
   * a network where the row is allowed and the constant that says so is not
   * something a test may vary - if it were, it would be the override this whole
   * file exists to prove does not exist.
   *
   * So the call is pinned where it is made. It is a weaker instrument than
   * running it and it is the strongest one available without adding the door.
   */
  it('the registry constructor runs the refusal, so the seed is not the only thing checked', () => {
    /* RED WHEN the constructor stops calling it, which is how a hand-built list reaches a server. */
    expect(registrySource).toContain(
      'refuseATestAssetOffItsNetwork(assets, THE_NETWORK_THIS_BUILD_IS_ON);');
    /* RED WHEN it is called with something other than the compiled-in constant. */
    expect(registrySource).not.toMatch(/refuseATestAssetOffItsNetwork\(assets, (?!THE_NETWORK)/);
    /* And an ordinary registry still builds on this build's own network. */
    expect(() => new StaticAssetRegistry([...SEED_ASSETS])).not.toThrow();
    expect(() => new StaticAssetRegistry([theRow, { ...theRow, code: 'ZZQ' }]))
      .toThrow(/name the same private token/);
  });
});

describe('§3 there is no way to answer the question differently without editing source', () => {
  it('reads the source it is meant to read', () => {
    /* RED WHEN this stops reading the registry, which would make §3 assert nothing. */
    expect(registrySource).toContain('export const SEED_ASSETS');
    expect(codeOnly).toContain('TEST_SETTLEMENT_MINTED_ON');
  });

  it('THE REGISTRY READS NO ENVIRONMENT, NO BUILD FLAG AND NO HOSTNAME', () => {
    /*
     * RED WHEN any of these appears in the registry. The brief for this row is
     * that the refusal cannot be walked past by a configuration value; a single
     * `process.env` in this file would be exactly that, whatever it was added
     * for.
     */
    for (const wayIn of ['process.env', 'import.meta.env', 'window.', 'location.',
      'globalThis.', 'readFileSync', 'process.argv']) {
      expect(codeOnly, wayIn).not.toContain(wayIn);
    }
  });

  it('the network comes from the compiled-in constant and from nowhere else', () => {
    /*
     * RED WHEN a second source of the network name appears. The constant is
     * compiled into a package a deployment cannot vary, because a Midnight
     * address carries the network name inside the string - which is why it is
     * a safe thing to hang this on and why a second source is not.
     */
    const imports = [...codeOnly.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    /*
     * **TWO IMPORTS AND THE SECOND ONE IS THE POINT.** The registry asks the
     * network's own record what KIND of network it is, and `./networks.js`
     * reads no environment, no argument vector and no file at run time - the
     * record is imported, so it is part of the build exactly as the constant
     * is. A third entry here is a third thing this gate's answer can depend on.
     */
    expect(imports).toEqual(['midnight-identity/network', './networks.js']);
    expect(codeOnly).toContain("import { NETWORK as THE_NETWORK_THIS_BUILD_IS_ON } from 'midnight-identity/network'");
    expect(codeOnly).toContain("import { isNetworkId, networkRecord, type NetworkKind } from './networks.js'");
    /* RED WHEN the permitted-network answer takes an argument with a default, which is an override. */
    expect(codeOnly).toContain('export const aTestAssetMayExistOn = (network: string): boolean =>');
    /*
     * RED WHEN the registry's own question stops going through the records.
     * The pure rule beside it may be handed a kind, which is how the condition
     * that matters is watched refusing; what must not change is that the
     * REGISTRY asks the record rather than being told an answer.
     */
    expect(codeOnly).toContain('aTestAssetMayExistOnAKindOf(networkRecord(network).kind, network)');
    /*
     * **THE SEED IS BUILT WITH THE CONSTANT AND NOT WITH A NAME.**
     *
     * RED WHEN a literal is written there instead. With this build on the same
     * network the two behave identically and no behavioural test can tell them
     * apart - so it is asked of the text. The day the pair moves, a literal
     * would ship the row onto a network that is no longer this one, and the
     * only thing that would notice is this line.
     */
    expect(codeOnly).toContain('...testAssetsFor(THE_NETWORK_THIS_BUILD_IS_ON),');
    expect(codeOnly).not.toMatch(/testAssetsFor\(['"`]/);
    /* RED WHEN the constructor is told an answer rather than asking. */
    expect(codeOnly).not.toMatch(/refuseATestAssetOffItsNetwork\(assets, ['"`]/);
    /*
     * **THE ONLY NETWORK NAME THIS FILE MAY WRITE DOWN IS THE COLOUR'S OWN
     * HOME.** RED WHEN a second one appears - in a comparison, in a default, in
     * a list beside the first. The record says what kind of network each is;
     * this file has no business knowing their names.
     */
    const names = [...codeOnly.matchAll(/['"`](undeployed|preview|preprod|qanet|stagenet|mainnet|devnet|testnet)['"`]/g)]
      .map(m => m[0]);
    expect(names).toEqual(["'stagenet'"]);
  });

  it('and this build is on a network the row is allowed on, which is why the row is here', () => {
    /*
     * RED WHEN the pair's network moves. The row's presence follows one
     * constant, so this is the assertion that notices the day it changes -
     * rather than a payroll screen noticing it.
     */
    expect(aTestAssetMayExistOn(THE_NETWORK_THIS_BUILD_IS_ON)).toBe(true);
    expect(productAssets.find(TEST_SETTLEMENT_ASSET)).not.toBeNull();
  });
});

describe('§4 what the row says about itself, and what it must not say', () => {
  const row = productAssets.require(TEST_SETTLEMENT_ASSET);

  /**
   * **THE COLOUR, AGAINST A VALUE MEASURED OFF THE CHAIN AND WRITTEN DOWN HERE.**
   *
   * Read from stagenet: the shielded deposit that settled on 30 Aug moves this
   * colour, and the note it created is held by a vault on chain. **It is a
   * second copy on purpose.** The two assertions this replaced could not fail:
   * one asked whether the token was 64 hex characters, which the registry's own
   * constructor already refuses anything else for, and the other compared
   * `ledgerTokenOf`'s answer against the row it reads that answer out of - two
   * live computations of one value, which is the exact shape this project has
   * been burnt by twice.
   */
  const MEASURED_ON_STAGENET = 'abda184485c6abbbe4440d65b99ef88e0f79f61ec19af52a5bb0d91b4a824679';  // not-a-secret: the colour a mint produced on a public test network, published by the chain itself and readable by anyone; this is the asset's own identity and there is no other way to name it

  it('has a private form and NO public one, because nothing ever minted a public one', () => {
    /* RED WHEN the row claims a public form, which is a payment no circuit can send. */
    expect(row.ledger.unshielded).toBeNull();
    expect(ledgerFormOf(row, 'unshielded').of).toBe('no-such-form');
    /*
     * RED WHEN the colour in the registry is changed to anything but a value
     * measured off the chain and written down here beside it. A colour nothing
     * ever minted is money no wallet can fund a deposit with, and a payment
     * naming it fails after the approvals and the fees.
     */
    expect(row.ledger.shielded).toBe(MEASURED_ON_STAGENET);
    expect(ledgerTokenOf(TEST_SETTLEMENT_ASSET, 'shielded')).toBe(MEASURED_ON_STAGENET);
  });

  it('THE VALUE THE GATE ACTUALLY GOT EQUALS WHAT THE SOURCE SAYS', async () => {
    /*
     * **THIS COMPARISON READS SOURCE, AND IT USED TO READ A BUILD OUTPUT.**
     *
     * Everything in this file rests on one constant, which reaches the registry
     * through the package's own `exports` map - that is, through whatever was
     * last compiled. So the question worth asking is whether the value that
     * ARRIVED is the value the source states.
     *
     * It used to be asked by opening `lib/wallet/network.js` and comparing its
     * text against `src/wallet/network.ts`. That file is a build output and is
     * not committed, **so in a clone of the published repository there is no
     * built copy and the comparison could not run at all** - it would fail on a
     * missing file and say nothing about drift. Worse, it made a gate's own
     * test depend on a path that only exists after somebody has built.
     *
     * So: the value in use against the source text. It needs no artefact, it
     * runs in a fresh clone, and it catches exactly what the old form was for -
     * a built copy that has drifted - because a drifted build is a value that
     * no longer equals what the source says. **The build is verified by
     * building it, which the package's own install step does; a text comparison
     * in a test was never what made the build correct.**
     *
     * RED WHEN the source constant moves and the build does not, or the build
     * moves and the source does not - whichever of them moved.
     */
    const { readFileSync: read } = await import('node:fs');
    const source = read(
      fileURLToPath(new URL('../../packages/identity/src/wallet/network.ts', import.meta.url)), 'utf8');
    /*
     * Anchored on the constant's own name, with only a type annotation allowed
     * between it and the `=`. An unanchored pattern would happily pin a
     * `NETWORK_DEFAULT` somebody added above the real one.
     */
    const stated = /export const NETWORK(?:\s*:\s*[A-Za-z]+)?\s*=\s*'([a-z]+)'/.exec(source)?.[1];
    expect(stated, 'the source states no network constant this can read').toBeTruthy();
    expect(THE_NETWORK_THIS_BUILD_IS_ON).toBe(stated);
    /*
     * RED WHEN this test starts needing a build artefact again, which is what
     * made it unrunnable in a published clone.
     */
    const own = read(fileURLToPath(import.meta.url), 'utf8');
    /* Assembled rather than written, so this file does not contain the string
     * it is checking for and defeat its own scan. */
    expect(own).not.toContain(['packages', 'identity', 'lib'].join('/'));
  });

  it('is six decimals, a token, and on midnight, which is the path a real one will take', () => {
    /* RED WHEN the row stops exercising the same parsing and printing path a real stablecoin will. */
    expect(row.decimals).toBe(6);
    expect(row.kind).toBe('token');
    expect(row.chain).toBe('midnight');
  });

  it('is the only asset a private payment can be made in, and NIGHT is still not one', () => {
    /* RED WHEN a second asset gains a private form without an argument for it. */
    expect(productAssets.all().filter(a => privateForm(a).of === 'available').map(a => a.code))
      .toEqual([TEST_SETTLEMENT_ASSET]);
    /* RED WHEN NIGHT is given a private form. There is no private NIGHT on this platform. */
    expect(productAssets.require('NIGHT').ledger.shielded).toBeNull();
  });
});
