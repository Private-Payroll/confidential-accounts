/**
 * **ONE CHANGE OF THE SUPER ADMINS, FROM A SUPER ADMIN'S DEVICE TO EVERY
 * CONTRACT OF THE COMPANY.** A super admin raises the change on their device, the
 * key it adds signs it with its own key, and each super admin's wallet signs every
 * contract's update at that contract's counter. The signatures travel through the
 * service's routes and by file; the account's update is sent first, and each
 * vault's only once the account reads current; the trace ends when every contract
 * reads the new committee from the chain.
 *
 * What is real: the device's raise, join, approval and finishing, the wallets'
 * own presses, the service's routes over real HTTP, the service's own assembly of
 * each update from the signatures, and the ledger's own update bytes and
 * signature check. The doubles are the edges only: the chain, which applies an
 * update the way the ledger does, and its indexer, which shows what landed one
 * block later. Neither side is given any way to read a signer, a seat or the
 * company's directory: every door they are handed lists what it has, and any
 * other read is recorded and refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as L from '@midnightntwrk/ledger-v9';
import { identityFromWords, newWords } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import {
  committeeJoinFor, committeeSignaturesFor, type ChainRead,
} from 'midnight-identity/profile/committee-sign';
import { parseAsk, REQUEST_SCHEMA, type CommitteeRequest, type SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  approveFromAFile, joinFromAFile, proposalFileRead, proposalFileText, raiseFromTheChain,
  type ProposalFile, type SuperAdminDoors, type SuperAdminSignature,
} from 'vaults-web-shared/governance-from-the-chain.js';
import { NothingWasSent } from '../core/jobs.js';
import { readProvenTransaction } from '../wiring/proven-submission.js';
import { companyVaultRoutes, type CompanyVaultDeps } from './company-vaults.js';
import { committeeChangeWith } from './vault-chain.js';

type Key = { tag: string; value: string };
interface Held { committee: Key[]; threshold: number; counter: bigint }

const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'a0'.repeat(32);
/** A vault the company holds at its old committee. */
const PAYROLL = 'b1'.repeat(32);
/** A vault already held by the committee the change installs. */
const RESERVE = 'b2'.repeat(32);
const COMPANY_ID = 'acc_1';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

const person = () => identityFromWords(newWords().join(' '));
const alice = person();
const bob = person();
const carol = person();
const keyOf = (who: ReturnType<typeof person>): Key => {
  const k = committeeKeyFor(who, LABEL) as unknown as Key;
  return { tag: k.tag, value: k.value.toLowerCase() };
};
const [A, B, C] = [alice, bob, carol].map(keyOf) as [Key, Key, Key];
/** Carol joins; Alice and Bob stay; two of the three must sign. */
const TARGET = { committee: [A, B, C], threshold: 2 };
const sameHeld = (h: Held, to: { committee: Key[]; threshold: number }) =>
  h.threshold === to.threshold && h.committee.length === to.committee.length
  && h.committee.every((k, i) => k.tag === to.committee[i]!.tag && k.value === to.committee[i]!.value);

/** Every read of something a door does not offer, by door and name. A super admin's side reads no signer, seat or directory. */
let reached: string[] = [];
/**
 * A door holding exactly what is listed in it. Anything else asked of it is
 * recorded and refused, so a read of a signer, a seat, a threshold of the
 * signers' or the directory cannot pass unseen.
 */
function only<T extends object>(door: string, offered: T): T {
  return new Proxy(offered, {
    get(t, p, r) {
      if (typeof p === 'symbol' || p === 'then' || p === 'toJSON' || p in t) return Reflect.get(t, p, r);
      reached.push(`${door}.${p}`);
      throw new Error(`${door} offers no ${p}`);
    },
  });
}

/**
 * **THE CHAIN AND ITS INDEXER.** The chain takes a transaction the way the
 * ledger does. Before it is included, every maintenance update in it, in every
 * action of every intent, is checked against the contract as it stands: each
 * signature verifies under the key at the place it names on the committee
 * holding the contract now, over that update's own signed bytes as the
 * transaction carries them; places are strictly increasing, which also means
 * one per place; and they reach the committee's threshold. Any of these
 * failing refuses the transaction, and no fee is charged. Once included, each
 * update is applied at its counter: a counter other than the contract's own
 * applies nothing and the fee is charged all the same, which is what the
 * ledger does with a counter that moved. An applied update installs the
 * authority it carries, one counter on. Only a replacement of who holds the
 * contract is modelled; any other kind of update is refused by name. The
 * indexer every party reads shows what landed once a block passes.
 */
