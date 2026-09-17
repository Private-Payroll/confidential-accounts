import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '@midnightntwrk/ledger-v9';
import {
  authorityView, buildAccountHandover, everySignerNeeded,
  type AccountHandoverLedger,
} from './company-authority.js';
import { readContractAuthority, replaceAuthorityOf, type AuthorityRead } from './ledger.js';
import { committeeReplacement, type Committee, type CommitteeKey } from './vault-committee.js';
import { readProvenTransaction } from '../wiring/proven-submission.js';
import { refusalForHandover, refusalToPutMoneyIn } from '../wiring/vault-submission.js';

/*
 * **THE ONE GATE, ASKED ABOUT THE ACCOUNT.** The vault half is handed a read
 * that passes, so every answer below is about the company's account. This
 * used to call `accountFundingRefusal`, which was a second implementation of
 * the same rule; it is now the function every door actually asks.
 */
const moneyIn = (
  accountRead: AuthorityRead, to: Committee, circuits: string | null, heldHere: CommitteeKey[] = [],
): string | null => refusalToPutMoneyIn({
  label: 'v',
  what: 'no money goes in',
  vault: {
    state: 'read',
    address: 'v',
    authority: {
      committee: to.committee.map((k) => ({ ...k })), threshold: to.threshold,
      counter: 1n, shape: 'committee', hasDuplicateMembers: false,
    },
  },
  vaultCircuits: null,
  pinnedAccount: 'acc',
  companyAccount: 'acc',
  account: accountRead,
  accountCircuits: circuits,
  committee: to,
  heldHere,
})?.why ?? null;


/*
 * The company's own authority: one refusal for every replacement this product
 * makes, and the company account handed from this service's temporary key to
 * its committee, watched against the ledger's own state machine. Nothing here
 * proves a circuit, contacts a chain or reads a compiled contract.
 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const NET = 'undeployed';
const be = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
const sk = (n: number) => L.signingKeyFromBip340(be(n));
const vk = (n: number) => L.signatureVerifyingKey(sk(n));
const sorted = (ks: { tag: string; value: string }[]) => [...ks].sort((a, b) => (a.value < b.value ? -1 : 1));
const Lh = L as unknown as AccountHandoverLedger;

const NOW = new Date();
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));
const ttl = () => new Date(NOW.getTime() + 30 * 60_000);
const blockContext = {
  secondsSinceEpoch: NOW_SECONDS, secondsSinceEpochErr: 30,
  parentBlockHash: '00'.repeat(32), lastBlockTime: NOW_SECONDS - 6n,
};
const strictness = () => {
  const s = new L.WellFormedStrictness();
  s.enforceBalancing = false; s.verifyNativeProofs = false;
  s.verifyContractProofs = false; s.enforceLimits = false; s.verifySignatures = true;
  return s;
};
const neverAsked = {
  check: async () => { throw new Error('asked to check a circuit'); },
  prove: async () => { throw new Error('asked to prove a circuit'); },
  lookupKey: async () => undefined,
};

/** A contract deployed into an in-memory ledger under one key, as the service deploys a company account. */
const deployedUnder = (committee: { tag: string; value: string }[], threshold: number) => {
  const cs = new L.ContractState();
  cs.maintenanceAuthority = new L.ContractMaintenanceAuthority(committee as never, threshold, 0n);
  const dep = new L.ContractDeploy(cs);
  let ls = L.LedgerState.blank(NET);
  const tx = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(ttl()).addDeploy(dep));
  [ls] = ls.apply(tx.wellFormed(ls, strictness(), NOW), new L.TransactionContext(ls, blockContext));
  return { ls, address: dep.address as string };
};
const readFrom = (ls: L.LedgerState, address: string): Promise<AuthorityRead> =>
  readContractAuthority(async (a) => ls.index(a as never) ?? null, address);

