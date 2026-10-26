// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NETWORK } from 'midnight-identity/network';
import type { CreationLedger } from 'midnight-identity/profile/creation-sign';
import * as accountModule from '../../../../contracts/managed/contract/index.js';
import { witnesses } from '../../../../contracts/src/witnesses.js';
import { keysOnDisk, ACCOUNT_KEYS } from '../../../../contracts/test/keys-on-disk.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { liveConstruction } from '../chain/account-as-constructed.js';
import { labelInAccountState } from '../chain/company-label-on-chain.js';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { drawCompanyLabel, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { RelayLabel } from 'midnight-identity/profile/channel';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { toHex } from '../../../../src/core/crypto.js';
import { foundTheCompanyHere } from '../../../../src/core/company-founding.js';
import { withCreation, withNewSeat, type Keyring, type SavedCreation } from '../../../../packages/web-shared/src/keyring-blob.js';
import { accountBuilding, type AccountBuilding, type BuilderWorkerLike } from '../chain/account-builder-client.js';
import { accountBuilderDeps, startAccountBuilder } from '../chain/account-builder.js';
import type { PayKeyStandingAnswered } from '../chain/account-builder.js';
import { foundingSeatOf } from '../keyring/founding-seat.js';
import { finishCompanyAction, type FinishCompanyReach } from './finish-company.js';
import type { ActionStep, StepContext, WalletRecord } from './definition.js';
import { StepRefused } from './definition.js';

/*
 * FINISHING A COMPANY, AS ONE ACTION IN THE WALLET, step by step, with the chain and the account builder stood in for:
 * what each step reads, which seat it proves with, what it hands the page and in what order, and what it refuses.
 * Building the account's deploy runs against the compiled contract in the gated tests; here each step is taken up
 * from what the saved keys and the chain already show, as an action taken up again after a stop is.
 */
const secret = newSecret();
const identity = identityFromSecret(secret);
const ACCOUNT = 'c0'.repeat(32);
const DEPLOY = 'REVQTE9Z';
const INSERT = 'SU5TRVJU';
const AGAIN = 'QUdBSU4=';
const AGAIN_INSERT = 'QUdBSU5JTg==';
const MINUTE = 60_000;

/** A company this wallet founded for `label`, as its saved keys keep it once its account was sent. */
const keptFor = async (label: CompanyLabel, over: Partial<SavedCreation> = {}, seatOf = label): Promise<{ keys: Keyring; creation: SavedCreation }> => {
  const seat = await foundingSeatOf(identity, seatOf);
  const founded = foundTheCompanyHere({
    name: 'Acme Ltd', signer: { name: 'Priya', role: 'admin' }, userId: 'usr_a', label,
    seat: { signingPublicKey: seat.signingPublicKey, wrappingPublicKey: seat.wrappingPublicKey, leaf: seat.leaf }, signingSecret: seat.signingSecret,
  });
  const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(identity, label).value).toLowerCase() as never };
  const creation: SavedCreation = {
    accountId: founded.account.id, person: 'usr_a', label, foundingKey: walletKey,
    request: { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' }], threshold: 1, companyLabel: label, foundingKey: walletKey, founding: founded },
    made: true, recorded: true,
    deploy: { account: ACCOUNT as never, tx: DEPLOY, insert: [], builtAt: Date.now() },
    signed: { tx: INSERT, signature: { tag: 'schnorr', value: '5a'.repeat(64) }, builtAt: Date.now() },
    ...over,
  } as SavedCreation;
  const keys = withCreation(withNewSeat({ accounts: {} }, creation.accountId, {
    signerId: founded.seat.signerId, signingSecret: seat.signingSecret, wrappingSecret: seat.wrappingSecret, blinding: seat.blinding, scope: seat.scope,
  }), creation);
  return { keys, creation };
};

