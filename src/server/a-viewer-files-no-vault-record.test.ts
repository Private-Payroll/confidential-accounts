/**
 * **A SEAT WHOSE ROLE FILES NO VAULT RECORD FILES NONE WHEN IT OPENS THE VAULT.**
 *
 * Over real HTTP, with the company's directory and manifest as the service
 * keeps them and every record judged by the one check every device uses. Bo is
 * made a viewer; a third signer is seated in the directory the rebuild seals to,
 * so the vault's newest pool is one a seated signer cannot open. Bo's device
 * rebuilds the vault's notes: it files nothing, and every device still reads
 * the pool.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { newWrappingKeypair, sign, type Hex } from '../core/crypto.js';
import type { Role } from '../core/types.js';
import { SealedNotePool } from '../midnight/vault-pool.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { directoryChangeMessage, type DirectoryChange, type DirectoryFiling } from '../midnight/seat-directory.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { HttpSealedPoolStore, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import { seatHereIn, vaultNotesHere, type RebuildDoors } from 'vaults-web-shared/vault-operation.js';
import { vaultRecordsRoutes } from './vault-records-route.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, acmeDirectoryDeps, ADA, ADDRESS, BO, chains, CO, sendAs, store, vaultRecords, type Seat,
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

/** The next directory version: a role change signed by Ada, the account's one approval. */
const roleChanged = async (seat: string, role: Role) => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'role', seat, role, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(CO, version, unsigned), ADA.signingSecret as Hex);
  const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
  const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
};

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

describe('A VIEWER OPENS A VAULT WHOSE RECORDS A NEW SIGNER CANNOT OPEN YET', () => {
  it('ITS DEVICE FILES NOTHING, AND EVERY DEVICE STILL READS THE POOL', async () => {
    expect(wrapping(ADA).publicKey).toBe(ADA.statement.wrappingKey);
    await new SealedNotePool(recordsOf(ADA)('pool'), { signerId: ADA.seat, wrappingSecret: wrapping(ADA).secret }, seated).create(VAULT, { notes: [] });
    await roleChanged(BO.seat, 'viewer');
    const here = await vaultNotesHere(doorsOf(BO), VAULT);
    /* RED WHEN: a seat whose role files no vault record files the pool again: every device then refuses the newest pool. */
    expect(here.said.join(' ')).toMatch(/seat may not file this vault's records/);
    expect((await vaultRecords.of('pool').versions(VAULT)).length).toBe(1);
    expect((await recordsOf(ADA)('pool').get(VAULT))?.version).toBe(1);
    expect((await new SealedNotePool(recordsOf(BO)('pool'), { signerId: BO.seat, wrappingSecret: wrapping(BO).secret }, seated).load(VAULT)).notes).toEqual([]);
    /* A seat that may file does: the newest pool is filed again, sealed to the new signer too, and still read by every device. */
    const adas = await vaultNotesHere(doorsOf(ADA), VAULT);
    expect(adas.of).toBe('as-filed');
    const now = (await recordsOf(BO)('pool').get(VAULT))!;
    expect(now.version).toBe(2);
    expect(now.wrapped.map((w) => w.signerId)).toContain('carol');
  });

  it('A SEAT THIS DEVICE DOES NOT BELIEVE FILES NOTHING, WHATEVER ROLE ITS DIRECTORY ENTRY NAMES', async () => {
    await roleChanged(BO.seat, 'admin');
    const before = (await vaultRecords.of('pool').versions(VAULT)).length;
    /* Bo, an admin again, is no longer on the account as the chain holds it: no device believes his seat. */
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
