import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '@midnightntwrk/ledger-v9';
import {
  authorityView, buildCommitteeChange, type CommitteeChangeLedger,
} from './company-authority.js';
import { readContractAuthority, replaceAuthorityOf, type AuthorityRead } from './ledger.js';
import { committeeReplacement, type Committee } from './vault-committee.js';
import { committeeUpdateOf, type CommitteeUpdateLedger } from 'midnight-identity/profile/committee-sign';
import { refusalToPutMoneyIn, type ContractAnswer } from '../wiring/vault-submission.js';

/*
 * **THE ONE GATE, ASKED ABOUT THE ACCOUNT.** The vault half is handed a read
 * that passes, so every answer below is about the company's account. This
 * used to call `accountFundingRefusal`, which was a second implementation of
 * the same rule; it is now the function every door actually asks.
 */
const moneyIn = (
  accountRead: ContractAnswer, _to: Committee, circuits: string | null, accountBornHeld = true,
): string | null => refusalToPutMoneyIn({
  label: 'v',
  what: 'no money goes in',
  vault: { state: 'answered' },
  vaultCircuits: null,
  pinnedAccount: 'acc',
  started: true,
  companyAccount: 'acc',
  account: accountRead,
  accountCircuits: circuits,
  bornHeld: { vault: true, account: accountBornHeld },
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
    /* RED WHEN: any file the product ships constructs `ReplaceAuthority` anywhere but inside `replaceAuthorityOf`
     * and, in the wallet's package, inside `committeeUpdateOf` - reverting `committeeReplacement` or
     * any other builder to its own construction makes a third - or names the class in code anywhere but the three
     * files listed below, which is how an alias would reach it.
     * WHAT IT CANNOT SEE: a name assembled at run time, or a construction in a helper that is not exported and is
     * declared after the named function. It reads source text, and says so. */
    const roots = ['src', 'scripts', 'packages/identity/src', 'packages/web-shared/src', 'apps/wallet/src'];
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
    /*
     * **AND ONE PLACE IN THE WALLET, WHICH CANNOT REACH THE ONE ABOVE.** The wallet builds the committee change it
     * signs from what its screen showed, so that it signs nothing it did not show, and the wallet's package cannot
     * import this repository's `src/`. Its committee is refused on the same grounds when the ask is read -
     * `committeeOnTheWire` and `committeeChangeOf` in `packages/identity/src/profile/request.ts`: no keys, a key
     * that is not a committee key, a threshold that is not a whole number from one to the number of keys, a key
     * listed twice - and `committee-sign.test.ts` pins each of those. RED WHEN: any other wallet file constructs one.
     */
    expect(named.sort()).toEqual([
      'packages/identity/src/profile/committee-sign.ts',
      'src/midnight/authority-replacement.ts', 'src/midnight/vault-committee.ts',
    ]);
    expect(sdk).toEqual([]);
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.startsWith('src/'))).toMatch(/^src\/midnight\/authority-replacement\.ts:/);
    expect(hits.find((h) => h.startsWith('packages/'))).toMatch(/^packages\/identity\/src\/profile\/committee-sign\.ts:/);
    const walletText = readFileSync(join(REPO, 'packages/identity/src/profile/committee-sign.ts'), 'utf8');
    const walletAt = Number(hits.find((h) => h.startsWith('packages/'))!.split(':')[1]);
    const walletBefore = walletText.split('\n').slice(0, walletAt).join('\n');
    expect(walletBefore.lastIndexOf('export function committeeUpdateOf'))
      .toBeGreaterThan(walletBefore.lastIndexOf('\nexport function '));
    hits.splice(hits.findIndex((h) => h.startsWith('packages/')), 1);
    const builderText = readFileSync(join(REPO, 'src/midnight/authority-replacement.ts'), 'utf8');
    const at = Number(hits[0]!.split(':')[1]);
    const before = builderText.split('\n').slice(0, at).join('\n');
    expect(before.lastIndexOf('export function replaceAuthorityOf')).toBeGreaterThan(before.lastIndexOf('\nexport function '));
  });
});

