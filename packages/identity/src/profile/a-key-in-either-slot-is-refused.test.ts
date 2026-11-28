import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { identityFromSecret, newSecret } from '../keys/derivation.js';
import { committeeKeyFor } from './committee-key.js';
import type { CompanyLabel } from './company-label.js';
import {
  compareVerifierKeys,
  operationOfKeyFile,
  operationsFromContractState,
  releasedVersionOf,
  slotsOfOperationBytes,
  verifierKeysMatch,
  type OperationsRead
} from './contract-keys.js';
import { creationShown, type CreationLedger } from './creation-sign.js';
import { parseAsk, type CreationRequest } from './request.js';
import {
  RELEASED_VERSIONS,
  releasedListRefusals,
  type KeySlot,
  type ReleasedVersion
} from '../wallet/released-versions.js';

/*
 * An operation on chain keeps two verifier keys, one per proving system, and
 * the ledger checks each proof against the slot of its own version, so both
 * are live. The ledger's own `verifierKey` shows one of them. These drive the
 * real ledger's operations with a second key put beside the expected one.
 *
 * The keys here are made-up bodies behind real key-file headers: the ledger
 * reads a key's body only when it checks a proof, and nothing here checks one.
 */
const enc = new TextEncoder();
const HEADER: Record<KeySlot, string> = { v2: 'midnight:verifier-key[v6]:', v3: 'midnight:verifier-key[v7]:' };
const lengthPrefix = (n: number): number[] => (n < 64 ? [n << 2] : [((n & 0x3f) << 2) | 1, n >> 6]);
const keyFile = (slot: KeySlot, seed: number, size = 48): Uint8Array =>
  Uint8Array.from([
    ...enc.encode(HEADER[slot]),
    ...lengthPrefix(size),
    ...Array.from({ length: size }, (_, i) => (i * seed + 11) & 255)
  ]);
const opHolding = (...keys: Uint8Array[]): L.ContractOperation => {
  const op = new L.ContractOperation();
  for (const k of keys) op.verifierKey = k;
  return op;
};
const stateHolding = (ops: Record<string, Uint8Array[]>): L.ContractState => {
  const s = new L.ContractState();
  for (const [name, keys] of Object.entries(ops)) s.setOperation(name, opHolding(...keys));
  return s;
};
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const read = (ops: Record<string, Uint8Array[]>): OperationsRead =>
  operationsFromContractState(stateHolding(ops), 'a1');

const SHOWN = keyFile('v3', 3);
const HIDDEN = keyFile('v2', 5, 300);

describe('EVERY KEY SLOT OF AN OPERATION IS READ', () => {
  it("READS BOTH SLOTS FROM THE OPERATION'S OWN BYTES, EACH AS THE KEY FILE IT WAS WRITTEN FROM", () => {
    const r = read({ put: [HIDDEN, SHOWN] });
    expect(r.state).toBe('read');
    const slots = r.state === 'read' ? r.operations[0]!.slots : [];
    /* RED WHEN: only the key the ledger's own reading shows is taken, and the other slot is never read. */
    expect(slots.map((s) => [s.slot, hexOf(s.key)])).toEqual([
      ['v2', hexOf(HIDDEN)],
      ['v3', hexOf(SHOWN)]
    ]);
    const alone = read({ put: [HIDDEN] });
    expect(alone.state === 'read' && alone.operations[0]!.slots.map((s) => s.slot)).toEqual(['v2']);
  });

  it('REFUSES TO READ AN OPERATION WHOSE BYTES ARE MISSING OR DO NOT READ AS THE KEY IT SHOWS', () => {
    const real = opHolding(SHOWN);
    const other = opHolding(keyFile('v3', 9));
    const fake = (op: Record<string, unknown>) =>
      operationsFromContractState({ operations: () => ['put'], operation: () => op }, 'a1');
    /* RED WHEN: an operation that hides its bytes is read from the one key it shows. */
    expect(fake({ verifierKey: SHOWN }).state).toBe('unreadable');
    /* RED WHEN: bytes that hold another key than the one shown are believed. */
    const swapped = fake({ verifierKey: SHOWN, serialize: () => other.serialize() });
    expect(swapped.state === 'unreadable' && swapped.why).toMatch(/do not read as the key the ledger shows/);
    expect(fake({ verifierKey: SHOWN, serialize: () => real.serialize() }).state).toBe('read');
    const bytes = real.serialize();
    expect(slotsOfOperationBytes(bytes.slice(0, bytes.length - 20))).toBeNull();
    expect(slotsOfOperationBytes(enc.encode('midnight:contract-state[v6]:'))).toBeNull();
    /* RED WHEN: bytes after an operation that says it carries no circuit description are read past. */
    expect(slotsOfOperationBytes(Uint8Array.from([...bytes, 0]))).toBeNull();
    expect(slotsOfOperationBytes(bytes)).not.toBeNull();
  });

  it('REFUSES A KEY FILE WHOSE HEADER NAMES NO VERSION THE LEDGER TAKES, RATHER THAN FILING IT UNDER A SLOT', () => {
    expect(operationOfKeyFile('put', SHOWN)?.slots.map((s) => s.slot)).toEqual(['v3']);
    expect(operationOfKeyFile('put', HIDDEN)?.slots.map((s) => s.slot)).toEqual(['v2']);
    /* RED WHEN: a file of no known version is taken as a key of the newer proving system. */
    expect(operationOfKeyFile('put', Uint8Array.from([...enc.encode('midnight:verifier-key[v8]:'), 4, 1]))).toBeNull();
  });
});