function theChain() {
  const onChain = new Map<string, Held>([
    [ACCOUNT, { committee: [A, B], threshold: 2, counter: 3n }],
    [PAYROLL, { committee: [A, B], threshold: 2, counter: 1n }],
    [RESERVE, { committee: [A, B, C], threshold: 2, counter: 0n }],
  ]);
  const copy = (h: Held): Held => ({ committee: h.committee.map((k) => ({ ...k })), threshold: h.threshold, counter: h.counter });
  let indexed = new Map([...onChain].map(([a, h]) => [a, copy(h)]));
  const vaults = [PAYROLL, RESERVE];
  const landed: Array<{ address: string; counter: bigint }> = [];
  /** Updates included and charged for that applied nothing, because their counter was not the contract's. */
  const charged: Array<{ address: string; counter: bigint }> = [];
  return {
    onChain, landed, charged,
    indexed: (address: string) => indexed.get(address),
    /** A block passes, and the indexer shows everything that landed. */
    block: () => { indexed = new Map([...onChain].map(([a, h]) => [a, copy(h)])); },
    vaults,
    take(tx: unknown): void {
      const refuse = (why: string): never => { throw new NothingWasSent(`the chain refused it: ${why}`); };
      const updates = updatesIn(tx);
      if (updates.length === 0) refuse('it carries no maintenance update');
      for (const u of updates) {
        const held = onChain.get(u.address);
        if (held === undefined) refuse(`no contract at ${u.address}`);
        let last = -1;
        for (const [at, signature] of u.signatures) {
          const i = Number(at);
          if (i <= last) refuse(`the signatures' places are not strictly increasing (${last} then ${i})`);
          last = i;
          const key = held!.committee[i];
          if (key === undefined) refuse(`no place ${i} on the committee holding it`);
          if (!L.verifySignature(key as never, u.dataToSign, signature as never)) refuse(`the signature at place ${i} does not verify`);
        }
        if (u.signatures.length < held!.threshold) refuse(`${u.signatures.length} of ${held!.threshold} signatures`);
      }
      for (const u of updates) {
        const held = onChain.get(u.address)!;
        if (u.counter !== held.counter) { charged.push({ address: u.address, counter: u.counter }); continue; }
        const to = u.installs[u.installs.length - 1]!;
        if (to.counter !== held.counter + 1n) { charged.push({ address: u.address, counter: u.counter }); continue; }
        onChain.set(u.address, {
          committee: to.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: to.threshold, counter: held.counter + 1n,
        });
        landed.push({ address: u.address, counter: held.counter });
      }
    },
  };
}
type Chain = ReturnType<typeof theChain>;

/**
 * Every maintenance update a transaction carries, in every action of every
 * intent, with the bytes its signatures are over as the transaction's own
 * update gives them. An action that is not a maintenance update, or an update
 * that does not replace who holds the contract, is refused by name.
 */
function updatesIn(tx: unknown) {
  const intents = (tx as { intents?: Map<number, { actions: unknown[] }> }).intents;
  if (!(intents instanceof Map)) throw new NothingWasSent('the chain refused it: it carries no intent');
  return [...intents.values()].flatMap((intent) => intent.actions.map((action) => {
    const u = action as {
      address?: string; counter?: bigint; signatures?: ReadonlyArray<[bigint | number, Key]>; dataToSign?: Uint8Array; entryPoint?: unknown;
      updates?: Array<{ authority?: { committee: Key[]; threshold: number; counter: bigint } }>;
    };
    if (u.entryPoint !== undefined || !Array.isArray(u.updates) || !(u.dataToSign instanceof Uint8Array) || u.signatures === undefined) {
      throw new NothingWasSent('the chain refused it: this chain takes maintenance updates only');
    }
    const installs = u.updates.map((x) => {
      if (x.authority === undefined) throw new NothingWasSent('the chain refused it: this chain applies a replacement of who holds a contract only');
      return { committee: x.authority.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: x.authority.threshold, counter: x.authority.counter };
    });
    if (installs.length === 0) throw new NothingWasSent('the chain refused it: an update that changes nothing');
    return { address: String(u.address).toLowerCase(), counter: u.counter!, signatures: u.signatures, dataToSign: u.dataToSign, installs };
  }));
}

