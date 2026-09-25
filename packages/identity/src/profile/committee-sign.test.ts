import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords, newWords } from '../keys/derivation.js';
import { committeeKeyFor, committeeSigningKeyFor } from './committee-key.js';
import { REQUEST_SCHEMA, RequestError, parseAsk, type CommitteeRequest } from './request.js';
import {
  COMMITTEE_SIGNATURES_SCHEMA, CommitteeSignError, committeeChangeShown, committeeSignaturesFor, readCommitteeSignatures,
} from './committee-sign.js';

/*
 * A committee change, as a page asks for it and as this wallet shows and signs
 * it. The signatures are checked with the ledger's own `verifySignature` over
 * an update rebuilt here from what the screen showed, so the wallet cannot have
 * signed anything else and passed.
 */
const ORIGIN = 'https://payroll.example';
const NOW = 1_800_000_000_000;
const COMPANY = 'c0'.repeat(32);
const VAULT = 'a1'.repeat(32);
const me = identityFromWords(TEST_MNEMONIC);
const other = identityFromWords(newWords().join(' '));
const third = identityFromWords(newWords().join(' '));
const mine = committeeKeyFor(me, COMPANY);
const theirs = committeeKeyFor(other, COMPANY);
const newcomer = committeeKeyFor(third, COMPANY);
const sorted = (...ks: { value: string }[]) => ks.map((k) => ({ tag: 'schnorr', value: k.value })).sort((a, b) => (a.value < b.value ? -1 : 1));

const wire = (over: Record<string, unknown> = {}) => ({
  schema: REQUEST_SCHEMA,
  kind: 'committee',
  requester: { name: 'Payroll', rdns: 'example.payroll' },
  purpose: 'So your company is held by its signers as they are now.',
  nonce: 'n-1',
  expiresAt: NOW + 60_000,
  company: COMPANY,
  to: { committee: sorted(mine, newcomer), threshold: 2 },
  contracts: [
    { contract: 'account', address: COMPANY, counter: '1', now: { committee: sorted(mine, theirs), threshold: 1 } },
    { contract: 'vault', address: VAULT, counter: '4', now: { committee: sorted(mine, theirs), threshold: 2 } },
  ],
  ...over,
});
const ask = (over: Record<string, unknown> = {}): CommitteeRequest => {
  const parsed = parseAsk(wire(over), ORIGIN, NOW);
  if (parsed.kind !== 'committee') throw new Error('not a committee change');
  return parsed;
};
const refusal = (over: Record<string, unknown>): RequestError => {
  try { parseAsk(wire(over), ORIGIN, NOW); } catch (e) { return e as RequestError; }
  throw new Error('it parsed');
};

const updateFor = (address: string, committee: { tag: string; value: string }[], threshold: number, counter: bigint) =>
  new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(committee as never, threshold, counter + 1n))], counter);

describe('A COMMITTEE CHANGE, AS A PAGE ASKS FOR IT', () => {
  it('parses whole, folded to one spelling, and carries nothing that could be signed as it stands', () => {
    const upper = wire({ company: COMPANY.toUpperCase() });
    const parsed = parseAsk(upper, ORIGIN, NOW) as CommitteeRequest;
    expect(parsed.kind).toBe('committee');
    expect(parsed.company).toBe(COMPANY);
    expect(parsed.requester.origin).toBe(ORIGIN);
    expect(parsed.contracts.map((c) => [c.contract, c.address, c.counter])).toEqual([['account', COMPANY, '1'], ['vault', VAULT, '4']]);
    /* RED WHEN: the ask type grows a field for bytes to sign - there is none to carry. */
    expect(Object.keys(parsed).sort()).toEqual(['company', 'contracts', 'expiresAt', 'kind', 'nonce', 'purpose', 'requester', 'schema', 'to']);
  });

  it('REFUSES A COMMITTEE THAT IS NOT ONE THE CHAIN SHOULD HOLD: no keys, a stranger\'s key, a threshold out of range, a key listed twice', () => {
    /* The same grounds the service's one authority builder refuses on; RED WHEN any of them parses. */
    for (const to of [
      { committee: [], threshold: 1 },
      { committee: [{ tag: 'ecdsa', value: mine.value }], threshold: 1 },
      { committee: [{ tag: 'schnorr', value: 'zz' }], threshold: 1 },
      { committee: sorted(mine), threshold: 0 },
      { committee: sorted(mine), threshold: 2 },
      { committee: sorted(mine), threshold: 1.5 },
      { committee: [...sorted(mine), ...sorted(mine)], threshold: 1 },
    ]) {
      expect(refusal({ to }).code).toBe('not-a-committee-change');
    }
  });

  it('REFUSES A CONTRACT NAMED TWICE, WITH NO COUNTER, AT COUNTER ZERO, OR OF NO KIND IT KNOWS; AND NO CONTRACTS AT ALL', () => {
    const c = (x: Record<string, unknown>) => ({ contract: 'vault', address: VAULT, counter: '2', now: { committee: sorted(mine), threshold: 1 }, ...x });
    for (const contracts of [
      [], [c({}), c({})], [c({ counter: '0' })], [c({ counter: 'x' })], [c({ contract: 'other' })], [c({ address: 'ab' })],
      [c({ contract: 'account', address: COMPANY }), c({ contract: 'account', address: VAULT })],
    ]) {
      expect(refusal({ contracts }).code).toBe('not-a-committee-change');
    }
  });

  it('REFUSES DETAILS TO HAND OVER, AN INBOX KEY, AND ITS OWN FIELDS ON ANY OTHER KIND', () => {
    expect(refusal({ wants: [{ attribute: 'name', required: true }] }).code).toBe('attributes-on-a-committee-change');
    expect(refusal({ inboxPublicKey: 'ab'.repeat(32) }).code).toBe('inbox-key-on-a-committee-change');
    expect(refusal({ company: 'nope' }).code).toBe('not-a-company-address');
    for (const kind of ['unlock', 'balance', 'keyring', 'disclosure', 'sign-in']) {
      let code = '';
      try { parseAsk({ ...wire(), kind }, ORIGIN, NOW); } catch (e) { code = (e as RequestError).code; }
      /* RED WHEN: a committee to install rides on another kind of ask and is ignored rather than refused. */
      expect(code).toBe('committee-fields-on-another-kind');
    }
  });
});

