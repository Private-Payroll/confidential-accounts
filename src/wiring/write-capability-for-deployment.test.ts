/**
 * **SUPPLYING THE FIVE, AND THE TWO WAYS THAT COULD GO WRONG QUIETLY.**
 *
 * A deployment that holds four of the five cannot write; it can only fail later
 * and further in, at the moment a transaction is already being paid for. And a
 * deployment that acquired a wallet by starting up would be a process that can
 * spend without anybody having decided it should.
 *
 * So the cases here are about the boundary between *nothing was handed in* and
 * *everything resolved*, and about the fact that there is deliberately nothing
 * in between.
 */
import { CoinlessCustomer } from '../midnight/coinless-customer.js';
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactsIn, deploymentWriteCapability, storagePasswordFrom, type FundedParties,
} from './write-capability-for-deployment.js';
import { refusalForCapability } from './write-capability.js';
import { RemoteFeeSponsor } from '../fee-payer/client.js';

/** A funded pair, with the members the write path actually calls. */
const parties = (): FundedParties => ({
  customer: {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => tx,
    release: async () => {},
  },
  sponsor: {
    addFeeAndFinalise: async (tx: unknown) => tx,
    submit: async () => ({ ref: 'tx', at: '' }),
    release: async () => {},
    payingFor: () => {},
    capacity: async () => ({ dust: 0n, night: 0n }),
  },
});

/** A deployment root OUTSIDE this repository. Nothing here writes into the tree. */
const deploymentRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'capability-'));
  mkdirSync(join(root, '.midnight'), { recursive: true });
  writeFileSync(
    join(root, '.midnight', 'maintenance-authority.json'),
    JSON.stringify({ kind: 'unmaintainable' }),
  );
  return root;
};

describe('a deployment that was handed no wallet', () => {
  it('gets nothing back, and nothing is read off disk to find that out', async () => {
    /*
     * **THE ABSENT CASE IS THE ORDINARY ONE AND IT MUST BE FREE.** A deployment
     * built to watch a chain reads accounts, balances and rounds perfectly
     * well; it should not fail to start, or load a contract, because a wallet
     * it never wanted is missing.
     *
     * RED WHEN: the `if (!wallets) return undefined` guard is moved below the
     * authority read, so a watcher refuses to start for want of a governance
     * record it will never use. The root here has nothing in it at all.
     */
    const nowhere = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      await expect(deploymentWriteCapability(nowhere, {}, null)).resolves.toBeUndefined();
    } finally { rmSync(nowhere, { recursive: true, force: true }); }
  });

  it('and the boundary above then names all five, which is what a watcher needs to read', () => {
    // RED WHEN: `undefined` stops producing the whole list. Somebody who has
    // wired none of them needs to see all five rather than the first.
    const said = refusalForCapability(undefined)!;
    for (const piece of ['maintenance authority', 'compiled contract', 'wallet', 'fee', 'private state']) {
      expect(said.toLowerCase()).toContain(piece.toLowerCase());
    }
  });
});