/** A contract's state as the indexer serves it: who holds it, and, for the account, the vaults it lists - and nothing of its signers. */
const stateAt = (chain: Chain, address: string) => {
  const h = chain.indexed(address);
  if (h === undefined) return null;
  const data = address === ACCOUNT
    ? only('the account as a super admin reads it', { vaults: chain.vaults.map(bytes), retiredAt: [] as Array<[Uint8Array, bigint]> })
    : only('a vault as a super admin reads it', {});
  return { maintenanceAuthority: { committee: h.committee.map((k) => ({ ...k })), threshold: h.threshold, counter: h.counter }, data };
};

/** The chain as a person's own wallet reads it at its indexer: every vault pinned to the company's account. */
const walletReads = (chain: Chain): ChainRead => new Map([ACCOUNT, PAYROLL, RESERVE].map((address) => {
  const h = chain.indexed(address)!;
  return [address, {
    of: 'read' as const, committee: h.committee, threshold: h.threshold, counter: h.counter,
    pinnedTo: address === ACCOUNT ? null : ACCOUNT, ...(address === ACCOUNT ? { vaults: chain.vaults } : {}),
  }];
}));

const askOf = (fields: Record<string, unknown>): CommitteeRequest => parseAsk({
  schema: REQUEST_SCHEMA, kind: 'committee', requester: { name: 'payroll', rdns: 'example.payroll' }, purpose: 'Change the super admins.',
  nonce: 'n', expiresAt: Date.now() + 60_000, ...fields,
}, 'https://pay.example', Date.now()) as CommitteeRequest;

/** A person's own wallet: its key for the company, its one press over every contract's update, and a joining key's own signature. */
const walletOf = (chain: Chain, who: ReturnType<typeof person>): SuperAdminDoors['wallet'] => only('the wallet', {
  key: async () => keyOf(who),
  signUpdates: async (ask: Parameters<SuperAdminDoors['wallet']['signUpdates']>[0]) => {
    const request = askOf({
      company: ask.company, account: ask.account, change: ask.change, salt: ask.salt, changeBytes: hex(ask.bytes),
      joined: ask.joined, contracts: ask.contracts,
    });
    const signed = committeeSignaturesFor(L as never, who, request, walletReads(chain), Date.now());
    return { signer: signed.signer as Key, signatures: signed.signatures };
  },
  signJoin: async (ask: Parameters<SuperAdminDoors['wallet']['signJoin']>[0]) => {
    const request = askOf({ company: ask.company, account: ask.account, change: ask.change, salt: ask.salt, changeBytes: hex(ask.bytes), joining: true });
    const signed = committeeJoinFor(L as never, who, request, walletReads(chain), Date.now());
    return { signer: signed.signer as Key, signature: signed.signature };
  },
});

let server: ReturnType<express.Express['listen']>;
let base = '';
let chain: Chain;
/** Every update a device asked the service to send, and whether the account read current at the indexer when it asked. */
let asked: Array<{ address: string; accountReadCurrent: boolean }> = [];

const call = async (path: string, method: 'GET' | 'POST', body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error));
  return json;
};

/** Whether the account reads, at the indexer, the committee the change installs past the counter it was raised at. */
const accountReadsCurrent = (raisedAt: bigint) => {
  const h = chain.indexed(ACCOUNT)!;
  return sameHeld(h, TARGET) && h.counter > raisedAt;
};

/** The company's service, as a device reaches it: its send and its signatures handed back, over its own routes. */
const serviceDoor = (raisedAt: () => bigint): NonNullable<SuperAdminDoors['service']> => only('the service', {
  send: async (update: Parameters<NonNullable<SuperAdminDoors['service']>['send']>[0]) => {
    asked.push({ address: update.address, accountReadCurrent: accountReadsCurrent(raisedAt()) });
    return call(`/api/accounts/${COMPANY_ID}/committee-change/send`, 'POST', update);
  },
  collected: async () => ((await call(`/api/accounts/${COMPANY_ID}/committee-change/signatures`, 'GET')).signatures as SuperAdminSignature[]),
});