describe('A COMMITTEE UPDATE HAS ONE BUILDER', () => {
  const P = L as never;
  const three = [vk(1), vk(2), vk(3)];
  it('the update a vault is handed over with is the one a wallet signs: built by the same function, never a second', () => {
    /* RED WHEN: `committeeReplacement` builds its own update again rather than through `committeeUpdateOf`, which the
     * wallet signs with, so the bytes a device counts and the bytes a wallet signs could drift apart. */
    const code = readFileSync(join(REPO, 'src/midnight/vault-committee.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
    expect(code).toMatch(/committeeUpdateOf\(/u);
    expect(code).not.toMatch(/new\s+[\w.]*\b(MaintenanceUpdate|ReplaceAuthority|ContractMaintenanceAuthority)\s*\(/u);
    const vault = 'ab'.repeat(32);
    const to = { committee: sorted(three), threshold: 2 };
    const device = (committeeReplacement(P, { vault, counter: 7n, to }) as unknown as { dataToSign: Uint8Array }).dataToSign;
    const wallet = committeeUpdateOf(L as unknown as CommitteeUpdateLedger, { address: vault, counter: 7n, to }).dataToSign;
    expect(Buffer.from(device).equals(Buffer.from(wallet))).toBe(true);
  });
});

describe('THE SERVICE PUTS A CONTRACT\'S UPDATE TOGETHER FROM THE SIGNATURES THAT VERIFY, ON THE WALLET\'S OWN BYTES', () => {
  const Lc = L as unknown as CommitteeChangeLedger;
  const walletBytes = (address: string, counter: bigint, to: Committee): Uint8Array =>
    committeeUpdateOf(L as unknown as CommitteeUpdateLedger, { address, counter, to }).dataToSign;
  const applied = async (ls: L.LedgerState, unproven: unknown): Promise<L.LedgerState> => {
    const proven = await (unproven as L.UnprovenTransaction).prove(neverAsked as never, L.CostModel.initialCostModel());
    const [after, result] = ls.apply(proven.bind().wellFormed(ls, strictness(), NOW), new L.TransactionContext(ls, blockContext));
    expect(result.type).toBe('success');
    return after;
  };

  it('no shipping file outside the wallet\'s own package builds a maintenance update', () => {
    /* RED WHEN: a builder of a committee update other than `committeeUpdateOf` comes back anywhere the service, the
     * page or a script ships - a third builder could sign or count different bytes from the ones a wallet signs. */
    const roots = ['src', 'scripts', 'packages/web-shared/src', 'apps/web/src'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'lib' || name === 'dist') continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|mjs|js)$/u.test(name) || /\.test\.(ts|tsx)$/u.test(name)) continue;
        const code = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
        if (/new\s+[\w.]*\bMaintenanceUpdate\s*\(/u.test(code)) hits.push(path.slice(REPO.length));
      }
    };
    for (const r of roots) walk(join(REPO, r));
    expect(hits).toEqual([]);
  });

  it('counts each place once, only where its signature verifies under that place\'s key, and sends what the ledger accepts', async () => {
    /* RED WHEN: a signature that does not verify under the key at the place it names counts - `have` is then 3 and the
     * fee is paid for an update the chain refuses; or one place counts twice. */
    const now = [vk(1), vk(2), vk(3)];
    const { ls, address } = deployedUnder(now, 2);
    const read = await readFrom(ls, address);
    const to = { committee: sorted([vk(4), vk(5)]), threshold: 2 };
    const bytes = walletBytes(address, 0n, to);
    const good0 = L.signData(sk(1), bytes);
    const built = buildCommitteeChange(Lc, {
      read, to, label: 'vault', network: NET, ttl: ttl(),
      signatures: [
        { index: 1, signature: L.signData(sk(3), bytes) },
        { index: 0, signature: good0 },
        { index: 0, signature: good0 },
        { index: 7, signature: good0 },
        { index: 2, signature: L.signData(sk(3), walletBytes(address, 1n, to)) },
        { index: 2, signature: L.signData(sk(3), bytes) },
      ],
    });
    expect(built).toMatchObject({ have: 2, required: 2, indexesSigned: [0, 2] });
    expect(built.unproven).not.toBeNull();
    const after = await readFrom(await applied(ls, built.unproven), address);
    expect(after).toMatchObject({ state: 'read', authority: { threshold: 2, counter: 1n } });
    expect(after.state === 'read' && sorted(after.authority.committee.map((k) => ({ ...k })))).toEqual(to.committee);
  });

  it('puts nothing together below the threshold of the committee holding the contract now', async () => {
    /* RED WHEN: the threshold counted is the one being installed rather than the one on the chain now. */
    const { ls, address } = deployedUnder([vk(1), vk(2), vk(3)], 2);
    const read = await readFrom(ls, address);
    const to = { committee: sorted([vk(4)]), threshold: 1 };
    const built = buildCommitteeChange(Lc, {
      read, to, label: 'vault', network: NET, ttl: ttl(),
      signatures: [{ index: 1, signature: L.signData(sk(2), walletBytes(address, 0n, to)) }],
    });
    expect(built).toMatchObject({ have: 1, required: 2, indexesSigned: [1], unproven: null });
  });

  it('builds the update of a contract that already holds the committee it installs, so its counter moves too', async () => {
    /* RED WHEN: a contract already at the committee asked for is refused - a change then leaves its counter where an
     * older signed update can still land on it. */
    const committee = sorted([vk(1), vk(2)]);
    const { ls, address } = deployedUnder(committee, 1);
    const read = await readFrom(ls, address);
    const to = { committee, threshold: 1 };
    const built = buildCommitteeChange(Lc, {
      read, to, label: 'vault', network: NET, ttl: ttl(),
      signatures: [{ index: 0, signature: L.signData(committee[0]!.value === vk(1).value ? sk(1) : sk(2), walletBytes(address, 0n, to)) }],
    });
    expect(built.unproven).not.toBeNull();
    expect(await readFrom(await applied(ls, built.unproven), address)).toMatchObject({ state: 'read', authority: { counter: 1n } });
  });
});

describe('A COMPANY ACCOUNT\'S ADDRESS, ON THE LEDGER\'S OWN STATE MACHINE', () => {
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
});

describe('A SIGNER WHO LOST THEIR DEVICES AND KEPT THEIR RECOVERY PIECES', () => {
  it('GETS THE SAME COMMITTEE KEY BACK, THROUGH THE WALLET\'S OWN RECOVERY', async () => {
    /* RED WHEN: the committee key stops being a function of the recovered secret alone - `after` then differs -
     * or the recovery returns something other than the secret. */
    const id = await import('midnight-identity');
    const { committeeKeyFor } = await import('midnight-identity/profile/committee-key');
    const { readCompanyLabel } = await import('midnight-identity/profile/company-label');
    const company = readCompanyLabel('co_' + 'c0'.repeat(32))!;
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
    expect(moneyIn({ state: 'unreachable', why: 'down' }, { committee: [vk(1)], threshold: 1 }, null))
      .toMatch(/could not be asked/);
  });
});