describe('THE ONE KEY MATCHER REFUSES A HIDDEN KEY IN EITHER SLOT', () => {
  it('AGREES ONLY WHEN EVERY FILLED SLOT HOLDS EXACTLY THE EXPECTED KEYS, OVER BYTES AND OVER DIGESTS', () => {
    const want = new Map([['put', SHOWN]]);
    expect(compareVerifierKeys(read({ put: [SHOWN] }), want).verdict).toBe('agree');
    /* RED WHEN: a key put in the slot the ledger's own reading does not show passes beside this build's. */
    const hidden = compareVerifierKeys(read({ put: [HIDDEN, SHOWN] }), want);
    expect([hidden.verdict, hidden.mismatched]).toEqual(['disagree', ['put']]);
    const digests = new Map([['put', [sha256(SHOWN)]]]);
    expect(verifierKeysMatch(read({ put: [SHOWN] }), digests, sha256).verdict).toBe('agree');
    expect(verifierKeysMatch(read({ put: [HIDDEN, SHOWN] }), digests, sha256).verdict).toBe('disagree');
    /* A circuit expected to fill both slots agrees only when both hold its keys. */
    const both = new Map([['put', [sha256(HIDDEN), sha256(SHOWN)]]]);
    expect(verifierKeysMatch(read({ put: [HIDDEN, SHOWN] }), both, sha256).verdict).toBe('agree');
    expect(verifierKeysMatch(read({ put: [SHOWN] }), both, sha256).verdict).toBe('disagree');
    expect(verifierKeysMatch(read({ put: [keyFile('v2', 7), SHOWN] }), both, sha256).verdict).toBe('disagree');
  });
});

describe("THE FOUNDING SIGNER'S WALLET REFUSES A DEPLOY WHOSE CIRCUIT HIDES A SECOND KEY", () => {
  const label = `co_${'5a'.repeat(32)}` as CompanyLabel;
  const account = 'c0'.repeat(32);
  const founder = identityFromSecret(newSecret());
  const mine = committeeKeyFor(founder, label);
  const FIRST = { adopt: keyFile('v3', 13), approve: keyFile('v3', 17) };
  const SECOND = { anchor: keyFile('v3', 19) };
  const build = {
    first: new Map(Object.entries(FIRST).map(([c, k]) => [c, sha256(k)])),
    second: new Map(Object.entries(SECOND).map(([c, k]) => [c, sha256(k)]))
  };
  const ask = (): CreationRequest =>
    parseAsk(
      {
        schema: 'midnight-identity/disclosure-request/v1',
        kind: 'creation',
        requester: { name: 'Payroll', rdns: 'example.payroll' },
        purpose: "To finish creating your company's account.",
        nonce: 'n1',
        expiresAt: Date.now() + 60_000,
        company: label,
        account,
        deploy: 'REVQTE9Z',
        insert: Object.entries(SECOND).map(([circuit, k]) => ({ circuit, key: base64.encode(k) }))
      },
      'https://payroll.example',
      Date.now()
    ) as CreationRequest;
  /* What the wallet shows builds no update, so the classes an update is built from are never reached. */
  class BuildsNothing {
    readonly dataToSign = new Uint8Array();
    constructor() {
      throw new Error('nothing is built while the wallet only shows the deploy');
    }
    addSignature(): unknown {
      return undefined;
    }
  }
  const ledgerSending = (ops: Record<string, Uint8Array[]>): CreationLedger => {
    const state = stateHolding(ops);
    const initialState = {
      maintenanceAuthority: { committee: [mine], threshold: 1, counter: 0n },
      serialize: () => new Uint8Array(),
      operations: () => state.operations(),
      operation: (name: string) => state.operation(name)
    };
    const tx = { intents: new Map([[1, { actions: [{ address: account, initialState }] }]]) };
    return {
      Transaction: { deserialize: () => tx },
      signData: L.signData,
      VerifierKeyInsert: BuildsNothing,
      ContractOperationVersionedVerifierKey: BuildsNothing,
      MaintenanceUpdate: BuildsNothing
    };
  };
  const shown = (ops: Record<string, Uint8Array[]>) =>
    creationShown(ledgerSending(ops), founder, ask(), build, sha256, () => label);

  it("SIGNS FOR THIS BUILD'S CIRCUITS, AND REFUSES ONE THAT HOLDS ANOTHER KEY IN ITS OTHER SLOT", () => {
    expect(shown({ adopt: [FIRST.adopt], approve: [FIRST.approve] }).account).toBe(account);
    /* RED WHEN: the deploy's circuits are judged by the one key the ledger's reading shows. */
    expect(() => shown({ adopt: [HIDDEN, FIRST.adopt], approve: [FIRST.approve] })).toThrow(
      /circuits the deploy runs are not this build's/
    );
    /* RED WHEN: a key the page sends whose header names no version the ledger takes is judged as a key at all. */
    const unknown = {
      ...ask(),
      insert: [
        { circuit: 'anchor', key: base64.encode(Uint8Array.from([...enc.encode('midnight:verifier-key[v8]:'), 4, 1])) }
      ]
    };
    expect(() =>
      creationShown(
        ledgerSending({ adopt: [FIRST.adopt], approve: [FIRST.approve] }),
        founder,
        unknown,
        build,
        sha256,
        () => label
      )
    ).toThrow(/not a compiled verifier key of a version the ledger takes/);
  });
});