/** A super admin's device: their wallet, the chain at their wallet's indexer, the service. No seat, no records, no directory. */
const deviceOf = (who: ReturnType<typeof person>, raisedAt: () => bigint): SuperAdminDoors => only('a super admin\'s device', {
  readers: only('the readers', {
    runtimeState: { deserialize: (b: Uint8Array) => stateAt(chain, hex(b)) },
    accountLedger: (data: unknown) => data,
  }),
  chain: only('the indexer', { contractState: async (address: string) => (chain.indexed(address) === undefined ? null : { serialize: () => bytes(address) }) }),
  ledger: L as unknown as SuperAdminDoors['ledger'],
  createdByTheCompany: [],
  seats: [],
  wallet: walletOf(chain, who),
  service: serviceDoor(raisedAt),
  /* Each wait for the chain is a block passing, so the indexer shows what landed in it. */
  watch: { everyMs: 1, withinMs: 3, sleep: async () => { chain.block(); } },
  random: (n: number) => new Uint8Array(n).fill(7),
});

beforeEach(async () => {
  reached = [];
  asked = [];
  chain = theChain();
  const kept = new Map<string, Parameters<CompanyVaultDeps['store']['putCommitteeSignatures']>[0]>();
  const deps = only('the service\'s doors', {
    signedIn: ((_req, _res, next) => next()) as express.RequestHandler,
    member: ((_req, _res, next) => next()) as express.RequestHandler,
    store: only('the service\'s store', {
      getAccount: (id: string) => (id === COMPANY_ID ? only('the company as the service keeps it', { id: COMPANY_ID }) : null),
      getCommitteeSignatures: (accountId: string, address: string) => kept.get(`${accountId}/${address}`) ?? null,
      putCommitteeSignatures: (c: Parameters<CompanyVaultDeps['store']['putCommitteeSignatures']>[0]) => { kept.set(`${c.accountId}/${c.address}`, c); },
      listCommitteeSignatures: (accountId: string) => [...kept.values()].filter((c) => c.accountId === accountId),
    }),
    company: async (id: string) => (id === COMPANY_ID ? only('the company on the chain', { address: ACCOUNT }) : null),
    ledger: only('the chain\'s door', {
      sendVault: async (_id: string, _what: string, _arrival: unknown, proven: Uint8Array,
        check: (tx: unknown) => string | null | Promise<string | null>, read: (b: Uint8Array) => Promise<unknown>) => {
        const tx = await read(proven);
        const why = await check(tx);
        if (why !== null) throw new NothingWasSent(why);
        chain.take(tx);
        return { ref: `tx-${chain.landed.length}`, at: new Date().toISOString() };
      },
    }),
    chain: only('the indexer', {
      contractState: async (address: string) => stateAt(chain, address.toLowerCase()),
      accountVaults: async (account: string) => (account.toLowerCase() === ACCOUNT ? chain.vaults : []),
    }),
    readers: only('the readers', { proven: readProvenTransaction }),
    committeeChange: committeeChangeWith('undeployed'),
    now: undefined,
  }) as unknown as CompanyVaultDeps;
  const app = express();
  app.use(companyVaultRoutes(deps));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });

/** Every contract of the company, with the counter the chain holds it at before the change. */
const BEFORE: ReadonlyArray<readonly [string, bigint]> = [[ACCOUNT, 3n], [PAYROLL, 1n], [RESERVE, 0n]];

/**
 * Alice raises the change, Carol signs it with her own key, and Bob's one
 * press signs every contract's update: his signatures for the account and the
 * payroll vault go to the service, the reserve's stays in the file handed back
 * to Alice. Bob holds the second place on every committee, so the service is
 * handed a signature at a higher place before Alice's device adds the lower
 * one, and the chain still takes only places in increasing order. Returns
 * that file, and the counter the account was raised at.
 */