describe('a deployment that was handed one', () => {
  it('reads the recorded authority rather than choosing one', async () => {
    /*
     * **NEVER SAMPLED.** The SDK's own deploy call falls through to a fresh
     * random signing key when it is given none, and that is how every account
     * this project deployed before the refusal existed acquired one party able
     * to change its rules alone.
     *
     * RED WHEN: `maintenanceAuthority` is defaulted here to any value at all.
     * The root below records `unmaintainable`, which no default would guess.
     */
    const root = deploymentRoot();
    try {
      const c = await deploymentWriteCapability(root, {}, parties());
      expect(c!.maintenanceAuthority).toEqual({ kind: 'unmaintainable' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses when the authority has not been recorded, rather than writing without one', async () => {
    /*
     * **A PROCESS HOLDING A WALLET AND NO GOVERNANCE RECORD IS MISCONFIGURED**,
     * and the honest outcome is a refusal naming the missing fact. The
     * dangerous alternative is a capability that exists and deploys a contract
     * whose rules a sampled key can change.
     *
     * RED WHEN: the authority read is wrapped in anything that swallows.
     */
    const root = mkdtempSync(join(tmpdir(), 'no-authority-'));
    try {
      await expect(deploymentWriteCapability(root, {}, parties()))
        .rejects.toThrow(/no maintenance authority/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('hands back the pair it was given and not something built here', async () => {
    /*
     * RED WHEN: either member is replaced by a locally constructed object. The
     * fee payer is the only thing in this system with spend authority, and one
     * this function assembled for itself would be one nobody chose.
     */
    const root = deploymentRoot();
    const p = parties();
    try {
      const c = await deploymentWriteCapability(root, {}, p);
      expect(c!.customer).toBe(p.customer);
      expect(c!.sponsor).toBe(p.sponsor);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('and what comes back can actually write, by the boundary\'s own rule', async () => {
    /*
     * **THE END-TO-END ASSERTION, AND IT IS THE ONE THAT WOULD CATCH A MEMBER
     * BEING RENAMED.** The rule next door checks the pieces for the members the
     * write path will call rather than for being present, so a capability that
     * satisfies the TYPE and not the rule is exactly the shape this catches.
     *
     * RED WHEN: any of the five is omitted from the returned object.
     */
    const root = deploymentRoot();
    try {
      const c = await deploymentWriteCapability(root, {}, parties());
      expect(refusalForCapability(c), 'the supplier produced a capability that cannot write')
        .toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the private state key', () => {
  it('is fetched when it is used and is not held in the object', async () => {
    /*
     * **A FUNCTION RATHER THAN A STRING** so the material is not sitting in a
     * resolved configuration object for the life of the process. Read late, it
     * also means a key that arrives after boot is picked up.
     *
     * RED WHEN: the value is read at the moment the thunk is built.
     */
    const env: NodeJS.ProcessEnv = {};
    const key = storagePasswordFrom(env);
    env.MIDNIGHT_PRIVATE_STATE_PASSWORD = 'not-a-secret: a test literal';
    await expect(key()).resolves.toBe('not-a-secret: a test literal');
  });

  it('refuses rather than defaulting, because a default is a store anybody can open', async () => {
    // RED WHEN: a fallback value is introduced. What the store holds is the
    // signing material a device proves with.
    await expect(storagePasswordFrom({})()).rejects.toThrow(/no key/i);
  });

  it('and a deployment that will never write is not stopped from reading by its absence', async () => {
    /*
     * The refusal is at the moment of USE and not at startup, so a watcher with
     * no key still serves every read.
     *
     * RED WHEN: the check is hoisted out of the returned function.
     */
    const root = deploymentRoot();
    try {
      const c = await deploymentWriteCapability(root, {}, parties());
      expect(typeof c!.storagePassword).toBe('function');
      await expect(c!.storagePassword()).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('where the compiled contract is looked for', () => {
  it('is under the deployment\'s own root', () => {
    // RED WHEN: the path is a constant, which would make every deployment on a
    // machine prove against one deployment's keys.
    expect(artifactsIn('/somewhere')).toBe('/somewhere/contracts/managed');
    expect(artifactsIn('/elsewhere')).not.toBe(artifactsIn('/somewhere'));
  });
});

describe('a fee payer this deployment\'s settings name', () => {
  const customerOnly = () => ({ customer: parties().customer });
  const named = parties().sponsor;

  /*
   * A fee payer alone is enough to write, and the company's side is one that
   * holds nothing. RED WHEN: a wallet is built here for the company, or the
   * side that is made refuses nothing.
   */
  it('is enough to write, and the company\'s side it comes with holds nothing and refuses a coin', async () => {
    const root = deploymentRoot();
    try {
      const c = await deploymentWriteCapability(root, {}, null, () => named);
      expect(c, 'no capability came back').toBeDefined();
      expect(c!.customer).toBeInstanceOf(CoinlessCustomer);
      expect(refusalForCapability(c)).toBeNull();
      const needsACoin = {
        intents: new Map([[1, {}]]),
        imbalances: (segment: number) => new Map(segment === 0 ? [[{ tag: 'shielded' }, -1n]] : []),
        bind: () => 'bound',
      };
      await expect(c!.customer.balanceOwnLegs(needsACoin, new Date())).rejects.toThrow(/holds none for any company/);
      const movesNothing = { ...needsACoin, imbalances: () => new Map([[{ tag: 'dust' }, -5n]]) };
      await expect(c!.customer.balanceOwnLegs(movesNothing, new Date())).resolves.toBe('bound');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /* RED WHEN: a deployment with no fee payer at all writes. */
  it('without a fee payer there is still nothing to write with', async () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'empty-'));
    try {
      await expect(deploymentWriteCapability(nowhere, {}, null, () => null)).resolves.toBeUndefined();
    } finally { rmSync(nowhere, { recursive: true, force: true }); }
  });

  /* RED WHEN: the configured fee payer is ignored when only the company's side is handed in. */
  it('pays, once the company\'s side is handed in', async () => {
    const root = deploymentRoot();
    const handed = customerOnly();
    try {
      const c = await deploymentWriteCapability(root, {}, handed, () => named);
      expect(c, 'no capability came back').toBeDefined();
      expect(c!.sponsor, 'the fee payer the settings name was not the one used').toBe(named);
      expect(c!.customer).toBe(handed.customer);
      expect(refusalForCapability(c)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /* RED WHEN: the two-fee-payer refusal is removed, so one silently wins. */
  it('and one handed in as well is refused', async () => {
    const root = deploymentRoot();
    try {
      await expect(deploymentWriteCapability(root, {}, parties(), () => named))
        .rejects.toThrow(/its settings name another/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /*
   * THROUGH THE REAL SETTINGS READER. RED WHEN: the default reader is not the
   * one that turns the two settings into a client, or a half-configured
   * deployment starts quietly.
   */
  it('comes from the two settings, and half of them is refused', async () => {
    const root = deploymentRoot();
    const env = {
      MIDNIGHT_FEE_PAYER_URL: 'http://127.0.0.1:6310',
      MIDNIGHT_FEE_PAYER_SECRET: 'not-a-secret: a test literal of enough length',
    };
    try {
      const c = await deploymentWriteCapability(root, env, customerOnly());
      expect(c, 'no capability came back').toBeDefined();
      expect(c!.sponsor).toBeInstanceOf(RemoteFeeSponsor);
      await expect(deploymentWriteCapability(root, { MIDNIGHT_FEE_PAYER_URL: env.MIDNIGHT_FEE_PAYER_URL }, null))
        .rejects.toThrow(/MIDNIGHT_FEE_PAYER_SECRET is not/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

