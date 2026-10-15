import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { REQUEST_SCHEMA, RequestError, parseAsk, type CommitteeRequest, type HandOverRequest } from './request.js';
import {
  COMMITTEE_JOIN_SCHEMA, COMMITTEE_SIGNATURES_SCHEMA, CommitteeSignError, LARGEST_COUNTER, SUPER_ADMIN_CHANGE_TAG,
  committeeChangeShown, committeeJoinFor, committeeSignaturesFor, committeeUpdateOf, contractsToRead, joinedBy,
  readCommitteeSignatures, superAdminChangeBytes, type ChainRead, type CommitteeUpdateLedger, type ContractOnTheChain,
} from './committee-sign.js';
import type { AccountAddress, CompanyLabel } from './company-label.js';

/*
 * A committee change, as a page asks for it and as this wallet checks against
 * the chain, shows and signs it. Three presses share the one kind: a hand-over,
 * which only ever brings a contract to the committee holding the company's
 * account; a change of the super admins, signed only once every key it puts on
 * a contract has signed the change with its own key; and that joining key's own
 * signature. The chain is what this wallet read at its own indexer; the
 * signatures are checked with the ledger's own `verifySignature`.
 */
const ORIGIN = 'https://payroll.example';
const NOW = 1_800_000_000_000;
/* The company's label, the account that carries it, and one of its vaults. */
const COMPANY = `co_${'c0'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'b2'.repeat(32) as AccountAddress;
const VAULT = 'a1'.repeat(32);
const ELSEWHERE = 'dd'.repeat(32);
const SALT = '5a'.repeat(32);
const me = identityFromWords(TEST_MNEMONIC);
const other = identityFromWords(newWords().join(' '));
const third = identityFromWords(newWords().join(' '));
const mine = committeeKeyFor(me, COMPANY);
const theirs = committeeKeyFor(other, COMPANY);
const newcomer = committeeKeyFor(third, COMPANY);
type Key = { tag: string; value: string };
const sorted = (...ks: { value: string }[]): Key[] => ks.map((k) => ({ tag: 'schnorr', value: k.value })).sort((a, b) => (a.value < b.value ? -1 : 1));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const P = L as unknown as CommitteeUpdateLedger;

/* A contract as this wallet reads it at its own indexer. */
const held = (committee: Key[], threshold: number, counter: bigint, pinnedTo: string | null = ACCOUNT): ContractOnTheChain =>
  ({ of: 'read', committee, threshold, counter, pinnedTo });
const chainOf = (entries: Record<string, ContractOnTheChain>): ChainRead => new Map(Object.entries(entries));

const base = {
  schema: REQUEST_SCHEMA,
  kind: 'committee',
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'So your company is held by its super admins as the chain holds them.',
  nonce: 'n-1',
  expiresAt: NOW + 60_000,
  company: COMPANY,
  account: ACCOUNT,
};

/* A HAND-OVER: the vault is brought to the committee the account holds on the chain. */
const ACCOUNT_HOLDS = { committee: sorted(mine, newcomer), threshold: 2 };
const handOverChain = (over: Record<string, ContractOnTheChain> = {}) => chainOf({
  [ACCOUNT]: held(ACCOUNT_HOLDS.committee, 2, 1n, null), [VAULT]: held(sorted(mine, theirs), 2, 4n), ...over,
});
const wire = (over: Record<string, unknown> = {}) => ({
  ...base,
  to: ACCOUNT_HOLDS,
  contracts: [{ contract: 'vault', address: VAULT, counter: '4', now: { committee: sorted(mine, theirs), threshold: 2 } }],
  ...over,
});

/* A CHANGE OF THE SUPER ADMINS: the newcomer joins and `theirs` leaves, on the account and the vault. */
const CHANGE = {
  kind: 'super-admins',
  from: { committee: sorted(mine, theirs), threshold: 2 },
  committee: sorted(mine, newcomer),
  threshold: 2,
  contracts: [{ contract: 'account', address: ACCOUNT, counter: '1' }, { contract: 'vault', address: VAULT, counter: '4' }],
} as const;
const changeBytesOf = (change: typeof CHANGE | Record<string, unknown> = CHANGE, salt = SALT) =>
  hex(superAdminChangeBytes(COMPANY, ACCOUNT, salt, change as never));
const joinSignatureOf = (who: Identity, bytes: string): string =>
  (L.signData(committeeSigningKeyFor(who, COMPANY) as never, Buffer.from(bytes, 'hex')) as unknown as Key).value;
const superAdminsChain = (over: Record<string, ContractOnTheChain> = {}) => chainOf({
  [ACCOUNT]: held(sorted(mine, theirs), 2, 1n, null), [VAULT]: held(sorted(mine, theirs), 2, 4n), ...over,
});
const superAdminsWire = (over: Record<string, unknown> = {}) => ({
  ...base,
  change: CHANGE,
  salt: SALT,
  changeBytes: changeBytesOf(),
  joined: [{ key: { tag: 'schnorr', value: newcomer.value }, signature: joinSignatureOf(third, changeBytesOf()) }],
  contracts: CHANGE.contracts,
  ...over,
});
const joinWire = (over: Record<string, unknown> = {}) => ({
  ...base, change: CHANGE, salt: SALT, changeBytes: changeBytesOf(), joining: true, ...over,
});

const parsed = (w: Record<string, unknown>): CommitteeRequest => {
  const p = parseAsk(w, ORIGIN, NOW);
  if (p.kind !== 'committee') throw new Error('not a committee change');
  return p;
};
const ask = (over: Record<string, unknown> = {}) => parsed(wire(over)) as HandOverRequest;
const refusal = (w: Record<string, unknown>): RequestError => {
  try { parseAsk(w, ORIGIN, NOW); } catch (e) { return e as RequestError; }
  throw new Error('it parsed');
};
const refusedFor = (who: Identity, request: CommitteeRequest, chain: ChainRead): string => {
  try { committeeChangeShown(L as never, who, request, chain); } catch (e) { expect(e).toBeInstanceOf(CommitteeSignError); return (e as Error).message; }
  throw new Error('it was shown');
};

const updateFor = (address: string, committee: Key[], threshold: number, counter: bigint) =>
  new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(committee as never, threshold, counter + 1n))], counter);

describe('A COMMITTEE CHANGE, AS A PAGE ASKS FOR IT', () => {
  it('parses a hand-over whole, the addresses folded to one spelling, and carries nothing that could be signed as it stands', () => {
    const p = parsed(wire({ account: ACCOUNT.toUpperCase() }));
    expect(p.press).toBe('hand-over');
    expect(p.company).toBe(COMPANY);
    expect(p.account).toBe(ACCOUNT);
    expect(p.requester.origin).toBe(ORIGIN);
    /* RED WHEN: the hand-over grows a field for bytes to sign - there is none to carry. */
    expect(Object.keys(p).sort()).toEqual(['account', 'company', 'contracts', 'expiresAt', 'kind', 'nonce', 'press', 'purpose', 'requester', 'schema', 'to']);
  });

  it('parses a change of the super admins and a joining key\'s ask, each with the change whole', () => {
    const b = parsed(superAdminsWire());
    expect(b.press).toBe('super-admins');
    expect(b.press === 'super-admins' && [b.to, b.joined.length, b.contracts.length]).toEqual([{ committee: CHANGE.committee, threshold: 2 }, 1, 2]);
    const c = parsed(joinWire());
    expect(c.press).toBe('join');
    expect(c.press === 'join' && c.changeBytes).toBe(changeBytesOf());
  });

  it('refuses an ask that mixes the fields of two presses, or leaves one of its own out', () => {
    /* RED WHEN: the parser picks one press out of a mixture rather than refusing it. */
    for (const w of [
      wire({ joined: [] }), wire({ change: CHANGE }), wire({ changeBytes: changeBytesOf() }),
      superAdminsWire({ to: ACCOUNT_HOLDS }), superAdminsWire({ joining: true }), superAdminsWire({ joined: undefined }),
      superAdminsWire({ salt: undefined }), joinWire({ contracts: CHANGE.contracts }), joinWire({ joined: [] }),
      joinWire({ joining: 'yes' }), { ...base },
    ]) {
      expect(refusal(w).code).toBe('not-a-committee-change');
    }
  });

  it('A COMPANY IS ITS LABEL AND ITS ACCOUNT IS AN ADDRESS, EACH REFUSED IN THE OTHER\'S PLACE', () => {
    /* RED WHEN: the committee kind reads its company as an address, or its account as a label. */
    expect(refusal(wire({ company: ACCOUNT })).code).toBe('not-a-company-label');
    expect(refusal(wire({ company: COMPANY.toUpperCase() })).code).toBe('not-a-company-label');
    expect(refusal(wire({ account: COMPANY })).code).toBe('not-an-account-address');
    expect(refusal(wire({ account: undefined })).code).toBe('not-an-account-address');
  });

  it('THE ACCOUNT IT CHANGES IS THE ACCOUNT IT NAMES, AND A VAULT NAMED AT THE ACCOUNT\'S ADDRESS IS REFUSED', () => {
    /* RED WHEN: an `account` contract naming some other address is signed for this company. */
    const elsewhere = [{ contract: 'account', address: ELSEWHERE, counter: '1', now: { committee: sorted(mine), threshold: 1 } }];
    expect(refusal(wire({ contracts: elsewhere })).code).toBe('not-a-committee-change');
    /* RED WHEN: an entry declared a vault but naming the account's own address is read, so the account's counter rule is skipped. */
    const declaredVault = [{ contract: 'vault', address: ACCOUNT, counter: '0', now: { committee: sorted(mine), threshold: 1 } }];
    expect(refusal(wire({ contracts: declaredVault })).message).toMatch(/calls the company's account a vault/);
    expect(refusal(superAdminsWire({ contracts: [{ contract: 'vault', address: ACCOUNT, counter: '1' }] })).code).toBe('not-a-committee-change');
  });

  it('REFUSES A COMMITTEE THAT IS NOT ONE THE CHAIN SHOULD HOLD, IN A HAND-OVER AND IN A CHANGE OF THE SUPER ADMINS', () => {
    for (const to of [
      { committee: [], threshold: 1 },
      { committee: [{ tag: 'ecdsa', value: mine.value }], threshold: 1 },
      { committee: [{ tag: 'schnorr', value: 'zz' }], threshold: 1 },
      { committee: sorted(mine), threshold: 0 },
      { committee: sorted(mine), threshold: 2 },
      { committee: sorted(mine), threshold: 1.5 },
      { committee: [...sorted(mine), ...sorted(mine)], threshold: 1 },
    ]) {
      /* RED WHEN: any of them parses: an ecdsa key, a threshold outside one to the keys, a key twice, no keys. */
      expect(refusal(wire({ to })).code).toBe('not-a-committee-change');
      expect(refusal(superAdminsWire({ change: { ...CHANGE, ...to } })).code).toBe('not-a-committee-change');
      expect(refusal(joinWire({ change: { ...CHANGE, ...to } })).code).toBe('not-a-committee-change');
    }
  });

  it('REFUSES A LIST OF JOINING SIGNATURES WITH A HOLE IN IT, OR ONE THAT IS NOT A SIGNATURE', () => {
    const one = { key: { tag: 'schnorr', value: newcomer.value }, signature: joinSignatureOf(third, changeBytesOf()) };
    const two = { key: { tag: 'schnorr', value: mine.value }, signature: joinSignatureOf(me, changeBytesOf()) };
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [one, , two];
    /* RED WHEN: a sparse list of joining signatures is read as if its gap were not there. */
    expect(refusal(superAdminsWire({ joined: sparse })).code).toBe('not-a-committee-change');
    expect(refusal(superAdminsWire({ joined: [{ ...one, signature: 'zz' }] })).code).toBe('not-a-committee-change');
    expect(refusal(superAdminsWire({ joined: [one, one] })).code).toBe('not-a-committee-change');
  });

  it('REFUSES A CONTRACT TO SIGN THAT THE CHANGE DOES NOT NAME', () => {
    /* RED WHEN: a press signs a contract the change's bytes do not cover. */
    expect(refusal(superAdminsWire({ contracts: [{ contract: 'vault', address: ELSEWHERE, counter: '0' }] })).code).toBe('not-a-committee-change');
  });

  it('REFUSES A CONTRACT NAMED TWICE, WITH NO COUNTER, AN ACCOUNT AT COUNTER ZERO, OR OF NO KIND IT KNOWS; AND NO CONTRACTS AT ALL', () => {
    const c = (x: Record<string, unknown>) => ({ contract: 'vault', address: VAULT, counter: '2', now: { committee: sorted(mine), threshold: 1 }, ...x });
    expect(ask({ contracts: [c({ counter: '0' })] }).contracts[0]!.counter).toBe('0');
    expect(refusal(wire({ contracts: [c({ contract: 'account', address: ACCOUNT, counter: '0' })] })).message).toMatch(/not finished being created, so who holds it cannot be changed yet/);
    for (const contracts of [
      [], [c({}), c({})], [c({ counter: 'x' })], [c({ contract: 'other' })], [c({ address: 'ab' })],
      [c({ contract: 'account', address: ACCOUNT }), c({ contract: 'account', address: VAULT })],
    ]) {
      expect(refusal(wire({ contracts })).code).toBe('not-a-committee-change');
    }
  });

  it('REFUSES DETAILS TO HAND OVER, AN INBOX KEY, AND ITS OWN FIELDS ON ANY OTHER KIND', () => {
    expect(refusal(wire({ wants: [{ attribute: 'name', required: true }] })).code).toBe('attributes-on-a-committee-change');
    expect(refusal(wire({ inboxPublicKey: 'ab'.repeat(32) })).code).toBe('inbox-key-on-a-committee-change');
    for (const kind of ['unlock', 'balance', 'keyring', 'disclosure', 'sign-in']) {
      for (const w of [wire(), superAdminsWire({ contracts: undefined }), joinWire()]) {
        let code = '';
        try { parseAsk({ ...w, kind }, ORIGIN, NOW); } catch (e) { code = (e as RequestError).code; }
        /* RED WHEN: a committee, a change of the super admins or a joining ask rides on another kind and is ignored. */
        expect(code).toBe('committee-fields-on-another-kind');
      }
    }
  });
});

describe('THE BYTES OF A CHANGE OF THE SUPER ADMINS, AND A JOINING KEY\'S SIGNATURE OVER THEM', () => {
  it('begin with their own tag and change with every part of the change', () => {
    const b = superAdminChangeBytes(COMPANY, ACCOUNT, SALT, CHANGE as never);
    expect(Buffer.from(b).subarray(4, 4 + SUPER_ADMIN_CHANGE_TAG.length).toString()).toBe(SUPER_ADMIN_CHANGE_TAG);
    for (const other of [{ ...CHANGE, threshold: 1 }, { ...CHANGE, from: { ...CHANGE.from, threshold: 1 } },
      { ...CHANGE, contracts: [CHANGE.contracts[0], { ...CHANGE.contracts[1], counter: '5' }] }]) {
      expect(hex(superAdminChangeBytes(COMPANY, ACCOUNT, SALT, other as never))).not.toBe(hex(b));
    }
    expect(hex(superAdminChangeBytes(COMPANY, ACCOUNT, '00'.repeat(32), CHANGE as never))).not.toBe(hex(b));
  });

  it('a joining signature verifies by the ledger\'s own check, and over nothing else', () => {
    const b = changeBytesOf();
    const s = joinSignatureOf(third, b);
    expect(joinedBy(L as never, Buffer.from(b, 'hex'), newcomer, s)).toBe(true);
    expect(joinedBy(L as never, Buffer.from(changeBytesOf({ ...CHANGE, threshold: 1 }), 'hex'), newcomer, s)).toBe(false);
    expect(joinedBy(L as never, Buffer.from(b, 'hex'), mine, s)).toBe(false);
    expect(joinedBy(L as never, Buffer.from(b, 'hex'), newcomer, 'zz')).toBe(false);
  });
});

describe('A HAND-OVER: SIGNED ONLY TO BRING A CONTRACT TO THE COMMITTEE HOLDING THE ACCOUNT ON THE CHAIN', () => {
  it('names who joins and who leaves from the chain, never from the page\'s word on who holds it now', () => {
    /* The page says only this key holds the vault; the chain says another key does too. */
    const shown = committeeChangeShown(L as never, me, ask({ contracts: [{ contract: 'vault', address: VAULT, counter: '4', now: { committee: sorted(mine), threshold: 1 } }] }), handOverChain());
    expect(shown.press).toBe('hand-over');
    expect(shown.mine).toEqual(mine);
    expect(shown.staysOn).toBe(true);
    const [vault] = shown.contracts;
    /* RED WHEN: the page's false `now` is what the screen shows: the leaving key would be hidden. */
    expect(vault!.leaves).toEqual([{ tag: 'schnorr', value: theirs.value }]);
    expect(vault!.joins).toEqual([{ tag: 'schnorr', value: newcomer.value }]);
    expect([vault!.keysNow, vault!.thresholdNow, vault!.thresholdAfter]).toEqual([2, 2, 2]);
    expect(vault!.seats).toEqual([sorted(mine, theirs).findIndex((k) => k.value === mine.value)]);
  });

  it('REFUSES A CONTRACT WHOSE COMMITTEE ON THE CHAIN DOES NOT HOLD THIS PERSON\'S KEY, WHATEVER THE PAGE SAYS', () => {
    /* RED WHEN: the page's `now` naming this key is believed over the chain's committee. */
    expect(refusedFor(me, ask(), handOverChain({ [VAULT]: held(sorted(theirs), 1, 4n) }))).toMatch(/not on the committee that holds vault .* on the chain/);
  });

  it('REFUSES AN INSTALL THAT DIFFERS FROM THE ACCOUNT\'S COMMITTEE ON THE CHAIN', () => {
    /* RED WHEN: a hand-over installs a committee the account does not hold - a key entering the company with no joining signature. */
    expect(refusedFor(me, ask({ to: { committee: sorted(mine, newcomer), threshold: 1 } }), handOverChain())).toMatch(/not the committee holding the company's account/);
    expect(refusedFor(me, ask({ to: { committee: sorted(mine, theirs), threshold: 2 } }), handOverChain())).toMatch(/not the committee holding the company's account/);
  });

  it('REFUSES A FOREIGN VAULT, AN UNREADABLE CONTRACT, A COUNTER THE CHAIN DOES NOT HOLD, AND AN ACCOUNT STILL BEING CREATED', () => {
    /* RED WHEN: a vault pinned to another account is signed under this company's account. */
    expect(refusedFor(me, ask(), handOverChain({ [VAULT]: held(sorted(mine, theirs), 2, 4n, ELSEWHERE) }))).toMatch(/pinned to another account/);
    expect(refusedFor(me, ask(), handOverChain({ [VAULT]: { of: 'unreadable', why: 'offline.' } }))).toMatch(/could not read who holds vault/);
    expect(refusedFor(me, ask(), chainOf({ [VAULT]: held(sorted(mine, theirs), 2, 4n) }))).toMatch(/could not read who holds the company's account/);
    /* RED WHEN: the counter the page names is signed over when the chain holds another. */
    expect(refusedFor(me, ask(), handOverChain({ [VAULT]: held(sorted(mine, theirs), 2, 5n) }))).toMatch(/counter/);
    /* RED WHEN: the account's counter rule reads the page's word and not the chain's account. */
    expect(refusedFor(me, ask(), handOverChain({ [ACCOUNT]: held(ACCOUNT_HOLDS.committee, 2, 0n, null) }))).toMatch(/not finished being created/);
  });

  it('THE PRESS SIGNS EXACTLY THE UPDATE THAT INSTALLS THE ACCOUNT\'S COMMITTEE AT THE CHAIN\'S COUNTER, AND NOTHING ELSE', () => {
    const request = ask();
    const answer = committeeSignaturesFor(L as never, me, request, handOverChain(), NOW);
    expect(answer.schema).toBe(COMMITTEE_SIGNATURES_SCHEMA);
    expect(answer.signer).toEqual(mine);
    expect(answer.signatures).toHaveLength(1);
    const s = answer.signatures[0]!;
    const exact = updateFor(VAULT, ACCOUNT_HOLDS.committee, 2, 4n);
    expect(L.verifySignature(mine as never, exact.dataToSign, s.signature as never)).toBe(true);
    /* The one builder: the update the device and the service build is the very one the wallet signs. */
    expect(hex(committeeUpdateOf(P, { address: VAULT, counter: 4n, to: ACCOUNT_HOLDS }).dataToSign)).toBe(hex(exact.dataToSign));
    for (const wrong of [updateFor(VAULT, ACCOUNT_HOLDS.committee, 2, 5n), updateFor(VAULT, ACCOUNT_HOLDS.committee, 1, 4n),
      updateFor(VAULT, sorted(mine, theirs), 2, 4n), updateFor(ACCOUNT, ACCOUNT_HOLDS.committee, 2, 4n)]) {
      expect(L.verifySignature(mine as never, wrong.dataToSign, s.signature as never)).toBe(false);
    }
    expect(JSON.stringify(answer)).not.toContain(committeeSigningKeyFor(me, COMPANY).value);
  });

  it('A KEY LISTED TWICE ON THE CHAIN\'S COMMITTEE IS SIGNED AT EVERY PLACE IT HOLDS, IN ORDER', () => {
    const twice = committeeSignaturesFor(L as never, me, ask(), handOverChain({ [VAULT]: held([...sorted(mine), ...sorted(mine)], 2, 4n) }), NOW);
    expect(twice.signatures.map((s) => s.seat)).toEqual([0, 1]);
  });

  it('REFUSES WHEN IT CANNOT TELL WHO ASKED, AND NEVER SIGNS A JOINING ASK AS AN UPDATE', () => {
    const request = ask();
    const blind = { ...request, requester: { ...request.requester, origin: 'null' } } as CommitteeRequest;
    expect(() => committeeSignaturesFor(L as never, me, blind, handOverChain(), NOW)).toThrow(/could not tell who asked/);
    expect(() => committeeSignaturesFor(L as never, third, parsed(joinWire()), superAdminsChain(), NOW)).toThrow(CommitteeSignError);
    expect(() => committeeJoinFor(L as never, me, request, handOverChain(), NOW)).toThrow(CommitteeSignError);
  });

  it('reads the account and every contract it names from the chain, the account first', () => {
    expect(contractsToRead(ask())).toEqual([ACCOUNT, VAULT]);
    expect(contractsToRead(parsed(joinWire()))).toEqual([ACCOUNT, VAULT]);
  });
});

describe('A CHANGE OF THE SUPER ADMINS: THE BYTES REBUILT, THE CHAIN READ, EVERY JOIN SIGNED', () => {
  it('signs every contract it holds a place on at the chain\'s counter, once the bytes and the joins check', () => {
    const request = parsed(superAdminsWire());
    const shown = committeeChangeShown(L as never, me, request, superAdminsChain());
    expect(shown.contracts.map((c) => [c.address, c.joins.map((k) => k.value), c.leaves.map((k) => k.value)]))
      .toEqual([[ACCOUNT, [newcomer.value], [theirs.value]], [VAULT, [newcomer.value], [theirs.value]]]);
    const answer = committeeSignaturesFor(L as never, me, request, superAdminsChain(), NOW);
    for (const s of answer.signatures) {
      const exact = committeeUpdateOf(P, { address: s.address, counter: BigInt(s.counter), to: { committee: CHANGE.committee, threshold: 2 } });
      expect(L.verifySignature(mine as never, exact.dataToSign, s.signature as never)).toBe(true);
    }
    expect(answer.signatures.map((s) => [s.address, s.counter])).toEqual([[ACCOUNT, '1'], [VAULT, '4']]);
  });

  it('REFUSES BYTES THE PAGE SENT THAT ARE NOT THE CHANGE REBUILT HERE', () => {
    /* RED WHEN: the page's bytes are taken without being rebuilt from the change. */
    const otherBytes = changeBytesOf({ ...CHANGE, threshold: 1 });
    expect(refusedFor(me, parsed(superAdminsWire({ changeBytes: otherBytes })), superAdminsChain())).toMatch(/not the change it asks/);
    expect(refusedFor(third, parsed(joinWire({ changeBytes: otherBytes })), superAdminsChain())).toMatch(/not the change it asks/);
  });

  it('REFUSES WHILE A KEY THE CHANGE PUTS ON A CONTRACT HAS NOT SIGNED THE CHANGE WITH ITS OWN KEY', () => {
    /* RED WHEN: the wallet signs an update that puts on a contract a key nobody has shown they hold. */
    expect(refusedFor(me, parsed(superAdminsWire({ joined: [] })), superAdminsChain())).toMatch(/has not signed the change with its own key/);
    const byAnother = [{ key: { tag: 'schnorr', value: newcomer.value }, signature: joinSignatureOf(other, changeBytesOf()) }];
    expect(refusedFor(me, parsed(superAdminsWire({ joined: byAnother })), superAdminsChain())).toMatch(/has not signed the change with its own key/);
    const overOther = [{ key: { tag: 'schnorr', value: newcomer.value }, signature: joinSignatureOf(third, changeBytesOf({ ...CHANGE, threshold: 1 })) }];
    expect(refusedFor(me, parsed(superAdminsWire({ joined: overOther })), superAdminsChain())).toMatch(/has not signed the change with its own key/);
  });

  it('computes the joins from each contract on the chain, so a key the page calls already seated still signs', () => {
    /* The vault on the chain is held by `mine` alone: `theirs` would join it too, and has not signed. */
    const chain = superAdminsChain({ [VAULT]: held(sorted(mine), 1, 4n) });
    const change = { ...CHANGE, committee: sorted(mine, theirs, newcomer) };
    const b = changeBytesOf(change);
    const request = parsed(superAdminsWire({ change, changeBytes: b, joined: [{ key: { tag: 'schnorr', value: newcomer.value }, signature: joinSignatureOf(third, b) }] }));
    /* RED WHEN: the joins are read from the change's `from` rather than from each contract's committee on the chain. */
    expect(refusedFor(me, request, chain)).toMatch(/has not signed the change with its own key/);
  });

  it('REFUSES WHEN THE ACCOUNT ON THE CHAIN IS HELD BY NEITHER THE COMMITTEE THE CHANGE REPLACES NOR THE ONE IT INSTALLS', () => {
    /* RED WHEN: a stale or altered change is signed against an account it does not describe. */
    const chain = superAdminsChain({ [ACCOUNT]: held(sorted(mine, theirs), 1, 1n, null) });
    expect(refusedFor(me, parsed(superAdminsWire()), chain)).toMatch(/raised when the account was at counter 1/);
    expect(refusedFor(third, parsed(joinWire()), chain)).toMatch(/raised when the account was at counter 1/);
  });

  it('REFUSES A FOREIGN VAULT AND A COUNTER THE CHAIN DOES NOT HOLD', () => {
    expect(refusedFor(me, parsed(superAdminsWire()), superAdminsChain({ [VAULT]: held(sorted(mine, theirs), 2, 4n, ELSEWHERE) }))).toMatch(/pinned to another account/);
    expect(refusedFor(me, parsed(superAdminsWire()), superAdminsChain({ [VAULT]: held(sorted(mine, theirs), 2, 3n) }))).toMatch(/counter/);
  });
});

describe('A CHANGE IS SIGNED ONLY WHILE THE ACCOUNT IS WHERE THE CHANGE WAS RAISED, OR ONE STEP ON', () => {
  it('REFUSES A CHANGE REPLAYED AFTER THE ACCOUNT CAME BACK TO THE COMMITTEE IT REPLACES', () => {
    /* The change was raised at account counter 1; two changes later the account holds its `from` again, at 3. */
    const chain = superAdminsChain({ [ACCOUNT]: held(sorted(mine, theirs), 2, 3n, null) });
    const asked = [{ contract: 'account', address: ACCOUNT, counter: '3' }, { contract: 'vault', address: VAULT, counter: '4' }];
    /* RED WHEN: a change that already ran, or was turned down, is signed again with its joining key's old signature. */
    expect(refusedFor(me, parsed(superAdminsWire({ contracts: asked })), chain)).toMatch(/raised when the account was at counter 1/);
    expect(refusedFor(third, parsed(joinWire()), chain)).toMatch(/raised when the account was at counter 1/);
  });

  it('takes the account holding the change\'s committee one counter on, and no further', () => {
    const vaultOnly = parsed(superAdminsWire({ contracts: [{ contract: 'vault', address: VAULT, counter: '4' }] }));
    const landed = superAdminsChain({ [ACCOUNT]: held(sorted(mine, newcomer), 2, 2n, null) });
    expect(committeeChangeShown(L as never, me, vaultOnly, landed).contracts).toHaveLength(1);
    /* RED WHEN: the account holding the change's committee is believed at any counter, so a later change is overridden. */
    expect(refusedFor(me, vaultOnly, superAdminsChain({ [ACCOUNT]: held(sorted(mine, newcomer), 2, 3n, null) }))).toMatch(/raised when the account was at counter 1/);
  });

  it('REFUSES A CHANGE THAT LEAVES OUT A VAULT THE ACCOUNT LISTS ON THE CHAIN', () => {
    const listing = (vaults: string[]) => superAdminsChain({ [ACCOUNT]: { ...held(sorted(mine, theirs), 2, 1n, null), vaults } as ContractOnTheChain });
    /* RED WHEN: a change naming fewer than every contract of the company is signed, so an older signed update can still land on the one it leaves out. */
    expect(refusedFor(me, parsed(superAdminsWire()), listing([VAULT, ELSEWHERE]))).toMatch(new RegExp(`leaves out vault ${ELSEWHERE}`));
    expect(refusedFor(third, parsed(joinWire()), listing([VAULT, ELSEWHERE]))).toMatch(new RegExp(`leaves out vault ${ELSEWHERE}`));
    expect(committeeChangeShown(L as never, me, parsed(superAdminsWire()), listing([VAULT])).contracts).toHaveLength(2);
  });
});

describe('A JOINING KEY SIGNS THE CHANGE ITSELF', () => {
  it('signs the rebuilt bytes with its own key, which the ledger\'s check takes, after showing who joins and leaves', () => {
    const request = parsed(joinWire());
    const shown = committeeChangeShown(L as never, third, request, superAdminsChain());
    expect(shown.press).toBe('join');
    expect(shown.contracts.map((c) => c.joins.map((k) => k.value))).toEqual([[newcomer.value], [newcomer.value]]);
    const answer = committeeJoinFor(L as never, third, request, superAdminsChain(), NOW);
    expect(answer.schema).toBe(COMMITTEE_JOIN_SCHEMA);
    expect(answer.signer).toEqual(newcomer);
    expect([answer.origin, answer.nonce, answer.company, answer.account]).toEqual([ORIGIN, 'n-1', COMPANY, ACCOUNT]);
    /* RED WHEN: the wallet signs anything but the change's bytes with this key. */
    expect(joinedBy(L as never, Buffer.from(changeBytesOf(), 'hex'), newcomer, answer.signature)).toBe(true);
  });

  it('REFUSES TO JOIN FOR A KEY THE CHANGE DOES NOT INSTALL', () => {
    /* RED WHEN: a key the change takes off, or never names, signs as a joining key. */
    expect(refusedFor(other, parsed(joinWire()), superAdminsChain())).toMatch(/not one this change installs/);
    expect(() => committeeJoinFor(L as never, other, parsed(joinWire()), superAdminsChain(), NOW)).toThrow(/not one this change installs/);
  });
});

describe('THE PAGE READS THE ANSWER AGAINST WHAT IT ASKED', () => {
  const request = ask();
  const answer = JSON.parse(JSON.stringify(committeeSignaturesFor(L as never, me, request, handOverChain(), NOW)));
  const expecting = {
    atOrigin: ORIGIN, expectingNonce: 'n-1', company: COMPANY, account: ACCOUNT, to: request.to,
    contracts: [{ address: VAULT, counter: '4' }],
  };

  it('takes an answer to exactly this ask', () => {
    const read = readCommitteeSignatures(answer, expecting);
    expect(read.ok && read.signatures.length).toBe(1);
  });

  it('REFUSES A LIST OF SIGNATURES WITH A HOLE, OR WHOSE PLACES ON ONE CONTRACT ARE NOT STRICTLY INCREASING', () => {
    const s = answer.signatures[0];
    /* RED WHEN: a sparse list, or one repeating or reversing a place, is taken as the wallet's answer. */
    // eslint-disable-next-line no-sparse-arrays
    expect(readCommitteeSignatures({ ...answer, signatures: [s, , { ...s, seat: 1 }] }, expecting)).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures({ ...answer, signatures: [s, s] }, expecting)).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures({ ...answer, signatures: [{ ...s, seat: 1 }, s] }, expecting)).toMatchObject({ ok: false, code: 'other-change' });
    /* The places are set here, not taken from s: this wallet's key sorts first or second against a fresh key, at random. */
    expect(readCommitteeSignatures({ ...answer, signatures: [{ ...s, seat: 0 }, { ...s, seat: 1 }] }, expecting)).toMatchObject({ ok: true });
  });

  it('REFUSES ANOTHER ORIGIN, ANOTHER NONCE, ANOTHER COMMITTEE, AND A SIGNATURE FOR A CONTRACT OR COUNTER IT DID NOT ASK ABOUT', () => {
    expect(readCommitteeSignatures(answer, { ...expecting, atOrigin: 'https://elsewhere.example' })).toMatchObject({ ok: false, code: 'origin-mismatch' });
    expect(readCommitteeSignatures(answer, { ...expecting, expectingNonce: 'n-2' })).toMatchObject({ ok: false, code: 'nonce-mismatch' });
    expect(readCommitteeSignatures(answer, { ...expecting, to: { ...request.to, threshold: 1 } })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, contracts: [{ address: ACCOUNT, counter: '1' }] })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, contracts: [{ address: VAULT, counter: '5' }] })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures({ ...answer, schema: 'x' }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
    /* RED WHEN: the keys of the committee are not compared, only its threshold. */
    expect(readCommitteeSignatures(answer, { ...expecting, to: { ...request.to, committee: sorted(mine, theirs) as never } })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, company: `co_${'dd'.repeat(32)}` as CompanyLabel })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, account: ELSEWHERE as AccountAddress })).toMatchObject({ ok: false, code: 'other-change' });
    const badSeat = { ...answer, signatures: answer.signatures.map((x: { seat: number }) => ({ ...x, seat: 0.5 })) };
    expect(readCommitteeSignatures(badSeat, expecting)).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures({ ...answer, signer: { tag: 'schnorr', value: 'zz' } }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
  });
});

describe('ONE BUILDER OF A COMMITTEE UPDATE', () => {
  it('refuses a counter the chain cannot carry past, and an address that is not a contract\'s', () => {
    /* RED WHEN: an update is built whose next counter the chain cannot hold. */
    expect(() => committeeUpdateOf(P, { address: VAULT, counter: LARGEST_COUNTER, to: ACCOUNT_HOLDS })).toThrow(/never moves past it/);
    expect(() => committeeUpdateOf(P, { address: 'ab', counter: 0n, to: ACCOUNT_HOLDS })).toThrow(/sixty-four character address/);
    expect(() => committeeUpdateOf(P, { address: VAULT, counter: -1n, to: ACCOUNT_HOLDS })).toThrow(/never below zero/);
  });
});
