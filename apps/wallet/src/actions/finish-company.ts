import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import { buildCreationInsert } from 'midnight-identity/profile/contract-keys';
import { creationShown, type CreationLedger } from 'midnight-identity/profile/creation-sign';
import { readCompanyLabel, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { CreationRequest } from 'midnight-identity/profile/request';
import type { RelayLabel } from 'midnight-identity/profile/channel';
import { NO_ASSET } from '../../../../src/core/assets.js';
import { toHex, unwrapKey, type Hex } from '../../../../src/core/crypto.js';
import { foundingStateRefusal, openStateRecord } from '../../../../src/core/founding-state.js';
import { CREATION_STEPS } from '../../../../src/midnight/deferral.js';
import { A_STEP_IS_BUILT_AGAIN_BELOW_MS } from '../../../../src/midnight/intent-lifetime.js';
import { withCreation, withoutCreation, type SavedCreation } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from '../../../../packages/web-shared/src/governed-call-builder.js';
import type { PayKeyStandingAnswered } from '../chain/account-builder.js';
import type { AccountBuilding } from '../chain/account-builder-client.js';
import type { CreationChain } from '../chain/creation-chain.js';
import type { ConstructionDeps } from '../chain/account-as-constructed.js';
import { startingStateRefusal } from '../chain/account-as-constructed.js';
import type { BuiltAccountKeys } from '../chain/this-builds-account-keys.js';
import { foundingSeatOf, type FoundingSeat } from '../keyring/founding-seat.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';

/**
 * **FINISH CREATING A COMPANY, AS ONE ACTION RUN WHOLE IN THIS WALLET.**
 *
 * The company was founded in this wallet: it drew the label, made the founding
 * seat from its words and kept what the company was founded with in the
 * person's saved keys (`keyring/found-company.ts`). This action takes it to the
 * end, in five steps, each working out from the chain where it stands:
 *
 *   1. the account's deploy and its second step, signed with the company's
 *      committee key, built here, kept in the saved keys, the account pinned
 *      as the company's, and both handed to the page together (`creation`);
 *   2. once the chain shows the account, its second step sent (`creation-finish`),
 *      and the chain read until every circuit is on it;
 *   in either step, a creation about to run out by the chain's clock is carried
 *      again and kept before it is handed over (`creation-again`);
 *   3. 4. 5. the account committed to the company's pay-record key: the proposal,
 *      the founding seat's approval, and the seat's sealed copy of the key, each
 *      proved here (`pay-key-propose`, `pay-key-approve`, `pay-key-seal`); then
 *      what was kept of the creation is dropped from the saved keys.
 *
 * What it reads, and from where: the label from the page's ask, checked against
 * this wallet's own record that it drew it (or pinned its account as one it
 * created); the founding from the saved keys this wallet opened, checked against
 * the seat this wallet makes again from its words; the chain from this wallet's
 * own indexer. What it trusts the page with: handing each transaction to the
 * service and keeping the saved keys it sealed again. A transaction the page
 * says it did not send stops the action at that step; taking the action up
 * again reads the chain and goes on from there.
 */

/** What the action builds and reads with. Each part is this wallet's own; a test hands in its own. */
export interface FinishCompanyReach {
  readonly build: AccountBuilding;
  readonly chain: CreationChain;
  readonly ledger: () => Promise<CreationLedger>;
  readonly construction: () => Promise<ConstructionDeps>;
  readonly built: () => BuiltAccountKeys;
  readonly verifiers: () => ReadonlyMap<string, Uint8Array> | null;
  readonly network: string;
  readonly labelIn: (serializedState: Uint8Array) => CompanyLabel | null;
  /** Waits `ms`, or rejects when `signal` aborts. */
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** A built transaction's time to live, in milliseconds, or null when it cannot be read. */
  readonly timeToLive: (tx: string) => Promise<number | null>;
}

/** How often the chain is read again while a step waits for what it sent to land. */
export const LOOK_AGAIN_MS = 5_000;

/** How far this device's clock may be from the chain's before a refused step names it. */
export const CLOCK_OFF_MS = 5 * 60_000;

/** The chain's clock as this wallet read it, and whether the account is on the chain. */
interface Clock {
  readonly held: boolean;
  readonly skew: number;
  now(): number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ZERO = '00'.repeat(32);
const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.finish-company.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string): never => { throw new StepRefused(why(key)); };
const b64 = (bytes: Uint8Array): string => base64.encode(bytes);
const randomHex32 = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)));