describe('WHAT THIS WALLET SHOWS, WORKED OUT FROM THE ASK AND ITS OWN KEY', () => {
  it('names who joins, who leaves, the threshold before and after, and the seat this person signs at, per contract', () => {
    const shown = committeeChangeShown(me, ask());
    expect(shown.mine).toEqual(mine);
    expect(shown.staysOn).toBe(true);
    for (const c of shown.contracts) {
      expect(c.joins).toEqual([newcomer]);
      expect(c.leaves).toEqual([{ tag: 'schnorr', value: theirs.value }]);
      expect(c.seats).toEqual([sorted(mine, theirs).findIndex((k) => k.value === mine.value)]);
    }
    expect(shown.contracts.map((c) => [c.thresholdNow, c.thresholdAfter])).toEqual([[1, 2], [2, 2]]);
  });

  it('SAYS WHEN THIS PERSON SIGNS THEMSELVES OFF', () => {
    expect(committeeChangeShown(me, ask({ to: { committee: sorted(theirs, newcomer), threshold: 1 } })).staysOn).toBe(false);
  });

  it('REFUSES TO SHOW A CONTRACT THIS PERSON HOLDS NO SEAT ON, RATHER THAN SIGNING AROUND IT', () => {
    const contracts = [{ contract: 'vault', address: VAULT, counter: '2', now: { committee: sorted(theirs), threshold: 1 } }];
    /* RED WHEN: a contract without this person's seat is silently skipped. */
    expect(() => committeeChangeShown(me, ask({ contracts }))).toThrow(CommitteeSignError);
    expect(() => committeeChangeShown(me, ask({ contracts }))).toThrow(/not on the committee that holds vault/);
  });
});