describe("WHICH RELEASED VERSION A CONTRACT'S KEYS ARE", () => {
  const OLD = keyFile('v3', 23);
  const hexDigest = (k: Uint8Array) => hexOf(sha256(k));
  const version = (n: number, put: Uint8Array, withdrawn: boolean): ReleasedVersion => ({
    version: n,
    reachedFrom: n > 1 ? [n - 1] : [],
    openRunsFinishFirst: false,
    withdrawn,
    keys: {
      account: { adopt: { v3: hexDigest(OLD) } },
      vault: { deposit: { v3: hexDigest(OLD) } },
      registry: { put: { v3: hexDigest(put) } }
    }
  });
  const LIST = [version(2, SHOWN, false), version(1, OLD, true)];

  it('NAMES THE VERSION WHOSE KEYS THE CONTRACT HOLDS EXACTLY, AND REFUSES A HIDDEN KEY, A WITHDRAWN VERSION AND AN UNREADABLE STATE', () => {
    expect(releasedVersionOf(read({ put: [SHOWN] }), 'registry', LIST)).toMatchObject({ released: true, version: 2 });
    /* RED WHEN: a released version is named for keys that hide another one in the other slot. */
    expect(releasedVersionOf(read({ put: [HIDDEN, SHOWN] }), 'registry', LIST).released).toBe(false);
    /* RED WHEN: a withdrawn version is answered as released. */
    const withdrawn = releasedVersionOf(read({ put: [OLD] }), 'registry', LIST);
    expect([withdrawn.released, withdrawn.why]).toEqual([
      false,
      expect.stringMatching(/version 1, which is withdrawn/)
    ]);
    expect(releasedVersionOf(operationsFromContractState(null, 'a1'), 'registry', LIST).released).toBe(false);
    expect(releasedVersionOf(read({ put: [SHOWN] }), 'account', LIST).released).toBe(false);
  });

  it('THE RELEASED LIST IS WELL FORMED, AND A BROKEN ONE IS REFUSED BY NAME', () => {
    expect(releasedListRefusals(RELEASED_VERSIONS)).toEqual([]);
    expect(releasedListRefusals(LIST)).toEqual([]);
    const broken = [version(2, SHOWN, false), { ...version(2, OLD, false), reachedFrom: [7] }];
    /* RED WHEN: a version number used twice, or reached from no listed version, passes. */
    expect(releasedListRefusals(broken)).toEqual(
      expect.arrayContaining([
        'version 2 is listed twice',
        'version 2 is not older than the one before it',
        'version 2 is reached from 7, which is no older version'
      ])
    );
    const badDigest = {
      ...version(1, OLD, false),
      keys: { ...version(1, OLD, false).keys, registry: { put: { v3: 'zz' } } }
    };
    expect(releasedListRefusals([badDigest])).toEqual(['version 1: registry put v3 is not a digest']);
  });
});
