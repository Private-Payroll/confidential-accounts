/**
 * **A SEAT NO DEVICE BELIEVES FILES NO VAULT RECORD WHEN IT OPENS THE VAULT.**
 *
 * Over real HTTP, with the company's directory and manifest as the service
 * keeps them and every record judged by the one check every device uses. A
 * third signer is seated in the directory the rebuild seals to, so the vault's
 * newest pool is one a seated signer cannot open: a seat that may file files it
 * again, and a seat the chain no longer holds files nothing.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import { SealedNotePool } from '../midnight/vault-pool.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import { seatHereIn, vaultNotesHere, type RebuildDoors } from 'vaults-web-shared/vault-operation.js';
import { vaultRecordsRoutes } from './vault-records-route.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, acmeDirectoryDeps, ADA, ADDRESS, BO, chains, CO, sendAs, vaultRecords, type Seat,
} from './a-company-of-two-seats.test-support.js';

aCompanyOfTwoSeats((app) => {
  app.use('/api/vaults', express.json({ limit: '1mb' }));
  app.use(vaultRecordsRoutes({ records: vaultRecords, mayTouch: async () => true }));
});

const VAULT = 'd8'.repeat(32) as Hex;
const wrapping = (s: Seat) => recordsKeypairFrom(new Uint8Array(32).fill(s.n + 100));
const recordsOf = (s: Seat) => (r: WireRecord) =>
  new HttpSealedPoolStore(r, sendAs(s.person) as unknown as WireSend, s.signingSecret as Hex, directoryJudge(acmeDirectoryDeps()), s.entered);
const CAROL = newWrappingKeypair();
const seated = async () => [
  { id: ADA.seat, wrappingPublicKey: ADA.statement.wrappingKey },
  { id: BO.seat, wrappingPublicKey: BO.statement.wrappingKey },
];

const doorsOf = (s: Seat): RebuildDoors => ({
  account: ADDRESS, onChain: async () => ({ holders: { adoptedVaults: [VAULT] } as never }),
  indexer: async () => ({ indexerUri: 'https://indexer.example/api', indexerWsUri: 'wss://indexer.example/ws' }),
  builder: {
    vaultOnChain: async () => ({
      onChain: true, state: '', notes: [], notesFromThisBuild: true, everCreated: [], account: ADDRESS, started: true,
      nonceCommitment: '5c'.repeat(32), splitJournal: [],
    }),
    commitments: async (i) => ({ output: '', held: `h${i.coin.nonce}` }),
    creatingTransaction: async () => ({ state: 'refused' }),
    eventsOf: async () => [],
    createdBy: async () => null,
  },
  me: { signerId: s.seat, wrappingSecret: wrapping(s).secret, companyKey: new Uint8Array(32).fill(s.n + 100) },
  records: recordsOf(s),
  /* The signers the rebuild seals to: the directory's two seats, and a third just seated. */
  signers: async () => [...await seated(), { id: 'carol', wrappingPublicKey: CAROL.publicKey }],
  seatHere: () => seatHereIn(acmeDirectory, s.signingSecret as Hex),
});

describe('A SEAT OPENS A VAULT WHOSE RECORDS A NEW SIGNER CANNOT OPEN YET', () => {
  it('A SEAT THAT MAY FILE FILES THE NEWEST POOL AGAIN, SEALED TO THE NEW SIGNER TOO, AND EVERY DEVICE STILL READS IT', async () => {
    expect(wrapping(ADA).publicKey).toBe(ADA.statement.wrappingKey);
    await new SealedNotePool(recordsOf(ADA)('pool'), { signerId: ADA.seat, wrappingSecret: wrapping(ADA).secret }, seated).create(VAULT, { notes: [] });
    expect((await recordsOf(ADA)('pool').get(VAULT))?.version).toBe(1);
    /* RED WHEN: a seat that may file leaves the newest pool sealed short of a seated signer. */
    const adas = await vaultNotesHere(doorsOf(ADA), VAULT);
    expect(adas.of).toBe('as-filed');
    const now = (await recordsOf(BO)('pool').get(VAULT))!;
    expect(now.version).toBe(2);
    expect(now.wrapped.map((w) => w.signerId)).toContain('carol');
  });

  it('A SEAT THIS DEVICE DOES NOT BELIEVE FILES NOTHING, WHATEVER ROLE ITS DIRECTORY ENTRY NAMES', async () => {
    const before = (await vaultRecords.of('pool').versions(VAULT)).length;
    /* Bo is no longer on the account as the chain holds it: no device believes his seat. */
    const held = chains.get(CO)!;
    chains.set(CO, { ...held, seats: { ...held.seats, committee: [ADA.committeeKey], seats: [ADA.seat] } });
    try {
      const here = await vaultNotesHere({ ...doorsOf(BO), signers: async () => [...await seated(), { id: 'dan', wrappingPublicKey: CAROL.publicKey }] }, VAULT);
      /* RED WHEN: the rebuild asks only the role its directory entry names, and a seat no device believes files the pool. */
      expect(here.said.join(' ')).toMatch(/seat may not file this vault's records/);
      expect((await vaultRecords.of('pool').versions(VAULT)).length).toBe(before);
    } finally {
      chains.set(CO, held);
    }
  });
});
