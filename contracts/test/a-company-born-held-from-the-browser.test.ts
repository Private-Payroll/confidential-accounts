/**
 * **A COMPANY'S ACCOUNT, CREATED FROM ITS FOUNDING SIGNER'S BROWSER, HELD BY
 * THEIR OWN COMMITTEE KEY FROM ITS FIRST TRANSACTION.**
 *
 * Driven with the pieces the product runs: the device's builder makes the
 * deploy, the founding signer's wallet reads that deploy itself and signs the
 * second step, the device puts the signature on the same update and both are
 * applied, in order, to an empty ledger in memory with every signature checked.
 * Nothing is proved against a circuit (a deploy and a maintenance update have
 * none) and nothing is sent anywhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { creationShown, creationSignatureFor } from 'midnight-identity/profile/creation-sign';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk, type CreationRequest, type KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import { buildAccountDeploy, finishedCreation } from '../../packages/web-shared/src/vault-builder.js';
import * as keyring from '../../packages/web-shared/src/keyring.js';
import { answerVaultAsk } from '../../packages/web-shared/src/vault-worker-entry.js';
import type { Openable } from '../../packages/web-shared/src/wallet-sign-in.js';
import { labelInAccountState } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { CREATION_STEPS, DEPLOYED_CIRCUITS, PER_TRANSACTION_CEILING } from '../../src/midnight/deferral.js';
import { keysOnDisk, ACCOUNT_KEYS } from './keys-on-disk.js';
import {
  accountBuilderDeps, accountKeyFile as keyFile, anAccountBornHeld, creationAskOf, digest, thisBuilds,
} from './an-account-born-held.js';

const NET = 'undeployed';
const NOW = new Date();
const seconds = BigInt(Math.floor(NOW.getTime() / 1000));
const LABEL = `co_${'5a'.repeat(32)}` as CompanyLabel;
const LEAF = '7c'.repeat(32);
const ON_DISK = keysOnDisk([ACCOUNT_KEYS]).ok;

const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false; s.enforceLimits = true; s.verifySignatures = true;
  return s;
};
const blockContext = { secondsSinceEpoch: seconds, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n };
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const founder = identityFromWords(TEST_MNEMONIC);
const foundingKey = committeeKeyFor(founder, LABEL);
const deps = () => accountBuilderDeps(NET);
const askOf = (deploy: Uint8Array, address: string, over: Record<string, unknown> = {}) =>
  creationAskOf(LABEL, deploy, address, NOW.getTime(), over);

describe.skipIf(!ON_DISK)('A COMPANY BORN HELD [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  const create = () => anAccountBornHeld({ network: NET, founder, label: LABEL, foundingLeaf: LEAF, now: NOW.getTime() });
  const apply = (state: any, bytes: Uint8Array) => {
    const tx = (L.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes) as any).bind();
    const [next, result] = state.apply(tx.wellFormed(state, strictness(), NOW), new L.TransactionContext(state, blockContext));
    return { next, result };
  };

  it('THE LEDGER TAKES THE DEPLOY HELD BY THE FOUNDING SIGNER\'S OWN KEY, AND THE INSERT THAT KEY ALONE SIGNED', async () => {
    const { deploy, answer, insert } = await create();
    /* The wallet worked the address out from the deploy, and it is the one the device computed. */
    expect(answer.account).toBe(deploy.address);
    let ledger: any = L.LedgerState.blank(NET);
    const first = apply(ledger, deploy.proven);
    expect(first.result.type).toBe('success');
    ledger = first.next;
    const held = ledger.index(deploy.address).maintenanceAuthority;
    /* RED WHEN the deploy is held by anything but the founding signer's committee key, at 1, never changed. */
    expect([[...held.committee].map((k: any) => k.value), held.threshold, held.counter]).toEqual([[foundingKey.value], 1, 0n]);
    const second = apply(ledger, insert.proven);
    expect(second.result.type).toBe('success');
    const done = second.next.index(deploy.address);
    /* RED WHEN the second step inserts less than the rest of the account, or a key other than this build's. */
    expect([...done.operations()].map(String).sort()).toEqual([...DEPLOYED_CIRCUITS].sort());
    for (const c of DEPLOYED_CIRCUITS) expect(Buffer.from(done.operation(c).verifierKey)).toEqual(Buffer.from(keyFile(c)));
    expect([[...done.maintenanceAuthority.committee].map((k: any) => k.value), done.maintenanceAuthority.counter]).toEqual([[foundingKey.value], 1n]);
    /* Each step fits one transaction, and what each writes is printed beside the result. */
    expect(deploy.bytesWritten).toBeLessThan(PER_TRANSACTION_CEILING);
    expect(insert.bytesWritten).toBeLessThan(PER_TRANSACTION_CEILING);
    console.log(`  MEASURED: deploy ${deploy.proven.length} bytes, ${deploy.bytesWritten} written; signed insert ${insert.proven.length} bytes, ${insert.bytesWritten} written; ceiling ${PER_TRANSACTION_CEILING}`);
  });

  it('AN INSERT SIGNED BY ANY OTHER KEY, OR FOR ANOTHER ACCOUNT, IS REFUSED BY THE LEDGER', async () => {
    const { deploy, answer } = await create();
    const ledger = apply(L.LedgerState.blank(NET), deploy.proven).next;
    const keys = new Map(CREATION_STEPS.second.map((c) => [c, keyFile(c)] as [string, Uint8Array]));
    const stranger = L.signData(L.sampleSigningKey(), new Uint8Array([1]));
    const forged = await finishedCreation(deps(), { account: deploy.address, keys, signature: stranger });
    /* RED WHEN a signature that is not the founding signer's lets the second step land. */
    expect(() => apply(ledger, forged.proven)).toThrow();
    const another = await buildAccountDeploy(deps(), { foundingLeaf: LEAF, label: LABEL, foundingKey });
    const ledger2 = apply(ledger, another.proven).next;
    const misdirected = await finishedCreation(deps(), { account: another.address, keys, signature: answer.signature });
    /* The signature covers the address: the same press does not finish a second account. */
    expect(() => apply(ledger2, misdirected.proven)).toThrow();
  });

  it('THE FOUNDING SIGNER\'S WALLET REFUSES A DEPLOY IT DID NOT DRAW, IS NOT HELD BY ITS KEY, OR RUNS ANOTHER BUILD\'S CIRCUITS', async () => {
    const d = deps();
    const good = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: LABEL, foundingKey });
    const shown = creationShown(L as never, founder, askOf(good.proven, good.address), thisBuilds(), digest, labelInAccountState);
    expect(shown).toMatchObject({ account: good.address, mine: foundingKey });
    const refused = (bytes: Uint8Array, address: string, over: Record<string, unknown> = {}, build = thisBuilds()) => {
      try {
        creationShown(L as never, founder, askOf(bytes, address, over), build, digest, labelInAccountState);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    /* RED WHEN the address the page names is taken rather than worked out from the deploy. */
    expect(refused(good.proven, 'ee'.repeat(32))).toMatch(/names an account the deploy it sent does not create/);
    /* RED WHEN a deploy held by another key is signed for. */
    const theirs = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: LABEL, foundingKey: L.signatureVerifyingKey(L.sampleSigningKey()) });
    expect(refused(theirs.proven, theirs.address)).toMatch(/not held by your own key/);
    /* RED WHEN a deploy carrying another label is signed for. */
    const other = `co_${'6b'.repeat(32)}`;
    const elsewhere = await buildAccountDeploy(d, { foundingLeaf: LEAF, label: other, foundingKey });
    expect(refused(elsewhere.proven, elsewhere.address)).toMatch(/not held by your own key|does not carry the label/);
    /* RED WHEN a first-step circuit that is not this build's is signed for. */
    const swappedFirst = { ...thisBuilds(), first: new Map([...thisBuilds().first].map(([c, h]) => [c, c === 'approve' ? new Uint8Array(32) : h] as [string, Uint8Array])) };
    expect(refused(good.proven, good.address, {}, swappedFirst)).toMatch(/circuits the deploy runs are not this build's/);
    /* RED WHEN a key the page asks to insert is not this build's. */
    const drained = CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(c === 'recordPaymentFromVault' ? keyFile('approve') : keyFile(c)) }));
    expect(refused(good.proven, good.address, { insert: drained })).toMatch(/keys the page asks to add are not this build's/);
    /* RED WHEN a key is left out, or one more is added: every key this build's, so only the set itself can refuse. */
    const honest = CREATION_STEPS.second.map((c) => ({ circuit: c, key: b64(keyFile(c)) }));
    expect(refused(good.proven, good.address, { insert: honest.slice(1) })).toMatch(/keys the page asks to add are not this build's/);
    expect(refused(good.proven, good.address, { insert: [...honest, { circuit: 'adopt', key: b64(keyFile('adopt')) }] }))
      .toMatch(/keys the page asks to add are not this build's/);
  });
});