async function raisedJoinedAndSignedByBob(): Promise<{ toAlice: ProposalFile; raisedAt: { at: bigint } }> {
  const raisedAt = { at: -1n };
  const at = () => raisedAt.at;
  const raised = await raiseFromTheChain(deviceOf(alice, at), {
    change: { kind: 'super-admins', committee: TARGET.committee, threshold: TARGET.threshold }, company: LABEL, account: ACCOUNT,
    summary: 'Carol joins the super admins',
  });
  const change = raised.file.change as SuperAdminChangeOnTheWire;
  raisedAt.at = BigInt(change.contracts[0]!.counter);
  if (raised.joining.length !== 1 || raised.joining[0]!.value !== C.value) throw new Error('the change was raised with other joining keys than Carol\'s');
  const joined = await joinFromAFile(deviceOf(carol, at), proposalFileRead(proposalFileText(raised.file)));
  const byBob = await approveFromAFile(deviceOf(bob, at), joined);
  if (!byBob.asked || chain.landed.length !== 0) throw new Error('Bob\'s wallet was not asked, or something was sent on one signature of two');
  const his = byBob.file.signatures!;
  const kept = await call(`/api/accounts/${COMPANY_ID}/committee-change/signatures`, 'POST', {
    to: TARGET, signatures: his.filter((s) => s.address !== RESERVE).map((s) => ({ address: s.address, counter: s.counter, index: s.index, signature: s.signature })),
  });
  if ((kept.results as Array<{ state: string }>).some((r) => r.state !== 'kept')) throw new Error(`the service did not keep Bob's signatures: ${JSON.stringify(kept.results)}`);
  return { toAlice: proposalFileRead(proposalFileText({ ...joined, signatures: his.filter((s) => s.address === RESERVE) })), raisedAt };
}

describe('ONE CHANGE OF THE SUPER ADMINS, FROM A SUPER ADMIN\'S DEVICE TO EVERY CONTRACT', () => {
  it('a change raised on a super admin\'s device lands on the account and then on every vault, the one already at the new committee too', async () => {
    const { toAlice, raisedAt } = await raisedJoinedAndSignedByBob();
    /* Alice's press completes every contract, so her device sends: the account first, then each vault once the account reads current. */
    const byAlice = await approveFromAFile(deviceOf(alice, () => raisedAt.at), toAlice);
    /* RED WHEN: a vault's update is asked for before the account reads the new committee at the indexer. */
    expect.soft(asked.map((x) => [x.address, x.address === ACCOUNT || x.accountReadCurrent])).toEqual([[ACCOUNT, true], [PAYROLL, true], [RESERVE, true]]);
    chain.block();
    /*
     * RED WHEN: a vault is left out of the change, or a joining key's signature
     * is dropped on the way to the chain: some contract does not end on the new
     * committee one counter past where it stood.
     */
    for (const [address, counter] of BEFORE) {
      const h = chain.onChain.get(address)!;
      expect.soft([address, sameHeld(h, TARGET), h.counter]).toEqual([address, true, counter + 1n]);
      expect.soft([address, sameHeld(chain.indexed(address)!, TARGET)]).toEqual([address, true]);
    }
    expect.soft(chain.landed.map((x) => x.address)).toEqual([ACCOUNT, PAYROLL, RESERVE]);
    expect.soft(byAlice.done).toBe(true);
    /* RED WHEN: anything in the trace reads a signer, a seat, the signers' thresholds or the directory. */
    expect.soft(reached).toEqual([]);
  });

  it('a vault\'s update asked for before the account reads the new committee is refused by the service and lands nowhere', async () => {
    const { toAlice } = await raisedJoinedAndSignedByBob();
    /* Alice's wallet signs, and her device is kept from sending, so the vault can be asked for first. */
    const signed = await approveFromAFile({ ...deviceOf(alice, () => 3n), service: undefined }, toAlice);
    const change = signed.file.change as SuperAdminChangeOnTheWire;
    const forPayroll = signed.file.signatures!.filter((s) => s.address === PAYROLL).sort((a, b) => a.index - b.index)
      .map((s) => ({ index: s.index, signature: s.signature }));
    const early = call(`/api/accounts/${COMPANY_ID}/committee-change/send`, 'POST', {
      address: PAYROLL, counter: '1', to: TARGET, signatures: forPayroll,
      change: { company: LABEL, salt: signed.file.salt, change, joined: signed.file.joined },
    });
    /* RED WHEN: the service sends a vault's update while the account does not yet read the committee the change installs. */
    await expect.soft(early).rejects.toThrow(/account does not yet hold this committee/);
    expect.soft(chain.landed).toEqual([]);
    /* RED WHEN: the service reads a signer, a seat, the signers' thresholds or the directory to judge the request. */
    expect.soft(reached).toEqual([]);
  });
});