const standingOf = (over: { open?: boolean; approvals?: number; committed?: string | null; sealedMine?: boolean; isThisKey?: boolean } = {}): PayKeyStandingAnswered => ({
  committed: over.committed ?? null, isThisKey: over.isThisKey ?? (over.committed ?? null) !== null, sealedMine: over.sealedMine ?? false,
  round: { commitment: 'c1'.repeat(32), payload: 'c2'.repeat(32), salt: 'c3'.repeat(32), proposal: 'c4'.repeat(32), open: over.open ?? false, approvals: String(over.approvals ?? 0), needed: '1', stale: false },
  noVault: 'fe'.repeat(32), wrap: ['d1', 'd2', 'd3', 'd4'].map((b) => b.repeat(32)),
});

/** What the steps were handed and did: their relays, what they kept, and what they asked the builder and the chain. */
const world = (opts: {
  keys: Keyring; standings?: PayKeyStandingAnswered[]; finished?: boolean[]; held?: boolean | boolean[];
  record?: Partial<WalletRecord>;
  /** How far the chain's clock is ahead of this device's. */
  skew?: number;
  /** Each transaction's time to live; one not named lives the full thirty minutes from now. */
  ttl?: Record<string, number>;
  relayRefuses?: boolean;
  keepRefuses?: boolean;
  /** Answers the builder gives for what it builds, in place of this file's own. */
  builds?: (ask: Record<string, unknown>) => Promise<unknown> | undefined;
}) => {
  const relays: Array<{ tx: string; label: RelayLabel | undefined }> = [];
  const events: string[] = [];
  let h = 0;
  const asks: Array<Record<string, unknown>> = [];
  const pinned: string[] = [];
  let keys = opts.keys;
  let s = 0;
  let f = 0;
  const standings = opts.standings ?? [standingOf()];
  const finished = opts.finished ?? [true];
  const build = (async (ask: Record<string, unknown>) => {
    asks.push(ask);
    if (ask['ask'] === 'pay-key-standing') return { id: 0, ok: true, ask: 'pay-key-standing', standing: standings[Math.min(s++, standings.length - 1)] };
    if (ask['ask'] === 'governed-call') return { id: 0, ok: true, ask: 'governed-call', tx: `VFgt${String((ask['order'] as { circuit: string }).circuit).slice(0, 4)}` };
    const theirs = opts.builds?.(ask);
    if (theirs !== undefined) return theirs;
    if (ask['ask'] === 'creation-again') return { id: 0, ok: true, ask: 'creation-again', account: ACCOUNT, deploy: AGAIN, insert: AGAIN_INSERT };
    throw new Error(`this test builds no ${String(ask['ask'])}`);
  }) as unknown as AccountBuilding;
  const reach: FinishCompanyReach = {
    build,
    chain: {
      presence: async () => {
        const held = Array.isArray(opts.held) ? opts.held[Math.min(h++, opts.held.length - 1)]! : opts.held ?? true;
        return { held, blockTime: Date.now() + (opts.skew ?? 0) };
      },
      account: async () => ({ state: new Uint8Array([1, 2]), parameters: new Uint8Array([3]), finished: finished[Math.min(f++, finished.length - 1)]! }),
    },
    ledger: async () => ({}) as never,
    construction: async () => { throw new Error('nothing is built here'); },
    built: () => ({ of: 'missing', why: 'not in this test' }),
    verifiers: () => null,
    network: 'undeployed',
    labelIn: () => null,
    pause: async () => {},
    now: () => Date.now(),
    timeToLive: async (tx) => opts.ttl?.[tx] ?? Date.now() + (opts.skew ?? 0) + 30 * 60_000,
  };
  const record: WalletRecord = {
    drewTheLabel: () => false,
    pinnedFor: () => ({ account: ACCOUNT, created: true }),
    pin: async (_l, a) => { pinned.push(a); },
    ...opts.record,
  };
  const ctx = (step: number): StepContext => ({
    intent: undefined as never, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: null, held: { identity, secret, wallet: record }, at: { step, steps: 5 }, signal: new AbortController().signal,
    relay: async (tx, label) => {
      events.push(`relay ${label?.what ?? ''} ${tx}`);
      if (opts.relayRefuses === true) throw new Error('relay-refused');
      relays.push({ tx, label });
    },
    call: async () => { throw new Error('finishing a company calls nothing'); },
    tell: () => {},
    keyring: {
      open: () => ({ read: () => structuredClone(keys), metadata: () => ({}) as never, seal: () => { throw new Error('not here'); }, letGo: () => {} }),
      keep: async (change) => {
        if (opts.keepRefuses === true) throw new Error('keep-refused');
        keys = change(structuredClone(keys));
        events.push('keep');
      },
    },
  });
  return { reach, ctx, relays, asks, pinned, keysNow: () => keys, record, events };
};