/*
 * **A COMPANY BUILT AT THE FIRST PRESS AND SIGNED HOURS LATER, WITH THE DEVICE'S OWN BUILDER AND THE LEDGER'S OWN CHECKS.**
 *
 * The keyring is driven for real against the vault worker's own answers (`answerVaultAsk`, the code the page's worker
 * runs, with the account's keys read from disk), a wallet that signs with the real creation signature, and a chain
 * that applies what is sent with the ledger's own well-formedness and time-to-live checks and with every signature
 * checked. The tab's clock is the only thing moved. This is the fault a person met: the deploy built at the first
 * press and sent at the second, two hours on, which the node answers with `Custom error: 228`.
 */
const US = 'https://payroll.example';
const WALLET = 'https://wallet.example';
const ADDRESS = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const A_COMPANY = { name: 'Acme Ltd', signers: [{ name: 'Priya', role: 'admin' as const }], threshold: 1 };
const fromB64 = (b: string) => new Uint8Array(Buffer.from(b, 'base64'));

/** The wallet: the keyring ask answered as the real wallet answers it, the creation ask signed with the real signature. */
class Wallet implements Openable {
  readonly asks: string[] = [];
  private handler: ((event: MessageEvent) => void) | null = null;
  private readonly tab = { postMessage: (m: unknown) => this.onAsk(m) };
  open(): Window | null { return this.tab as unknown as Window; }
  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    queueMicrotask(() => this.deliver({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(): number { return 0; }
  clearTimeout(): void { /* nothing to clear */ }
  private deliver(data: unknown): void { this.handler?.({ origin: WALLET, source: this.tab, data } as unknown as MessageEvent); }
  private onAsk(message: unknown): void {
    const ask = parseAsk(message, US, Date.now());
    this.asks.push(ask.kind);
    const answer = ask.kind === 'keyring'
      ? keyringReleaseFor(founder, ask as KeyringRequest, Date.now(), (a) => a === ADDRESS)
      : creationSignatureFor(L as never, founder, ask as CreationRequest, Date.now(), thisBuilds(), digest, labelInAccountState);
    queueMicrotask(() => this.deliver(answer));
  }
}

/** The builder the keyring is given: the worker's own answers to the worker's own asks. */
const theWorker = () => {
  const built: { deploy: string[]; insert: string[]; again: Array<{ deploy: string; insert: string }> } = { deploy: [], insert: [], again: [] };
  const deps = async () => accountBuilderDeps(NET) as never;
  let id = 0;
  const ask = async (a: Record<string, unknown>): Promise<any> => {
    const r = await answerVaultAsk(deps, { id: ++id, network: NET, ...a } as never) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(String(r.error));
    return r;
  };
  const builder: keyring.AccountCreationBuilder = {
    foundingSeat: async (material) => { const a = await ask({ ask: 'founding-seat', material }); return { seat: a.seat, scope: a.scope, publicKey: a.publicKey }; },
    accountDeploy: async (input) => { const a = await ask({ ask: 'account-deploy', ...input }); built.deploy.push(a.tx); return { account: a.account, tx: a.tx, insert: a.insert }; },
    finishedCreation: async (input) => { const a = await ask({ ask: 'finished-creation', ...input }); built.insert.push(a.tx); return { tx: a.tx }; },
    creationAgain: async (input) => {
      built.again.push(input);
      const a = await ask({ ask: 'creation-again', ...input });
      return { account: a.account, deploy: a.deploy, insert: a.insert };
    },
    payKeyStanding: async () => { throw new Error('not asked'); },
    governedCall: async () => { throw new Error('not asked'); },
  };
  return { builder, built };
};

/** The chain: an empty ledger, each transaction applied at the tab's clock with the ledger's own checks and its signatures verified. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(b64: string): void {
    const now = new Date(Date.now());
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const tx = (L.Transaction.deserialize('signature', 'proof', 'pre-binding', fromB64(b64)) as any).bind();
    const [next, r] = this.state.apply(tx.wellFormed(this.state, strictness(), now),
      new L.TransactionContext(this.state, { secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n }));
    if (r.type !== 'success') throw new Error(`the chain refused it: ${String(r.error ?? r.type)}`);
    this.state = next;
  }
}

/** The moment a transaction stops being accepted, read from the transaction itself. */
const diesAt = (b64: string): number => {
  const tx = L.Transaction.deserialize('signature', 'proof', 'pre-binding', fromB64(b64)) as any;
  const intents = [...(tx.intents as Map<unknown, { ttl: Date }>).values()];
  expect(intents).toHaveLength(1);
  return intents[0]!.ttl.getTime();
};

/** The service's routes the two presses meet, answering as it does when it holds nothing for the company. */
function aService() {
  const posted: Array<{ route: string; body: any }> = [];
  let saved: { bundle: unknown; version: number } = { bundle: null, version: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = `${String(init?.method ?? 'GET')} ${url}`.replace(/acc_[A-Za-z0-9_-]{12}/u, 'acc_X');
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    posted.push({ route, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b }) as Response;
    switch (route) {
      case 'GET /api/me/keys': return json(200, { keyBundle: saved.bundle, version: saved.version });
      case 'PUT /api/me/keys': saved = { bundle: body.keyBundle, version: saved.version + 1 }; return json(200, { version: saved.version });
      case 'POST /api/accounts': return json(201, { account: { id: body.founding.account.id }, state: 'made' });
      case 'POST /api/accounts/acc_X/creation': return json(201, { account: null, state: 'deploy-sent', txRef: 'tx' });
      default: return json(404, { error: `no route for ${route}` });
    }
  }) as typeof fetch;
  return { sent: (route: string) => posted.filter((p) => p.route === route) };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; keyring.forgetLocally(); vi.restoreAllMocks(); });

describe.skipIf(!ON_DISK)('A DEPLOY BUILT AT THE FIRST PRESS AND SENT TWO HOURS LATER [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  it('IS BUILT AGAIN BEFORE IT IS SENT: THE CHAIN REFUSES THE OLD ONE FOR ITS TIME TO LIVE AND TAKES THE NEW ONE WITH THE SAME SIGNATURE', async () => {
    const service = aService();
    keyring.signedInByAnotherScreen({ user: { id: 'usr_a', email: null, name: 'Priya' }, address: ADDRESS, created: true, session: {} });
    const wallet = new Wallet();
    const { builder, built } = theWorker();
    const pressOneAt = Date.now();
    const { accountId, account } = await keyring.startCompanyHeldFromTheStart(A_COMPANY, WALLET, builder, wallet, US);
    const old = built.deploy[0]!;
    /* The deploy built at the first press lives thirty minutes from there (the ledger keeps the time to the second). */
    expect(diesAt(old)).toBeGreaterThanOrEqual(pressOneAt + 30 * 60_000 - 1_000);
    expect(diesAt(old)).toBeLessThan(pressOneAt + 31 * 60_000);

    /* Two hours on, the second press. */
    const twoHoursOn = pressOneAt + 2 * 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(twoHoursOn);
    /* The control: the chain itself refuses what was built at the first press, with the ledger's own words. */
    expect(() => new Chain().apply(old)).toThrow(/TTL has expired/);

    const done = await keyring.signCompanyCreationFromTheWallet(accountId, WALLET, builder, wallet, US);
    expect(done).toEqual({ accountId, account, state: 'deploy-sent', builtAgain: true });
    /* RED WHEN: the wallet is asked a second time for a ran-out step. */
    expect(wallet.asks.filter((k) => k === 'creation')).toHaveLength(1);
    /* RED WHEN: the step is not built again from the very deploy and the very second step that were kept. */
    expect(built.again).toEqual([{ deploy: old, insert: built.insert[0] }]);

    const sent = service.sent('POST /api/accounts/acc_X/creation');
    /* RED WHEN: the deploy built at the first press is what goes to the service. */
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.deploy).not.toBe(old);
    /* What goes has fifteen minutes of life at the very least, and more: thirty from the moment it was built again. */
    expect(diesAt(sent[0]!.body.deploy)).toBeGreaterThan(twoHoursOn + 15 * 60_000);
    expect(diesAt(sent[0]!.body.insert)).toBeGreaterThan(twoHoursOn + 15 * 60_000);

    /* The chain takes the deploy, then the second step: the wallet's signature, made over the old bytes, still verifies over the new. */
    const chain = new Chain();
    chain.apply(sent[0]!.body.deploy);
    chain.apply(sent[0]!.body.insert);
    expect(chain.state.index(account)).toBeTruthy();
  });
});
