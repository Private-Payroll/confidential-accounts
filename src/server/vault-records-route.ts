/**
 * **WHERE THE PRODUCT'S SERVER KEEPS A VAULT'S SEALED RECORDS FOR THE PAGE -
 * AND NOTHING HERE CAN OPEN ONE.**
 *
 * The server stores and serves sealed bytes. It checks what any store checks
 * (the version follows the newest, the bytes are the bytes the digest names,
 * the record is a sealed record for this vault) and it never holds a key that
 * could open one: no signer's secret reaches this process, in any form, which
 * is what keeps the claim that this server cannot read a balance true.
 *
 * **WHO MAY READ OR FILE IS A REQUIRED ARGUMENT, WITH NO DEFAULT.** A route that
 * let any signed-in person file a version for any vault would let one forged
 * record make a vault read as empty. So the router is built only with an
 * answer to that question, and it is mounted behind the sign-in, which sets
 * the person every decision here is about.
 */
import express from 'express';
import type { SealedPoolStore } from '../midnight/vault-pool.js';
import {
  assertWireRecord, assertWireVault, assertWireVersionNumber,
  fromWire, toWire, type WireFiled, type WireRecord, type WireRefusal,
} from '../midnight/sealed-record-wire.js';

/** Whether this person may read, or file, this record of this vault. */
export type MayTouchVaultRecords = (
  person: string, vault: string, record: WireRecord, act: 'read' | 'file',
) => Promise<boolean>;

export const vaultRecordsRoutes = (deps: {
  readonly records: { of(record: WireRecord): SealedPoolStore };
  readonly mayTouch: MayTouchVaultRecords;
}): express.Router => {
  if (typeof deps?.mayTouch !== 'function') {
    throw new Error('the vault records route is built only with an answer to who may read and file which vault\x27s records');
  }
  const router = express.Router();

  const gate = async (req: express.Request, res: express.Response, act: 'read' | 'file') => {
    const person = (req as { userId?: unknown }).userId;
    if (typeof person !== 'string' || person.length === 0) {
      res.status(401).json({ error: 'a vault\x27s records are reached only by a signed-in person' });
      return null;
    }
    let vault: string;
    let record: WireRecord;
    try {
      vault = assertWireVault(req.params.vault);
      record = assertWireRecord(req.params.record);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return null;
    }
    if (!(await deps.mayTouch(person, vault, record, act))) {
      res.status(403).json({ error: `this person may not ${act} this vault\x27s ${record}` });
      return null;
    }
    return { vault, record, store: deps.records.of(record) };
  };

  const unreadable = (res: express.Response, e: unknown) =>
    res.status(502).json({ error: `the record could not be read: ${(e as Error)?.message ?? String(e)}` });

  router.get('/api/vaults/:vault/records/:record', async (req, res) => {
    const g = await gate(req, res, 'read');
    if (!g) return;
    try {
      const sealed = await g.store.get(g.vault);
      res.status(200).json({ record: g.record, filed: sealed === null ? null : toWire(g.record, sealed) });
    } catch (e) { unreadable(res, e); }
  });

  router.get('/api/vaults/:vault/records/:record/versions', async (req, res) => {
    const g = await gate(req, res, 'read');
    if (!g) return;
    try {
      const filed = await g.store.versions(g.vault);
      res.status(200).json({ record: g.record, versions: filed.map((v) => toWire(g.record, v.sealed)) });
    } catch (e) { unreadable(res, e); }
  });

  router.put('/api/vaults/:vault/records/:record/:version', async (req, res) => {
    const g = await gate(req, res, 'file');
    if (!g) return;
    let version: number;
    let sealed;
    let digest: string;
    try {
      version = assertWireVersionNumber(req.params.version);
      const got = fromWire(req.body, { vault: g.vault, record: g.record, version });
      sealed = got.sealed;
      digest = got.wire.digest;
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    /*
     * The version this filing may take, decided from the newest one filed. The
     * store decides again, atomically, when it files; this answers the two
     * ordinary refusals in the words both ends share, before anything is sent
     * to it.
     */
    let next: number;
    try {
      next = ((await g.store.get(g.vault))?.version ?? 0) + 1;
    } catch (e) { unreadable(res, e); return; }
    if (version < next) {
      const refusal: WireRefusal = { refused: 'version-already-filed', record: g.record, version };
      res.status(409).json(refusal);
      return;
    }
    if (version > next) {
      const refusal: WireRefusal = {
        refused: 'not-the-next-version', record: g.record, version,
        why: `the next version of this record is ${next}, so nothing has been written. Read the record again and build the change on what it holds now.`,
      };
      res.status(422).json(refusal);
      return;
    }
    try {
      await g.store.put(g.vault, sealed);
    } catch (e) {
      if ((e as Error)?.name === 'VaultPoolVersionAlreadyFiled') {
        const refusal: WireRefusal = { refused: 'version-already-filed', record: g.record, version };
        res.status(409).json(refusal);
        return;
      }
      res.status(503).json({
        error: `version ${version} was not confirmed filed: ${(e as Error)?.message ?? String(e)}`,
      });
      return;
    }
    const filed: WireFiled = { filed: true, record: g.record, version, digest };
    res.status(201).json(filed);
  });

  return router;
};