describe('THE PRESS: WHAT THIS WALLET SIGNS', () => {
  const request = ask();
  const answer = committeeSignaturesFor(L as never, me, request, NOW);

  it('SIGNS, FOR EVERY CONTRACT, EXACTLY THE UPDATE THAT INSTALLS THE COMMITTEE SHOWN AGAINST THE COUNTER NAMED, AND NOTHING ELSE', () => {
    expect(answer.schema).toBe(COMMITTEE_SIGNATURES_SCHEMA);
    expect(answer.signer).toEqual(mine);
    expect(answer.signatures).toHaveLength(2);
    for (const s of answer.signatures) {
      const c = request.contracts.find((x) => x.address === s.address)!;
      const exact = updateFor(c.address, request.to.committee.map((k) => ({ ...k })), request.to.threshold, BigInt(c.counter));
      /* RED WHEN: the wallet signs anything but the whole-committee replacement it showed. */
      expect(L.verifySignature(mine as never, exact.dataToSign, s.signature as never)).toBe(true);
      /* ...and it verifies against nothing else: another counter, another threshold, another committee, another contract. */
      for (const wrong of [
        updateFor(c.address, request.to.committee.map((k) => ({ ...k })), request.to.threshold, BigInt(c.counter) + 1n),
        updateFor(c.address, request.to.committee.map((k) => ({ ...k })), 1, BigInt(c.counter)),
        updateFor(c.address, sorted(mine, theirs), request.to.threshold, BigInt(c.counter)),
        updateFor(c.address === VAULT ? COMPANY : VAULT, request.to.committee.map((k) => ({ ...k })), request.to.threshold, BigInt(c.counter)),
      ]) {
        expect(L.verifySignature(mine as never, wrong.dataToSign, s.signature as never)).toBe(false);
      }
    }
  });

  it('IS SIGNED BY THIS PERSON\'S COMMITTEE KEY FOR THIS COMPANY, AND THE SIGNING KEY IS NOWHERE IN WHAT IS HANDED BACK', () => {
    const text = JSON.stringify(answer);
    expect(text).not.toContain(committeeSigningKeyFor(me, COMPANY).value);
    const otherCompany = committeeKeyFor(me, 'dd'.repeat(32));
    const exact = updateFor(VAULT, request.to.committee.map((k) => ({ ...k })), 2, 4n);
    expect(L.verifySignature(otherCompany as never, exact.dataToSign, answer.signatures[1]!.signature as never)).toBe(false);
  });

  it('A KEY LISTED TWICE ON THE COMMITTEE NOW IS SIGNED AT EVERY SEAT IT HOLDS', () => {
    const contracts = [{ contract: 'vault', address: VAULT, counter: '2', now: { committee: [...sorted(mine), ...sorted(mine)], threshold: 2 } }];
    const twice = committeeSignaturesFor(L as never, me, ask({ contracts }), NOW);
    expect(twice.signatures.map((s) => s.seat)).toEqual([0, 1]);
  });

  it('REFUSES WHEN IT CANNOT TELL WHO ASKED', () => {
    const blind = { ...request, requester: { ...request.requester, origin: 'null' } } as CommitteeRequest;
    expect(() => committeeSignaturesFor(L as never, me, blind, NOW)).toThrow(/could not tell who asked/);
  });
});

describe('THE PAGE READS THE ANSWER AGAINST WHAT IT ASKED', () => {
  const request = ask();
  const answer = JSON.parse(JSON.stringify(committeeSignaturesFor(L as never, me, request, NOW)));
  const expecting = {
    atOrigin: ORIGIN, expectingNonce: 'n-1', company: COMPANY, to: request.to,
    contracts: request.contracts.map((c) => ({ address: c.address, counter: c.counter })),
  };

  it('takes an answer to exactly this ask', () => {
    const read = readCommitteeSignatures(answer, expecting);
    expect(read.ok && read.signatures.length).toBe(2);
  });

  it('REFUSES ANOTHER ORIGIN, ANOTHER NONCE, ANOTHER COMMITTEE, AND A SIGNATURE FOR A CONTRACT OR COUNTER IT DID NOT ASK ABOUT', () => {
    expect(readCommitteeSignatures(answer, { ...expecting, atOrigin: 'https://elsewhere.example' })).toMatchObject({ ok: false, code: 'origin-mismatch' });
    expect(readCommitteeSignatures(answer, { ...expecting, expectingNonce: 'n-2' })).toMatchObject({ ok: false, code: 'nonce-mismatch' });
    expect(readCommitteeSignatures(answer, { ...expecting, to: { ...request.to, threshold: 1 } })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, contracts: [{ address: COMPANY, counter: '1' }] })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, contracts: [{ address: COMPANY, counter: '1' }, { address: VAULT, counter: '5' }] }))
      .toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures({ ...answer, schema: 'x' }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
    /* RED WHEN: the keys of the committee are not compared, only its threshold. */
    const otherKeys = { ...request.to, committee: sorted(mine, theirs) as never };
    expect(readCommitteeSignatures(answer, { ...expecting, to: otherKeys })).toMatchObject({ ok: false, code: 'other-change' });
    expect(readCommitteeSignatures(answer, { ...expecting, company: 'dd'.repeat(32) })).toMatchObject({ ok: false, code: 'other-change' });
    const badSeat = { ...answer, signatures: answer.signatures.map((x: { seat: number }) => ({ ...x, seat: 0.5 })) };
    expect(readCommitteeSignatures(badSeat, expecting)).toMatchObject({ ok: false, code: 'other-change' });
    /* RED WHEN: an answer that does not say which key signed is taken - the page then cannot check the signer. */
    expect(readCommitteeSignatures({ ...answer, signer: { tag: 'schnorr', value: 'zz' } }, expecting)).toMatchObject({ ok: false, code: 'not-an-answer' });
  });
});