describe('ONE REFUSAL FOR EVERY REPLACEMENT OF A CONTRACT\'S RULES', () => {
  const P = L as never;
  const three = [vk(1), vk(2), vk(3)];
  const build = (committee: { tag: string; value: string }[], threshold: number, deliberate = false, counter = 0n) =>
    () => replaceAuthorityOf(P, { committee, threshold, updateCounter: counter, emptyCommitteeIsDeliberate: deliberate });

  it('REFUSES EVERY THRESHOLD ANYBODY COULD MEET WITH NO SIGNATURE, AND EVERY ONE NOBODY COULD EVER MEET', () => {
    /* RED WHEN: the `threshold-below-one` or `threshold-above-committee` branch of `authorityValueRefusals` is
     * removed, or `replaceAuthorityOf` stops calling it - each call below then returns an object. */
    expect(build(three, 0)).toThrow(/\[threshold-below-one\]/);
    expect(build(three, -1)).toThrow(/\[threshold-below-one\]/);
    expect(build(three, 1.5)).toThrow(/\[threshold-below-one\]/);
    expect(build(three, Number.NaN)).toThrow(/\[threshold-below-one\]/);
    expect(build(three, 4)).toThrow(/\[threshold-above-committee\]/);
  });

  it('REFUSES THE REMOVAL ROUTE: A MEMBER TAKEN OFF BELOW THE THRESHOLD, AND THE LAST ONE TAKEN OFF', () => {
    /* A committee of three at three with one member removed is the replacement [two] at three; with every member
     * removed it is [] - byte-identical to the deliberate choice that nobody may ever maintain the contract.
     * RED WHEN: `committee-emptied` or `threshold-above-committee` is removed. */
    expect(build(three.slice(0, 2), 3)).toThrow(/\[threshold-above-committee\]/);
    expect(build([], 1)).toThrow(/\[committee-emptied\]/);
    expect(build([], 0)).toThrow(/\[threshold-below-one\]/);
    expect(build([], 0, true)).toThrow(/\[threshold-below-one\]/);
    expect(build([], 1, true)).not.toThrow();
  });

  it('REFUSES A KEY LISTED TWICE, A MALFORMED KEY, AND A COUNTER THE CHAIN CANNOT HOLD', () => {
    /* RED WHEN: `repeated-committee-member` or `malformed-committee-key` is removed, or the counter check in
     * `replaceAuthorityOf` is. */
    expect(build([vk(1), vk(1)], 2)).toThrow(/\[repeated-committee-member\]/);
    expect(build([vk(1), { tag: 'schnorr', value: '' }], 1)).toThrow(/\[malformed-committee-key\]/);
    expect(build(three, 2, false, -1n)).toThrow(/whole number read off the chain/);
    const ok = build(three, 2, false, 4n)() as unknown as { authority: { threshold: number; counter: bigint } };
    expect(ok.authority.threshold).toBe(2);
    expect(ok.authority.counter).toBe(5n);
  });

  it('A VAULT\'S HANDOVER IS REFUSED BY THE SAME RULE, BEFORE ANY SIGNATURE IS POSSIBLE', () => {
    /* RED WHEN: `committeeReplacement` builds its own `ReplaceAuthority` again instead of `replaceAuthorityOf`
     * with `whyNoCommittee`'s value checks removed - a threshold of zero then reaches the ledger. */
    const vault = 'ab'.repeat(32);
    expect(() => committeeReplacement(P, { vault, counter: 0n, to: { committee: sorted(three), threshold: 0 } }))
      .toThrow(/threshold is 0/);
    expect(() => committeeReplacement(P, { vault, counter: 0n, to: { committee: sorted(three).slice(0, 2), threshold: 3 } }))
      .toThrow(/threshold is 3/);
  });

  it('NO SHIPPING FILE MAKES A REPLACEMENT OF A CONTRACT\'S RULES ANYWHERE BUT THE ONE PLACE', () => {
    /* RED WHEN: any file the product ships constructs `ReplaceAuthority` itself - reverting `committeeReplacement`
     * or `buildMaintenanceInstruction` to their own construction turns this count to two or more - or names the
     * class in code anywhere but the two files that declare its shape, which is how an alias would reach it.
     * WHAT IT CANNOT SEE: a name assembled at run time. It reads source text, and says so. */
    const roots = ['src', 'scripts', 'packages/identity/src', 'apps/wallet/src'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'lib' || name === 'dist') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|mjs|js)$/u.test(name) || /\.test\.(ts|tsx)$/u.test(name)) continue;
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(/new\s+[\w.]*\bReplaceAuthority\s*\(/gu)) {
          hits.push(`${path.slice(REPO.length)}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    };
    for (const r of roots) walk(join(REPO, r));
    const named: string[] = [];
    const sdk: string[] = [];
    const nameWalk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'lib' || name === 'dist') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { nameWalk(path); continue; }
        if (!/\.(ts|tsx|mjs|js)$/u.test(name) || /\.test\.(ts|tsx)$/u.test(name)) continue;
        /* Comments and plain string literals removed: a sentence that names the class is not code that reaches it. */
        const code = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')
          .replace(/'(?:[^'\\\n]|\\.)*'/gu, "''").replace(/"(?:[^"\\\n]|\\.)*"/gu, '""');
        if (/\bReplaceAuthority\b/u.test(code)) named.push(path.slice(REPO.length));
        /* The SDK's own replacement helpers install one key at threshold one and never pass the refusal. */
        if (/\b(submitReplaceAuthorityTx|replaceContractMaintenanceAuthority|createMaintenanceAuthority)\b/u.test(code)) {
          sdk.push(path.slice(REPO.length));
        }
      }
    };
    for (const r of roots) nameWalk(join(REPO, r));
    expect(named.sort()).toEqual(['src/midnight/ledger.ts', 'src/midnight/vault-committee.ts']);
    expect(sdk).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^src\/midnight\/ledger\.ts:/);
    const ledgerText = readFileSync(join(REPO, 'src/midnight/ledger.ts'), 'utf8');
    const at = Number(hits[0]!.split(':')[1]);
    const before = ledgerText.split('\n').slice(0, at).join('\n');
    expect(before.lastIndexOf('export function replaceAuthorityOf')).toBeGreaterThan(before.lastIndexOf('\nexport function '));
  });
});

describe('A COMPANY ACCOUNT HANDED FROM THE TEMPORARY KEY TO ITS COMMITTEE, ON THE LEDGER\'S OWN STATE MACHINE', () => {
  const temporary = sk(9);
  const committee = { committee: sorted([vk(1), vk(2)]), threshold: 2 };

  it('THE ACCOUNT CANNOT BE DEPLOYED HOLDING KEYS WORKED OUT FROM ITS OWN ADDRESS: THE ADDRESS DEPENDS ON THE AUTHORITY', () => {
    /* Why the account takes the same two steps as a vault. A committee key is derived from the company's address,
     * and the address is a hash over the deploy, authority included - measured here by changing only the
     * authority's key in a serialized deploy and reading the address back.
     * RED WHEN: the ledger stops hashing the authority into the address - `moved` is then false. */
    const cs = new L.ContractState();
    cs.maintenanceAuthority = new L.ContractMaintenanceAuthority([vk(1)], 1, 0n);
    const dep = new L.ContractDeploy(cs);
    const tx = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(ttl()).addDeploy(dep));
    const hex = Buffer.from(tx.serialize()).toString('hex');
    const at = hex.indexOf(vk(1).value);
    expect(at).toBeGreaterThan(0);
    const swapped = Buffer.from(hex.slice(0, at) + vk(2).value + hex.slice(at + vk(2).value.length), 'hex');
    const again = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', swapped);
    const deploy = [...again.intents!.values()][0]!.actions[0] as unknown as { address: string; initialState: L.ContractState };
    expect(deploy.initialState.maintenanceAuthority.committee).toEqual([vk(2)]);
    const moved = deploy.address !== dep.address;
    expect(moved).toBe(true);
    const control = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', tx.serialize());
    expect(([...control.intents!.values()][0]!.actions[0] as unknown as { address: string }).address).toBe(dep.address);
  });

  it('IS BUILT, SIGNED ONCE, READ BY THE SERVICE AS A STRANGER\'S, ACCEPTED BY THE LEDGER, AND READ BACK AS THE COMMITTEE', async () => {
    /* RED WHEN: `buildAccountHandover` signs at another seat, installs another value, or leaves the counter out -
     * the ledger then refuses it or the read-back disagrees; or when the service's reading of an account handover
     * refuses a correct one. */
    const { ls, address } = deployedUnder([L.signatureVerifyingKey(temporary)], 1);
    const before = await readFrom(ls, address);
    expect(before).toMatchObject({ state: 'read', authority: { shape: 'one-key', counter: 0n } });
    expect(moneyIn(before, committee, null, [L.signatureVerifyingKey(temporary)]))
      .toMatch(/still held by the temporary key/);

    const built = buildAccountHandover(Lh, { read: before, to: committee, temporaryKey: temporary, network: NET, ttl: ttl() });
    expect(built.endState).toMatchObject({ address, threshold: 2, builtAgainstCounter: 0n, expectedCounter: 1n });
    const proven = await (built.unproven as L.UnprovenTransaction).prove(neverAsked as never, L.CostModel.initialCostModel());
    const asTheServiceReadsIt = await readProvenTransaction(proven.serialize());
    if (before.state !== 'read') throw new Error('unreachable');
    expect(refusalForHandover(asTheServiceReadsIt, { vault: address, to: committee, onChain: before.authority, contract: 'account' })).toBeNull();
    expect(refusalForHandover(asTheServiceReadsIt, {
      vault: address, to: { ...committee, threshold: 1 }, onChain: before.authority, contract: 'account',
    })).toMatch(/not this company's committee/);
    /* RED WHEN: the account's branch of the first-change-only rule in `refusalForHandover` is skipped. */
    expect(refusalForHandover(asTheServiceReadsIt, {
      vault: address, to: committee, onChain: { ...before.authority, counter: 1n }, contract: 'account',
    })).toMatch(/company's account has already had its rules changed/);

    const bound = (asTheServiceReadsIt as L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>).bind();
    const [after] = ls.apply(bound.wellFormed(ls, strictness(), NOW), new L.TransactionContext(ls, blockContext));
    const now = await readFrom(after, address);
    expect(now).toMatchObject({ state: 'read', authority: { shape: 'committee', threshold: 2, counter: 1n } });
    expect(moneyIn(now, committee, null)).toBeNull();
    expect(moneyIn(now, committee, 'its circuits are not this build\'s')).toBe('its circuits are not this build\'s');
    expect(authorityView('account', now, committee, new Map([[`schnorr:${vk(1).value}`, 'ada']]))).toMatchObject({
      heldByTheCompany: true, seatsOutsideTheCommittee: 0, changes: '1',
    });

    /* And once is all: the same key cannot hand it over again, whoever asks. */
    expect(() => buildAccountHandover(Lh, { read: now, to: committee, temporaryKey: temporary, network: NET, ttl: ttl() }))
      .toThrow(/no longer held by one key/);
  });

  it('A HANDOVER TO A COMMITTEE ANYBODY COULD CHANGE IS REFUSED BEFORE IT IS SIGNED', async () => {
    /* RED WHEN: `buildAccountHandover` signs before the plan's refusal - `signed` is then true. */
    const { ls, address } = deployedUnder([L.signatureVerifyingKey(temporary)], 1);
    const read = await readFrom(ls, address);
    let signed = false;
    const spy = { ...Lh, signData: (k: never, d: Uint8Array) => { signed = true; return Lh.signData(k, d); } } as AccountHandoverLedger;
    expect(() => buildAccountHandover(spy, { read, to: { committee: committee.committee, threshold: 0 }, temporaryKey: temporary, network: NET, ttl: ttl() }))
      .toThrow(/threshold-below-one/);
    expect(() => buildAccountHandover(spy, { read, to: { committee: [], threshold: 1 }, temporaryKey: temporary, network: NET, ttl: ttl() }))
      .toThrow(/committee-emptied/);
    expect(signed).toBe(false);
  });

  it('IS REFUSED FOR AN ACCOUNT THE TEMPORARY KEY HAS ALREADY CHANGED, OR ONE ANOTHER KEY HOLDS', async () => {
    /* RED WHEN: the counter or key comparison at the top of `buildAccountHandover` is removed. */
    const { ls, address } = deployedUnder([L.signatureVerifyingKey(temporary)], 1);
    const read = await readFrom(ls, address);
    if (read.state !== 'read') throw new Error('unreachable');
    const changed: AuthorityRead = { ...read, authority: { ...read.authority, counter: 1n } };
    expect(() => buildAccountHandover(Lh, { read: changed, to: committee, temporaryKey: temporary, network: NET, ttl: ttl() }))
      .toThrow(/already had its rules changed/);
    expect(() => buildAccountHandover(Lh, { read, to: committee, temporaryKey: sk(8), network: NET, ttl: ttl() }))
      .toThrow(/a key this service does not keep/);
    expect(() => buildAccountHandover(Lh, { read: { state: 'unreachable', address, why: 'down' }, to: committee, temporaryKey: temporary, network: NET, ttl: ttl() }))
      .toThrow(/could not be asked/);
  });
});

describe('A SIGNER WHO LOST THEIR DEVICES AND KEPT THEIR RECOVERY PIECES', () => {
  it('GETS THE SAME COMMITTEE KEY BACK, THROUGH THE WALLET\'S OWN RECOVERY', async () => {
    /* RED WHEN: the committee key stops being a function of the recovered secret alone - `after` then differs -
     * or the recovery returns something other than the secret. */
    const id = await import('midnight-identity');
    const { committeeKeyFor } = await import('midnight-identity/profile/committee-key');
    const company = 'c0'.repeat(32);
    const secret = id.newSecret();
    const before = committeeKeyFor(id.identityFromSecret(secret), company);
    const set = await id.splitSecret(secret, [
      { label: 'Google', holder: 'google:a' }, { label: 'Paper', holder: 'paper' }, { label: 'Laptop', holder: 'device:l' },
    ], 2);
    let session = id.startRecovery({ id: 'r', threshold: set.threshold, now: 0 });
    session = id.offerPiece(session, { holder: 'paper', bytes: set.pieces[1]!.bytes }, 1);
    session = id.offerPiece(session, { holder: 'device:l', bytes: set.pieces[2]!.bytes }, 2);
    const done = await id.completeRecovery(session, 3);
    const after = committeeKeyFor(id.identityFromSecret(done.secret), company);
    expect(after).toEqual(before);
    expect(committeeKeyFor(id.identityFromSecret(id.newSecret()), company)).not.toEqual(before);
  });
});

describe('WHAT A COMPANY IS TOLD', () => {
  it('WHEN LOSING ONE PERSON STRANDS THE MONEY, AND ONLY THEN', () => {
    /* RED WHEN: `everySignerNeeded` stops answering for a threshold equal to the signers - the 1-of-1 and 2-of-2
     * sentences are then null. */
    expect(everySignerNeeded(1, 1)).toMatch(/only signer.*the money stays there for good/s);
    expect(everySignerNeeded(2, 2)).toMatch(/Every one of this company's 2 signers.*recovery pieces/s);
    /* RED WHEN: the sentence stops naming the saved keys - losing this service's sealed copy of them strands the
     * money with the words intact. */
    expect(everySignerNeeded(1, 1)).toMatch(/or if your saved keys are lost, nobody can ever pay out/);
    expect(everySignerNeeded(2, 2)).toMatch(/or their saved keys are lost/);
    expect(everySignerNeeded(3, 2)).toBeNull();
    expect(everySignerNeeded(0, 1)).toBeNull();
  });

  it('A CONTRACT ANYBODY CAN CHANGE IS SAID IN THOSE WORDS, AND AN UNREADABLE ONE IS NEVER SHOWN AS HELD', () => {
    /* RED WHEN: `authorityView` drops its `anyone` sentence, or reports an unreachable read as held. */
    const anyone: AuthorityRead = {
      state: 'read', address: 'a',
      authority: { committee: [vk(1)], threshold: 0, counter: 3n, shape: 'anyone', hasDuplicateMembers: false },
    };
    expect(authorityView('vault', anyone, { committee: [vk(1)], threshold: 1 }, new Map()).why).toMatch(/ANYBODY can change this vault's rules/);
    const down = authorityView('account', { state: 'unreachable', address: 'a', why: 'down' }, { committee: [vk(1)], threshold: 1 }, new Map());
    /* RED WHEN: the seat this service's own key holds is not named as this service's. */
    const ours = authorityView('account', { ...anyone, authority: { ...(anyone as Extract<AuthorityRead, { state: 'read' }>).authority, threshold: 1, shape: 'one-key' } } as AuthorityRead,
      { committee: [vk(2)], threshold: 1 }, new Map(), vk(1));
    expect(ours.seats[0]).toMatchObject({ thisService: true, holder: null, onTheCompanysCommittee: false });
    expect(ours.why).toMatch(/THIS SERVICE'S temporary key holds this account's rules/);
    expect(down).toMatchObject({ heldByTheCompany: false, seats: [], read: 'unreachable' });
    expect(moneyIn({ state: 'unreachable', address: 'a', why: 'down' }, { committee: [vk(1)], threshold: 1 }, null))
      .toMatch(/could not be asked/);
  });
});