/** What one run of the action has found, checked once, and kept up to date as it keeps the saved keys. */
interface Found {
  readonly label: CompanyLabel;
  readonly seat: FoundingSeat;
  readonly payRecordKey: Hex;
  creation: SavedCreation;
}

export function finishCompanyAction(reach: FinishCompanyReach): ActionDefinition {
  const definition: ActionDefinition = {
    headline: 'act.finish-company.headline',
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.finish-company.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
      { key: 'act.finish-company.shown.company-check', from: 'action' },
      { key: 'act.finish-company.shown.what', from: 'action' },
      { key: 'act.finish-company.shown.transactions', from: 'action' },
      { key: 'act.finish-company.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.finish-company.check.drawn' },
      { key: 'act.finish-company.check.seat' },
      { key: 'act.finish-company.check.state' },
      { key: 'act.finish-company.check.deploy' },
      { key: 'act.finish-company.check.chain' },
    ],
    check: async (intent, held) => {
      const label = readCompanyLabel(intent.fields['company']);
      if (label === null) return why('not-a-label');
      if (held.wallet === undefined) return why('no-record');
      const pinned = held.wallet.pinnedFor(label);
      if (pinned === null ? !held.wallet.drewTheLabel(label) : !pinned.created) return why('not-drawn-here');
      return null;
    },
    steps: (intent) => stepsOf(reach, intent.fields['company'] ?? ''),
  };
  return Object.freeze(definition);
}