const intentFor = (label: string): ActIntent => ({ name: 'finish-company', fields: { company: label } } as ActIntent);
const runAll = async (steps: readonly ActionStep[], ctx: (step: number) => StepContext, from = 0): Promise<void> => {
  for (let i = from; i < steps.length; i += 1) await steps[i]!.run(ctx(i + 1));
};

describe('FINISHING A COMPANY IN THE WALLET', () => {
  /* RED WHEN: a step proves with anything but the founding seat this wallet makes from its words, or reads the chain from anywhere but its own reads, or hands the page anything but built transactions in order. */
  it('carries a company sent and not finished to its end: the second step, then the pay-record key\'s proposal and seal, the raise having counted as the approval', async () => {
    const label = drawCompanyLabel();
    const { keys, creation } = await keptFor(label);
    const w = world({
      keys,
      finished: [false, true],
      /* The chain counts the raise as the raiser's own approval, so the proposal reads open with one approval at once. */
      standings: [standingOf(), standingOf({ open: true, approvals: 1 }), standingOf({ open: true, approvals: 1 }),
        standingOf({ open: true, approvals: 1 }), standingOf({ committed: 'c1'.repeat(32), sealedMine: true })],
    });
    const action = finishCompanyAction(w.reach);
    const steps = action.steps(intentFor(label));
    expect(steps).toHaveLength(5);
    await runAll(steps, w.ctx);
    /* RED WHEN: a transaction is handed over for anything but what it is, or out of order, or the raiser sends an approval of its own after a raise the chain already counted. */
    expect(w.relays.map((r) => r.label?.what)).toEqual(['creation-finish', 'pay-key-propose', 'pay-key-seal']);
    expect(w.relays[0]!.tx).toBe(INSERT);
    /* RED WHEN: the account's deploy is sent again for an account the chain already holds. */
    expect(w.relays.some((r) => r.label?.what === 'creation')).toBe(false);
    const words = seatKeysFor(identity, label, 0);
    const calls = w.asks.filter((a) => a['ask'] === 'governed-call');
    expect(calls.map((a) => (a['order'] as { circuit: string }).circuit)).toEqual(['propose', 'sealPayKey']);
    /* RED WHEN: a proof is made with a seat's secret from anywhere but this wallet's words. */
    for (const c of calls) expect((c['material'] as { signingSecret: string }).signingSecret).toBe(toHex(words.signingSecret));
    for (const a of w.asks.filter((x) => x['ask'] === 'pay-key-standing')) expect(a['signingSecret']).toBe(toHex(words.signingSecret));
    /* RED WHEN: the call state is taken from anything but the wallet's own read of the chain. */
    for (const c of calls) expect(c['chain']).toEqual({ accountState: Buffer.from([1, 2]).toString('base64'), parameters: Buffer.from([3]).toString('base64') });
    /* RED WHEN: any part of the seat's secrets is in what the page is handed. */
    const handed = JSON.stringify(w.relays);
    for (const part of [words.signingSecret, words.wrappingSecret, words.salt]) {
      expect(handed).not.toContain(toHex(part));
      expect(handed).not.toContain(toBase64Url(part));
    }
    /* RED WHEN: what was kept of the creation is left in the saved keys once the company is finished, or the seat is dropped with it. */
    expect(w.keysNow().creations?.[creation.accountId]).toBeUndefined();
    expect(w.keysNow().accounts[creation.accountId]).toBeDefined();
  });

  /* RED WHEN: a round a company's earlier account raised (the chain shows it open with no approval) is not approved by this seat before the seal, so the pay-record key is never committed. */
  it('a round open with no approval, as an account built before the raise counted shows it, is still approved before the seal', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label);
    const w = world({
      keys,
      standings: [standingOf({ open: true }), standingOf({ open: true }), standingOf({ open: true, approvals: 1 }),
        standingOf({ open: true, approvals: 1 }), standingOf({ committed: 'c1'.repeat(32), sealedMine: true })],
    });
    await runAll(finishCompanyAction(w.reach).steps(intentFor(label)), w.ctx);
    expect(w.relays.map((r) => r.label?.what)).toEqual(['pay-key-approve', 'pay-key-seal']);
    expect(w.asks.filter((a) => a['ask'] === 'governed-call').map((a) => (a['order'] as { circuit: string }).circuit)).toEqual(['approve', 'sealPayKey']);
  });

  /* RED WHEN: an action taken up again proves or sends again what the chain already shows done. */
  it('taken up again, goes on from what the chain shows: a round open and approved is only sealed', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label);
    const w = world({
      keys,
      standings: [standingOf({ open: true, approvals: 1 }), standingOf({ open: true, approvals: 1 }), standingOf({ open: true, approvals: 1 }),
        standingOf({ committed: 'c1'.repeat(32), sealedMine: true })],
    });
    await runAll(finishCompanyAction(w.reach).steps(intentFor(label)), w.ctx);
    expect(w.relays.map((r) => r.label?.what)).toEqual(['pay-key-seal']);
  });

  /* RED WHEN: a creation set aside (Start again) cannot be finished once its deploy turned up, or is finished still marked aside. */
  it('finishes a creation set aside, taking it up again in the saved keys first', async () => {
    const label = drawCompanyLabel();
    const { keys, creation } = await keptFor(label);
    const aside = { ...keys, creations: { [creation.accountId]: { ...keys.creations![creation.accountId]!, setAside: true as const } } };
    const w = world({
      keys: aside,
      standings: [standingOf({ open: true, approvals: 1 }), standingOf({ open: true, approvals: 1 }), standingOf({ open: true, approvals: 1 }),
        standingOf({ committed: 'c1'.repeat(32), sealedMine: true })],
    });
    const steps = finishCompanyAction(w.reach).steps(intentFor(label));
    await steps[0]!.run(w.ctx(1));
    expect(w.events[0]).toBe('keep');
    expect(w.keysNow().creations?.[creation.accountId]?.setAside).toBeUndefined();
    await runAll(steps, w.ctx, 1);
    expect(w.relays.map((r) => r.label?.what)).toEqual(['pay-key-seal']);
  });

  /* RED WHEN: a company this wallet did not start, or whose account it did not pin as one it created, is finished from a page's ask. */
  it('refuses, before anything is built, a label this wallet did not draw or pin as a company it created', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label);
    for (const record of [{ pinnedFor: () => null, drewTheLabel: () => false }, { pinnedFor: () => ({ account: ACCOUNT, created: false }) }]) {
      const w = world({ keys, record });
      const action = finishCompanyAction(w.reach);
      expect(await action.check(intentFor(label), w.ctx(1).held)).toEqual({ key: 'act.finish-company.why.not-drawn-here' });
      await expect(action.steps(intentFor(label))[0]!.run(w.ctx(1))).rejects.toBeInstanceOf(StepRefused);
      expect(w.relays).toEqual([]);
      expect(w.asks).toEqual([]);
    }
  });

  /* RED WHEN: a founding the saved keys keep for another seat than this wallet's words make is finished, which would commit the account to a pay-record key somebody else chose. */
  it('refuses a kept founding whose seat is not the one this wallet\'s words make', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label, {}, drawCompanyLabel());
    const w = world({ keys });
    await expect(finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1))).rejects.toMatchObject({ words: { key: 'act.finish-company.why.not-your-seat' } });
    expect(w.relays).toEqual([]);
  });

  /* RED WHEN: a pin this wallet holds for the company disagrees with the account its saved keys keep, and an account is built over it. */
  it('refuses when this wallet pinned the company to an account its saved keys do not keep', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label, { deploy: null, signed: null, recorded: false });
    const w = world({ keys });
    await expect(finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1))).rejects.toMatchObject({ words: { key: 'act.finish-company.why.pinned-without-deploy' } });
    expect(w.relays).toEqual([]);
  });

  /* RED WHEN: a company the saved keys keep nothing of is finished on the page's word. */
  it('refuses a company the saved keys keep no creation of', async () => {
    const label = drawCompanyLabel();
    const w = world({ keys: { accounts: {} } });
    await expect(finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1))).rejects.toMatchObject({ words: { key: 'act.finish-company.why.no-creation' } });
  });

  /* RED WHEN: an account committed to another pay-record key than the one the company was founded with is sealed for. */
  it('refuses to seal for an account committed to another pay-record key', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label);
    const w = world({ keys, standings: [standingOf({ committed: 'ee'.repeat(32), isThisKey: false })] });
    const steps = finishCompanyAction(w.reach).steps(intentFor(label));
    await steps[0]!.run(w.ctx(1));
    await steps[1]!.run(w.ctx(2));
    await expect(steps[2]!.run(w.ctx(3))).rejects.toMatchObject({ words: { key: 'act.finish-company.why.other-pay-record-key' } });
    expect(w.relays).toEqual([]);
  });

  /* RED WHEN: a deploy kept from a relay that was refused or answered late is handed over again at whatever age, so the service refuses it as too old on every press and the company can never be finished. */
  it('a kept deploy with less life left than the service needs is carried again on the next press, kept, and only then handed over: never the old one', async () => {
    const label = drawCompanyLabel();
    const { keys, creation } = await keptFor(label, { recorded: false });
    const w = world({ keys, held: false, ttl: { [DEPLOY]: Date.now() + 10 * MINUTE, [INSERT]: Date.now() + 10 * MINUTE } });
    await finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1));
    expect(w.asks.filter((a) => a['ask'] === 'creation-again')).toHaveLength(1);
    expect(w.relays).toEqual([{ tx: AGAIN, label: { what: 'creation-again', also: AGAIN_INSERT } }]);
    /* RED WHEN: what was carried again is handed over before it is kept, so a stop in between loses it. */
    expect(w.events).toEqual(['keep', `relay creation-again ${AGAIN}`, 'keep']);
    expect(w.keysNow().creations?.[creation.accountId]).toMatchObject({ deploy: { tx: AGAIN }, signed: { tx: AGAIN_INSERT }, recorded: true });
  });

  it('a kept deploy with life to spare is handed over as it was kept, and nothing is built again', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label, { recorded: false });
    const w = world({ keys, held: false });
    await finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1));
    expect(w.asks.filter((a) => a['ask'] === 'creation-again')).toEqual([]);
    expect(w.relays).toEqual([{ tx: DEPLOY, label: { what: 'creation', also: INSERT } }]);
  });

  /* RED WHEN: waiting for the account, a deploy is carried again only once it has run out for good, after the service has stopped taking it. */
  it('waiting for the account, a deploy under the service\'s margin is carried again before it runs out, and the second step sent is the one carried with it', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label);
    const w = world({ keys, held: [false, true], finished: [false, true], ttl: { [DEPLOY]: Date.now() + 10 * MINUTE, [INSERT]: Date.now() + 10 * MINUTE } });
    await finishCompanyAction(w.reach).steps(intentFor(label))[1]!.run(w.ctx(2));
    expect(w.relays).toEqual([
      { tx: AGAIN, label: { what: 'creation-again', also: AGAIN_INSERT } },
      { tx: AGAIN_INSERT, label: { what: 'creation-finish' } },
    ]);
  });

  /* RED WHEN: a time to live is built or judged by this device's clock alone, which may be wrong, rather than by the chain's clock the wallet reads. */
  it('builds and judges each time to live by the chain\'s clock, read from its own indexer, not by this device\'s', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label, { recorded: false });
    /* Twenty-five minutes left by this device's clock; five by the chain's, which is twenty minutes ahead. */
    const skew = 20 * MINUTE;
    const w = world({ keys, held: false, skew, ttl: { [DEPLOY]: Date.now() + 25 * MINUTE, [INSERT]: Date.now() + 25 * MINUTE } });
    await finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1));
    const again = w.asks.filter((a) => a['ask'] === 'creation-again');
    expect(again).toHaveLength(1);
    expect(Math.abs(Number(again[0]!['now']) - (Date.now() + skew))).toBeLessThan(5_000);
  });

  /* RED WHEN: a refused step, with this device's clock far from the chain's, does not say so and name the clock. */
  it('a step refused while this device\'s clock is far from the chain\'s says so, and names the clock', async () => {
    const label = drawCompanyLabel();
    const { keys } = await keptFor(label, { recorded: false });
    const ahead = world({ keys, held: false, skew: -20 * MINUTE, relayRefuses: true });
    await expect(finishCompanyAction(ahead.reach).steps(intentFor(label))[0]!.run(ahead.ctx(1)))
      .rejects.toMatchObject({ words: { key: 'act.finish-company.why.clock-ahead', values: { minutes: 20 } } });
    const behind = world({ keys, held: false, skew: 20 * MINUTE, relayRefuses: true });
    await expect(finishCompanyAction(behind.reach).steps(intentFor(label))[0]!.run(behind.ctx(1)))
      .rejects.toMatchObject({ words: { key: 'act.finish-company.why.clock-behind', values: { minutes: 20 } } });
    /* With the clocks together, the refusal is the page's own, and nothing is said about a clock. */
    const together = world({ keys, held: false, relayRefuses: true });
    const refused = await finishCompanyAction(together.reach).steps(intentFor(label))[0]!.run(together.ctx(1)).catch((e: unknown) => e);
    expect(refused).not.toBeInstanceOf(StepRefused);
  });

  /* RED WHEN: the window shows a line as the wallet's own read that only the page says, or lists no checks. */
  it('marks the label as the page\'s words before the passkey, what the action does as its own, and lists what it checks after it', async () => {
    const w = world({ keys: { accounts: {} } });
    const action = finishCompanyAction(w.reach);
    const shown = await action.shown(intentFor('co_x'));
    expect(shown.find((l) => l.key === 'act.finish-company.shown.company')?.from).toBe('page');
    /* RED WHEN: the check of the label is shown inside the line marked as only the page's words. */
    expect(shown.find((l) => l.key === 'act.finish-company.shown.company-check')?.from).toBe('action');
    /* RED WHEN: a line is marked as something this wallet read, when nothing is read before the passkey. */
    expect(shown.filter((l) => l.from === 'wallet')).toEqual([]);
    expect(shown.filter((l) => l.from === 'action').length).toBe(4);
    expect(action.checks.length).toBe(5);
  });
});

/*
 * THE HALF THAT BUILDS AND SIGNS THE ACCOUNT, against the compiled account and its keys on disk: the deploy is
 * built by the device's own builder from what the action asks, checked here against the account as this wallet
 * makes it, its second step signed with the company's committee key, both kept before either is handed over, and
 * the two applied in order to an empty ledger with every signature checked.
 */
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;
const KEYS = join(import.meta.dirname, '../../../../contracts/managed/keys');
const keyFile = (c: string) => new Uint8Array(readFileSync(join(KEYS, `${c}.verifier`)));
const fromHex = (h: string) => Uint8Array.from(h.match(/../gu)!, (x) => Number.parseInt(x, 16));
const fromB64 = (b: string) => new Uint8Array(Buffer.from(b, 'base64'));
const asB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

describe.skipIf(!ON_DISK)('THE ACCOUNT BUILT AND SIGNED IN THE WALLET [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  type Builder = { buildAccountDeploy: (d: unknown, i: unknown) => Promise<{ proven: Uint8Array; address: string }>;
    finishedCreation: (d: unknown, i: unknown) => Promise<{ proven: Uint8Array }> };
  let builder: Builder;
  beforeAll(async () => {
    setNetworkId(NETWORK as never);
    /* The device's own builder, loaded by a path this app's typecheck does not follow, as approve-creation.test.tsx does. */
    const at = '../../../../packages/web-shared/src/vault-builder.js';
    builder = (await import(/* @vite-ignore */ at)) as Builder;
  }, 120_000);

  const prove = async (tx: any) => tx.prove({
    check: async () => { throw new Error('asked to check'); }, prove: async () => { throw new Error('asked to prove'); }, lookupKey: async () => undefined,
  } as never, L.CostModel.initialCostModel());

  /* What the device's builder answers, built for real; `foundingKey` builds the deploy for another key than asked. */
  const realBuilds = (over: { foundingKey?: { tag: string; value: string } } = {}) => async (ask: Record<string, unknown>) => {
    const now = () => Number(ask['now']);
    if (ask['ask'] === 'account-deploy') {
      const b = await builder.buildAccountDeploy({
        ledger: L, runtimeState: (runtime as any).ContractState, contracts: contracts as any, network: NETWORK, prove, now,
        accountCompiled: CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(CompiledContract.withWitnesses(witnesses as never)),
        accountKeys: {
          getVerifierKey: async (c: string) => keyFile(c),
          getVerifierKeys: async (cs: readonly string[]) => cs.map((c) => [c, keyFile(c)] as [string, Uint8Array]),
        },
      }, { foundingLeaf: ask['foundingLeaf'], label: ask['label'], foundingKey: over.foundingKey ?? ask['foundingKey'] });
      return { id: 0, ok: true, ask: 'account-deploy', account: b.address, tx: asB64(b.proven) };
    }
    if (ask['ask'] === 'finished-creation') {
      const keys = new Map((ask['verifiers'] as Array<[string, string]>).map(([c, k]) => [c, fromB64(k)] as [string, Uint8Array]));
      const b = await builder.finishedCreation({ ledger: L, prove, network: NETWORK, now }, { account: ask['account'], keys, signature: ask['signature'] });
      return { id: 0, ok: true, ask: 'finished-creation', tx: asB64(b.proven) };
    }
    return undefined;
  };

  const realWorld = async (label: CompanyLabel, opts: { foundingKey?: { tag: string; value: string }; keepRefuses?: boolean } = {}) => {
    const { keys, creation } = await keptFor(label, { deploy: null, signed: null, recorded: false });
    const w = world({
      keys, held: false, builds: realBuilds(opts), ...(opts.keepRefuses === true ? { keepRefuses: true } : {}),
      record: { pinnedFor: () => null, drewTheLabel: (l) => l === label },
    });
    const expected = (accountModule as unknown as { expectedVk: Record<string, string> }).expectedVk;
    Object.assign(w.reach, {
      ledger: async () => L as unknown as CreationLedger,
      construction: liveConstruction,
      built: () => ({
        of: 'built',
        keys: {
          first: new Map(CREATION_STEPS.first.map((c) => [c, fromHex(expected[c]!)] as [string, Uint8Array])),
          second: new Map(CREATION_STEPS.second.map((c) => [c, fromHex(expected[c]!)] as [string, Uint8Array])),
        },
      }),
      verifiers: () => new Map([...CREATION_STEPS.first, ...CREATION_STEPS.second].map((c) => [c, keyFile(c)] as [string, Uint8Array])),
      network: NETWORK,
      labelIn: labelInAccountState,
    });
    return { w, creation };
  };

  const applied = (txs: readonly string[]) => {
    let state: any = L.LedgerState.blank(NETWORK);
    for (const b of txs) {
      const now = new Date();
      const t = BigInt(Math.floor(now.getTime() / 1000));
      const strict = new L.WellFormedStrictness();
      strict.enforceBalancing = false; strict.verifyNativeProofs = false; strict.verifyContractProofs = false; strict.enforceLimits = true; strict.verifySignatures = true;
      const tx = (L.Transaction.deserialize('signature', 'proof', 'pre-binding', fromB64(b)) as any).bind();
      const [next, r] = state.apply(tx.wellFormed(state, strict, now),
        new L.TransactionContext(state, { secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n }));
      if (r.type !== 'success') throw new Error(`the ledger refused it: ${String(r.error ?? r.type)}`);
      state = next;
    }
    return state;
  };

  it('builds the deploy and its second step from the seat this wallet makes, keeps both before handing them over, and the ledger takes them with the committee signature checked', async () => {
    const label = drawCompanyLabel();
    const { w, creation } = await realWorld(label);
    await finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1));
    expect(w.relays).toHaveLength(1);
    const [{ tx, label: what }] = w.relays as [{ tx: string; label: RelayLabel }];
    expect(what.what).toBe('creation');
    /* RED WHEN: either is handed over before it is kept, so a stop in between leaves a creation the wallet cannot carry on. */
    expect(w.events).toEqual(['keep', `relay creation ${tx}`, 'keep']);
    const kept = w.keysNow().creations?.[creation.accountId];
    expect(kept).toMatchObject({ deploy: { tx }, signed: { tx: what.also }, recorded: true });
    /* RED WHEN: the second step is signed with anything but the company's committee key over what this wallet built: the ledger refuses it. */
    const state = applied([tx, what.also!]);
    expect(state.index(kept!.deploy!.account)).toBeTruthy();
    expect(w.pinned).toEqual([kept!.deploy!.account]);
  }, 120_000);

  /*
   * The wallet's own account builder, run in this thread as its worker runs it: its code loads first (the contract's
   * code and the ledger, which takes the worker a moment), and only then does it listen. A message that reaches it
   * before it listens is lost, as a worker's is while its code is still loading.
   */
  const theWalletsBuilder = (): BuilderWorkerLike => {
    const builderHears: Array<(e: { data: unknown }) => void> = [];
    const walletHears: Array<(e: { data: unknown }) => void> = [];
    const deliver = (to: Array<(e: { data: unknown }) => void>, data: unknown) => {
      setTimeout(() => { for (const l of [...to]) l({ data: structuredClone(data) }); }, 0);
    };
    void (async () => {
      const deps = accountBuilderDeps();
      await deps();
      await new Promise((r) => setTimeout(r, 50));
      startAccountBuilder({ postMessage: (m) => deliver(walletHears, m), addEventListener: (_t, l) => { builderHears.push(l); } }, deps);
    })();
    return {
      postMessage: (m) => deliver(builderHears, m),
      addEventListener: (type: string, l: (e: never) => void) => { if (type === 'message') walletHears.push(l as never); },
      terminate: () => {},
    };
  };

  it('through the wallet\'s own account builder, the account is built from this build\'s keys and handed over, never waited on with nothing sent', async () => {
    const label = drawCompanyLabel();
    const { w } = await realWorld(label);
    Object.assign(w.reach, { build: accountBuilding(theWalletsBuilder) });
    const ran = finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1)).then(() => 'handed over', (e: unknown) => `refused: ${String((e as Error).message ?? e)}`);
    const said = await Promise.race([ran, new Promise<string>((r) => setTimeout(() => r('still waiting after 60 seconds, with nothing handed over'), 60_000))]);
    /* RED WHEN: the first ask reaches the builder before it listens and is lost, so the step waits for ever with nothing sent;
     * or the deploy is asked for with fewer verifier keys than the account is built from, so the builder refuses it. */
    expect(said).toBe('handed over');
    const [{ tx, label: what }] = w.relays as [{ tx: string; label: RelayLabel }];
    expect(what.what).toBe('creation');
    expect(applied([tx, what.also!]).index(w.keysNow().creations![Object.keys(w.keysNow().creations!)[0]!]!.deploy!.account)).toBeTruthy();
  }, 120_000);

  it('a deploy the builder answers for another founding key is refused as not the account this wallet makes, and nothing is kept or handed over', async () => {
    const label = drawCompanyLabel();
    const other = committeeKeyFor(identity, drawCompanyLabel());
    const { w } = await realWorld(label, { foundingKey: { tag: String(other.tag), value: String(other.value) } });
    /* RED WHEN: the account as made is not checked, so a deploy held by another key is signed for and sent. */
    await expect(finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1)))
      .rejects.toMatchObject({ words: { key: 'act.finish-company.why.deploy-not-as-made' } });
    expect(w.relays).toEqual([]);
    expect(w.events).toEqual([]);
  }, 120_000);

  it('a keep the page refuses hands nothing over', async () => {
    const label = drawCompanyLabel();
    const { w } = await realWorld(label, { keepRefuses: true });
    /* RED WHEN: a creation is handed over though it was not kept. */
    await expect(finishCompanyAction(w.reach).steps(intentFor(label))[0]!.run(w.ctx(1))).rejects.toThrow('keep-refused');
    expect(w.relays).toEqual([]);
  }, 120_000);
});