function stepsOf(reach: FinishCompanyReach, asked: string): readonly ActionStep[] {
  let found: Found | null = null;

  /* What every step stands on, worked out once per run from the saved keys and this wallet's words. */
  const prepared = async (ctx: StepContext): Promise<Found> => {
    if (found !== null) return found;
    const label = readCompanyLabel(asked) ?? refuse('not-a-label');
    const wallet = ctx.held.wallet ?? refuse('no-record');
    if (ctx.keyring === null) return refuse('no-saved-keys');
    const kept = ctx.keyring.open().read();
    /* A creation set aside (Start again, when its deploy had not landed) is taken up again by finishing it: the page
     * offers Finish for one only once the service shows its deploy landed, and every step reads the chain itself. */
    const active = Object.values(kept.creations ?? {}).find((c) => c.label === label && c.setAside !== true);
    const aside = active === undefined ? Object.values(kept.creations ?? {}).find((c) => c.label === label && c.setAside === true) : undefined;
    let creation: SavedCreation = active ?? (aside === undefined ? refuse('no-creation') : (() => {
      const { setAside: _taken, ...takenUp } = aside;
      return takenUp as SavedCreation;
    })());
    const pinned = wallet.pinnedFor(label);
    if (pinned === null ? !wallet.drewTheLabel(label) : !pinned.created) refuse('not-drawn-here');
    /* A pin with no deploy kept beside it, or a deploy for another account, is this wallet's record and the saved
     * keys disagreeing: nothing is built over it. */
    if (pinned !== null && (creation.deploy === null || creation.deploy.account !== pinned.account)) refuse('pinned-without-deploy');
    const seat = await foundingSeatOf(ctx.held.identity, label);
    const founding = creation.request.founding;
    if (String(creation.foundingKey.value).toLowerCase() !== seat.walletKey.value) refuse('not-your-key');
    if (founding.seat.signingPublicKey.toLowerCase() !== seat.signingPublicKey
      || founding.seat.wrappingPublicKey.toLowerCase() !== seat.wrappingPublicKey
      || founding.seat.leaf.toLowerCase() !== seat.leaf) refuse('not-your-seat');
    if (foundingStateRefusal(founding.state, creation.accountId, seat.signingPublicKey) !== null) refuse('state-not-signed');
    const wrapped = founding.account.wrappedKeys.find((w) => w.signerId === founding.seat.signerId) ?? refuse('state-not-signed');
    let payRecordKey: string;
    try {
      payRecordKey = String(openStateRecord(founding.state, unwrapKey(wrapped, seat.wrappingSecret) as Hex).blinding.payRecordKey ?? '');
    } catch {
      return refuse('state-not-signed');
    }
    if (!HEX64.test(payRecordKey)) refuse('no-pay-record-key');
    if (aside !== undefined) {
      const takenUp = creation;
      await ctx.keyring.keep((k) => withCreation(k, takenUp));
      creation = takenUp;
    }
    found = { label, seat, payRecordKey: payRecordKey as Hex, creation };
    return found;
  };

  const keep = async (ctx: StepContext, f: Found, next: SavedCreation): Promise<void> => {
    await ctx.keyring!.keep((k) => withCreation(k, next));
    f.creation = next;
  };

  const verifiersFor = (circuits: readonly string[]): Array<readonly [string, string]> => {
    const all = reach.verifiers() ?? refuse('not-built-with-keys');
    return circuits.map((c) => [c, b64(all.get(c) ?? refuse('not-built-with-keys'))] as const);
  };

  /*
   * THE CHAIN'S CLOCK, READ FROM THIS WALLET'S OWN INDEXER: the newest block's
   * time, carried forward by this device's clock since the read. Every time to
   * live is built and judged by it, never by this device's clock alone, which may
   * be wrong; how far the two differ is kept to say so if a step is refused.
   */
  const chainClock = async (account: string): Promise<Clock> => {
    const readAt = reach.now();
    const seen = await reach.chain.presence(account);
    const skew = seen.blockTime - readAt;
    return { held: seen.held, skew, now: () => reach.now() + skew };
  };

  /* Carried again, the same account in fresh transactions, kept before either is handed over. */
  const carriedAgain = async (ctx: StepContext, f: Found, clock: Clock): Promise<SavedCreation> => {
    const c = f.creation;
    const again = await reach.build({
      ask: 'creation-again', network: reach.network, deploy: c.deploy!.tx, insert: c.signed!.tx, now: clock.now(),
    });
    if (again.account.toLowerCase() !== c.deploy!.account) refuse('carried-elsewhere');
    const at = reach.now();
    const next: SavedCreation = {
      ...c, deploy: { ...c.deploy!, tx: again.deploy, builtAt: at }, signed: { ...c.signed!, tx: again.insert, builtAt: at },
    };
    await keep(ctx, f, next);
    return next;
  };

  /* The life a transaction has left by the chain's clock; one whose time to live cannot be read has none. */
  const lifeLeft = async (tx: string, clock: Clock): Promise<number> => {
    const ttl = await reach.timeToLive(tx);
    return ttl === null ? Number.NEGATIVE_INFINITY : ttl - clock.now();
  };

  /*
   * ONE RULE FOR HANDING OVER THE CREATION AGAIN, in either step: the life the
   * transactions still to land have left is read by the chain's clock first, and
   * under what the service needs to send them they are carried again (the same
   * account) and kept before either is handed over. So a relay refused or answered
   * late never leaves a deploy too old to send. `carried` says it was rebuilt.
   */
  const sendable = async (ctx: StepContext, f: Found, clock: Clock, which: 'both' | 'second'): Promise<{ c: SavedCreation; carried: boolean }> => {
    const c = f.creation;
    const left = which === 'both'
      ? Math.min(await lifeLeft(c.deploy!.tx, clock), await lifeLeft(c.signed!.tx, clock))
      : await lifeLeft(c.signed!.tx, clock);
    if (left >= A_STEP_IS_BUILT_AGAIN_BELOW_MS) return { c, carried: false };
    return { c: await carriedAgain(ctx, f, clock), carried: true };
  };

  const waitAWhile = (ctx: StepContext): Promise<void> => reach.pause(LOOK_AGAIN_MS, ctx.signal);

  /*
   * A relay the page did not take stops the action. When this device's clock and
   * the chain's are far apart, the window says so and names the clock: the steps
   * were built by the chain's clock, but a clock that is wrong is the first thing
   * to set right before pressing again.
   */
  const relay = async (ctx: StepContext, tx: string, label: RelayLabel, clock?: Clock): Promise<void> => {
    try {
      await ctx.relay(tx, label);
    } catch (e) {
      if (clock !== undefined && Math.abs(clock.skew) > CLOCK_OFF_MS) {
        throw new StepRefused(why(clock.skew > 0 ? 'clock-behind' : 'clock-ahead', { minutes: Math.round(Math.abs(clock.skew) / 60_000) }));
      }
      throw e;
    }
  };

  /* ---------------------------------------------------------------- 1. the account sent */
  const send: ActionStep = {
    title: { key: 'act.finish-company.step.send' },
    run: async (ctx) => {
      const f = await prepared(ctx);
      let c = f.creation;
      const wallet = ctx.held.wallet!;
      const clock = await chainClock(c.deploy?.account ?? ZERO);
      if (c.deploy !== null && c.signed !== null && clock.held) return;
      if (c.deploy === null || c.signed === null) {
        const built = reach.built();
        if (built.of !== 'built') refuse('not-built-with-keys');
        const keys = (built as Extract<BuiltAccountKeys, { of: 'built' }>).keys;
        const second = verifiersFor(CREATION_STEPS.second);
        const deploy = await reach.build({
          ask: 'account-deploy', network: reach.network, foundingLeaf: f.seat.leaf, label: f.label,
          foundingKey: f.seat.walletKey, verifiers: verifiersFor([...CREATION_STEPS.first, ...CREATION_STEPS.second]), now: clock.now(),
        });
        const insert = second.map(([circuit, key]) => ({ circuit, key }));
        const notAsMade = await startingStateRefusal(await reach.construction(), {
          deploy: deploy.tx, label: f.label, foundingKey: f.seat.walletKey, insert, build: keys, digest: sha256,
        });
        if (notAsMade !== null) refuse('deploy-not-as-made');
        const L = await reach.ledger();
        const shown = creationShown(L, ctx.held.identity, {
          company: f.label, account: deploy.account, deploy: deploy.tx, insert,
        } as unknown as CreationRequest, keys, sha256, reach.labelIn);
        const update = buildCreationInsert(L, {
          address: shown.account, counter: 0n, onChain: shown.deployed,
          keys: new Map(insert.map((k) => [k.circuit, base64.decode(k.key)] as [string, Uint8Array])),
          steps: { first: shown.deployed, second: shown.inserted },
        });
        const signed = L.signData(committeeSigningKeyFor(ctx.held.identity, f.label) as never, update.update.dataToSign);
        const signature = { tag: String(signed.tag), value: String(signed.value) };
        const finished = await reach.build({
          ask: 'finished-creation', network: reach.network, account: shown.account, signature, verifiers: second, now: clock.now(),
        });
        const at = reach.now();
        c = {
          ...c,
          deploy: { account: shown.account, tx: deploy.tx, insert, builtAt: at },
          signed: { tx: finished.tx, signature, builtAt: at },
          recorded: false,
        };
        await keep(ctx, f, c);
      }
      if (wallet.pinnedFor(f.label) === null) await wallet.pin(f.label, c.deploy!.account);
      if (!c.recorded) {
        const ready = await sendable(ctx, f, clock, 'both');
        await relay(ctx, ready.c.deploy!.tx, { what: ready.carried ? 'creation-again' : 'creation', also: ready.c.signed!.tx }, clock);
        await keep(ctx, f, { ...ready.c, recorded: true });
      }
    },
  };

  /* ---------------------------------------------------------------- 2. the account finished */
  const finish: ActionStep = {
    title: { key: 'act.finish-company.step.finish' },
    run: async (ctx) => {
      const f = await prepared(ctx);
      const account = f.creation.deploy?.account ?? refuse('not-sent');
      for (;;) {
        const clock = await chainClock(account);
        if (clock.held) break;
        const ready = await sendable(ctx, f, clock, 'both');
        if (ready.carried) await relay(ctx, ready.c.deploy!.tx, { what: 'creation-again', also: ready.c.signed!.tx }, clock);
        await waitAWhile(ctx);
      }
      let sent = false;
      for (;;) {
        const seen = await reach.chain.account(account);
        if (seen !== null && seen.finished) return;
        const clock = await chainClock(account);
        const ready = await sendable(ctx, f, clock, 'second');
        if (ready.carried) sent = false;
        if (!sent) {
          await relay(ctx, ready.c.signed!.tx, { what: 'creation-finish' }, clock);
          sent = true;
        }
        await waitAWhile(ctx);
      }
    },
  };

  /* ---------------------------------------------------------------- 3-5. the pay-record key */
  const standing = async (f: Found) => {
    const account = f.creation.deploy?.account ?? refuse('not-sent');
    const seen = await reach.chain.account(account) ?? refuse('not-on-the-chain');
    const chain = { accountState: b64(seen.state), parameters: b64(seen.parameters) };
    const read = await reach.build({
      ask: 'pay-key-standing', account, accountState: chain.accountState, key: f.payRecordKey,
      signingSecret: f.seat.signingSecret, wrappingPublicKey: f.seat.wrappingPublicKey,
    });
    if (read.standing.committed !== null && !read.standing.isThisKey) refuse('other-pay-record-key');
    return { account, chain, standing: read.standing };
  };
  const until = async (ctx: StepContext, f: Found, done: (s: PayKeyStandingAnswered) => boolean): Promise<void> => {
    for (;;) {
      if (done((await standing(f)).standing)) return;
      await waitAWhile(ctx);
    }
  };
  const call = async (f: Found, at: Awaited<ReturnType<typeof standing>>, order: GovernedCallOrder): Promise<string> => {
    const r = at.standing.round;
    const payKey = { kind: 'pay-key', commitment: r.commitment } as const;
    const opened: OpenedRound = {
      chainId: r.proposal, digest: r.payload, vault: at.standing.noVault, salt: r.salt,
      summary: 'Commit the company to its pay-record key', governance: payKey,
      half: { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: ZERO },
    } as OpenedRound;
    const material: SignerMaterial = { signingSecret: f.seat.signingSecret, blinding: f.seat.blinding, scope: f.seat.scope };
    const built = await reach.build({
      ask: 'governed-call', network: reach.network, account: at.account, order, material, chain: at.chain, opened,
    });
    return built.tx;
  };
  const payKeyOf = (r: PayKeyStandingAnswered['round']) => ({ kind: 'pay-key', commitment: r.commitment } as const);

  const propose: ActionStep = {
    title: { key: 'act.finish-company.step.propose' },
    run: async (ctx) => {
      const f = await prepared(ctx);
      const at = await standing(f);
      if (at.standing.committed !== null || at.standing.round.open) return;
      const r = at.standing.round;
      await relay(ctx, await call(f, at, {
        circuit: 'propose', payKey: payKeyOf(r),
        half: { assetId: NO_ASSET, assetBlinding: randomHex32(), proposalSalt: r.salt, changeAmount: '0', changeBatchDigest: ZERO },
        proposal: r.proposal,
      } as GovernedCallOrder), { what: 'pay-key-propose' });
      await until(ctx, f, (s) => s.round.open || s.committed !== null);
    },
  };

  const approve: ActionStep = {
    title: { key: 'act.finish-company.step.approve' },
    run: async (ctx) => {
      const f = await prepared(ctx);
      const at = await standing(f);
      const r = at.standing.round;
      if (at.standing.committed !== null || BigInt(r.approvals) >= BigInt(r.needed)) return;
      const before = BigInt(r.approvals);
      await relay(ctx, await call(f, at, {
        circuit: 'approve', proposal: r.proposal, of: { governance: payKeyOf(r), proposalSalt: r.salt },
      } as GovernedCallOrder), { what: 'pay-key-approve' });
      await until(ctx, f, (s) => BigInt(s.round.approvals) > before || s.committed !== null);
    },
  };

  const seal: ActionStep = {
    title: { key: 'act.finish-company.step.seal' },
    run: async (ctx) => {
      const f = await prepared(ctx);
      const at = await standing(f);
      if (!at.standing.sealedMine) {
        const r = at.standing.round;
        await relay(ctx, await call(f, at, {
          circuit: 'sealPayKey', wrap: at.standing.wrap, commitment: r.commitment, proposal: r.proposal, proposalSalt: r.salt,
        } as GovernedCallOrder), { what: 'pay-key-seal' });
        await until(ctx, f, (s) => s.sealedMine);
      }
      /* Finished: what was kept of the creation is no longer needed, and dropping it is the end of the action. */
      await ctx.keyring!.keep((k) => withoutCreation(k, f.creation.accountId));
    },
  };

  return [send, finish, propose, approve, seal];
}
