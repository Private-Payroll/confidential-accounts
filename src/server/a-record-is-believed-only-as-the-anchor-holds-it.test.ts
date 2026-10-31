/**
 * **A RECORD A DEVICE READS IS BELIEVED ONLY AS THE ANCHOR ON CHAIN HOLDS IT**:
 * the version its entry names, entered by its own filer, and no older than the
 * newest version the company's records name. A version not yet anchored is
 * believed as not yet anchored, judged by the directory now; one anchored is
 * judged by the directory as it was anchored with it.
 *
 * Over real HTTP with the company's manifest, directory, people and invitation
 * routes as the service keeps them, and a chain of the test's own holding the
 * account's one head, moved on only by the account's own `anchorHeadOf`. The
 * service is made to lie by a wrapper around what a device is sent.
 *
 * The one to read first is "A PERSON'S EARLIER VERSION".
 */
import type { RecordsAsked } from '../midnight/records-held.js';
import { describe, expect, it } from 'vitest';
import { sign, type Hex } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { theNetwork } from '../midnight/network.js';
import { signRunFiling, type RunToFile } from '../core/run-filing.js';
import { sealRecord } from '../core/sealed-records.js';
import { sealedOf, sealPool } from '../midnight/vault-pool.js';
import { signCompanyFiling, signFiling, toCompanyWire, toWire, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { directoryChangeMessage, type DirectoryFiling } from '../midnight/seat-directory.js';
import type { SealedRun } from '../core/types.js';
import { companyRecordEntry, entryIdOf, vaultRecordEntry } from '../midnight/record-manifest.js';
import { anchoredOver, anchorFunctions, heldEntering, anchorSentInATest } from '../testing/record-tree-double.js';
import { enteredHere } from '../testing/records-entered.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import { anchorServiceFor, anchorTheRecordsHere, type AnchorDoors, type Anchored } from 'vaults-web-shared/records-anchored-here.js';
import { inviteHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { readPeopleHere, setStatusHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { signedClaimRefusal } from 'vaults-web-shared/signed-claim-refusal.js';
import {
  believedProposalIdsOnChainHere, believedRunsHere, keptRunHere, proposalsListedHere, runsListedHere, type CompanyRecordsHere,
} from 'vaults-web-shared/run-rebuilt-here.js';
import { openTheRoundHere } from 'vaults-web-shared/round-opened-here.js';
import { FilingNotBelieved, HttpCompanyRecordStore, HttpSealedPoolStore, RecordWithheld, type WireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { directoryHere, directoryJudge } from 'vaults-web-shared/vault-page-doors.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryWithItsFold, acmeDirectory, acmeDirectoryDeps, ACME, ADA, ADDRESS, BO, apiAs, CO, fromAda, KEY, ORIGIN, peopleRecords, personVersions, sendAs,
  store, vaultRecords, type Seat,
} from './a-company-of-two-seats.test-support.js';
/** The day a payee leaves when a test marks them a leaver: their first day, with no month raised yet to leave out. */
const LEFT = { leavingDate: '2026-10-01', pastDraft: async (): Promise<string[]> => [] };

aCompanyOfTwoSeats();

const NETWORK = theNetwork();
/** Ada's device anchoring what is waiting, on the test's chain: the head the readers fold to. */
const anchoredByAda = async (): Promise<Anchored> => {
  const doors: AnchorDoors = {
    accountId: CO, manifest: manifestServiceFor(apiAs('ada')), tree: treeServiceFor(apiAs('ada')),
    material: { signingSecret: ADA.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
    directory: () => acmeDirectoryWithItsFold(), directoryFilings: async () => store.directoryFilingsOf(CO),
    onChain: acmeChain.onChain,
    service: {
      callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
      sendProven: async (_c, tx) => {
        const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
        acmeChain.move(previous, batch, held, tag);
      },
      sealedProposals: async (c) => store.listProposals(c),
      foundingRecords: anchorServiceFor(apiAs('ada')).foundingRecords,
    },
    builder: { ...anchorFunctions, anchor: anchorSentInATest },
  };
  return anchorTheRecordsHere(doors);
};
/** Ada's device reading the company's people, over what `serve` makes of what the service sends. */
const peopleOn = (s: Seat, serve: (body: unknown) => unknown = (b) => b): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, network: NETWORK, claimRefusal: signedClaimRefusal, entered: s.entered,
  directory: acmeDirectory,
  send: async (path, init) => {
    const r = await sendAs(s.person)(path, init);
    return path.endsWith('/people') && init.method === 'GET' ? { ...r, body: serve(r.body) } : r;
  },
});
/** What the service sends, with `id`'s record replaced by `version` of it. */
const serving = (id: string, version: SealedCompanyRecord) => (body: unknown) => ({
  ...(body as object),
  people: ((body as { people: Array<{ filed: { id: string } }> }).people).map((row) => (row.filed.id === id ? { ...row, filed: toCompanyWire(version) } : row)),
});
const pay = { name: 'Pat', email: 'pat@acme.co', title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 500_101n, classification: 'full-time' as const, startDate: '2026-10-01' };

describe('THE COMPANY\'S PEOPLE, READ THROUGH THE ANCHOR', () => {
  let pat = '';
  it('A PERSON\'S EARLIER VERSION, SERVED AFTER A NEWER ONE IS ANCHORED, IS NOT BELIEVED, AND THE ANCHORED ONE IS', async () => {
    pat = (await inviteHere(ACME, ADA, 'employee', pay, ORIGIN, fromAda)).person!;
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === pat)!;
    await setStatusHere(peopleOn(ADA), here, 'leaver', LEFT);
    await anchoredByAda();
    const [first, second] = await personVersions(pat);
    /* RED WHEN: a device believes a version older than the one the anchor holds - a leaver served as still invited. */
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, first!)))).notBelieved).toContain(pat);
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, second!)))).people.find((p) => p.person.id === pat)?.version).toBe(2);
  });

  it('THE NEWEST VERSION NOT YET ANCHORED IS BELIEVED AS SUCH, AND THE ANCHORED ONE SERVED IN ITS PLACE IS NOT THE NEWEST', async () => {
    const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === pat)!;
    await setStatusHere(peopleOn(ADA), here, 'leaver', LEFT);
    const versions = await personVersions(pat);
    /* RED WHEN: a version entered and not yet anchored is refused as forged - every filing would wait a day to be read. */
    expect((await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === pat)?.version).toBe(3);
    /* RED WHEN: the service withholding the newest version, serving the anchored one, goes unseen. */
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, versions[1]!)))).notBelieved).toContain(pat);
  });

  it('A VERSION FILED AND NEVER ENTERED IS NOT BELIEVED, WHOEVER SIGNED IT', async () => {
    const [, , third] = await personVersions(pat);
    /* Ada's own seat signs a fourth version, and nobody enters it. */
    const { filedBy: _signature, ...unsigned } = third!;
    const unentered = signCompanyFiling({ ...unsigned, version: 4 }, ADA.signingSecret as Hex);
    /* RED WHEN: a record no entry names is believed - a filing the service kept and the company's records never saw. */
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, unentered)))).notBelieved).toContain(pat);
  });

  it('A VERSION ANCHORED BEFORE A BATCH THIS DEVICE CANNOT OPEN IS NOT READ AS THE NEWEST: THE BATCH MAY HOLD A NEWER ONE', async () => {
    /* The third version is anchored in a batch of its own; the service then withholds that version's entry. */
    await anchoredByAda();
    const [, second, third] = await personVersions(pat);
    const withholding = async (path: string, init?: RequestInit): Promise<any> => {
      const r = await apiAs('ada')(path, init);
      if (!path.includes('/manifest/tree/headers') || r === null || !Array.isArray(r.entries)) return r;
      return { ...r, entries: r.entries.filter((e: { id: string; version: number }) => !(e.id === pat && e.version === third!.version)) };
    };
    const device = { ...peopleOn(ADA, serving(pat, second!)), directory: (asked?: RecordsAsked) => directoryHere({ ...acmeDirectoryDeps(), anchored: anchoredOver(withholding, CO, acmeChain.read) }, asked) };
    /* RED WHEN: a version anchored before the stop is believed as the newest - an earlier status served while a later one is withheld.
     * No directory is believed past the stop, so nobody is read at all. */
    await expect(readPeopleHere(device)).rejects.toThrow(/cannot be read past a batch this device cannot open/u);
  });

  it('A PERSON THE COMPANY\'S RECORDS NAME AND THE SERVICE LEAVES OUT OF THE LIST IS NOT BELIEVED, NOT READ AS NOBODY', async () => {
    const leftOut = (body: unknown) => ({
      ...(body as object), people: (body as { people: Array<{ filed: { id: string } }> }).people.filter((row) => row.filed.id !== pat),
    });
    const read = await readPeopleHere(peopleOn(ADA, leftOut));
    /* RED WHEN: a person the anchor holds and the service does not list is read as nobody - a leaver or a newcomer unseen. */
    expect(read.notBelieved).toContain(pat);
    expect(read.people.map((p) => p.person.id)).not.toContain(pat);
    /* RED WHEN: a person nothing names is read as withheld - every list would be refused. */
    expect((await readPeopleHere(peopleOn(ADA))).notBelieved).not.toContain(pat);
    /* A person invited and entered, and not yet anchored, left out of the list. */
    const sam = (await inviteHere(ACME, ADA, 'employee', { ...pay, name: 'Sam', email: 'sam@acme.co' }, ORIGIN, fromAda)).person!;
    const samLeftOut = (body: unknown) => ({
      ...(body as object), people: (body as { people: Array<{ filed: { id: string } }> }).people.filter((row) => row.filed.id !== sam),
    });
    /* RED WHEN: a person entered and not yet anchored is read as nobody when the service leaves them out. */
    expect((await readPeopleHere(peopleOn(ADA, samLeftOut))).notBelieved).toContain(sam);
  });

  it('THE ANCHORED BYTES SIGNED AGAIN BY ANOTHER SEAT ARE NOT BELIEVED: THE ENTRY NAMES ITS OWN FILER', async () => {
    const versions = await personVersions(pat);
    const newest = versions[versions.length - 1]!;
    const { filedBy: _ada, ...unsigned } = newest;
    const asBo = signCompanyFiling(unsigned, BO.signingSecret as Hex);
    /* RED WHEN: a record is believed because its bytes are anchored, whoever signs them - the anchor vouches for the entry's own filer only. */
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, asBo)))).notBelieved).toContain(pat);
    expect((await readPeopleHere(peopleOn(ADA, serving(pat, newest)))).people.find((p) => p.person.id === pat)?.version).toBe(newest.version);
  });
});

describe('A RUN, READ AT ITS NEWEST VERSION', () => {
  const RUN = 'run_readnewest01';
  const runOf = (status: string): SealedRun => signRunFiling(CO, {
    id: RUN, accountId: CO, period: '2026-11', status, keyEpoch: 0, payslips: [], proposalIds: [],
    sealed: sealRecord('payroll', CO, { employees: [], totals: {}, proposalIds: {} }, KEY),
  } as unknown as RunToFile, ADA.signingSecret as Hex) as unknown as SealedRun;
  const read = (served: SealedRun) => keptRunHere({ directory: acmeDirectory, runs: async () => [served] } as unknown as CompanyRecordsHere, CO, RUN, KEY);

  it('A RUN SERVED FROM BEFORE ITS NEWER VERSION WAS FILED IS NOT READ; THE NEWEST IS, WHATEVER VERSION NUMBER IT CARRIES', async () => {
    const first = runOf('draft');
    store.putRun(first);
    await ADA.entered.enter([{ store: 'run', run: first }]);
    await anchoredByAda();
    const second = runOf('draft');
    store.putRun(second);
    await ADA.entered.enter([{ store: 'run', run: second }]);
    /* RED WHEN: a list served with a named run at an older version is worked from by any reader the list check covers: a period's runs, what a draw is checked against. */
    const older = { directory: acmeDirectory, runs: async () => [first] } as unknown as CompanyRecordsHere;
    await expect(runsListedHere(older)).rejects.toBeInstanceOf(RecordWithheld);
    await expect(believedRunsHere(older, CO, KEY)).rejects.toBeInstanceOf(RecordWithheld);
    /* RED WHEN: a named run served with no filer's signature passes the list, as if no entry's filer had to have signed it. */
    const unsigned = { directory: acmeDirectory, runs: async () => [{ ...second, filedBy: undefined }] } as unknown as CompanyRecordsHere;
    await expect(runsListedHere(unsigned)).rejects.toThrow(/other bytes than the company's records name: it carries no valid signature/u);
    /* RED WHEN: a run served from before its newer version was filed is read - a run from before a retry was recorded. */
    await expect(read(first)).rejects.toBeInstanceOf(RecordWithheld);
    await expect(read(first)).rejects.toThrow(/the service gave it as other bytes than the company's records name: a newer version of it is in the company's records/u);
    /* RED WHEN: a run is judged at version 1 whatever it is - its newest version, not yet anchored, could never be read. */
    await expect(read(second)).resolves.toMatchObject({ sealed: { id: RUN } });
  });

  it('A RUN THE COMPANY\'S RECORDS NAME AND THE SERVICE LEAVES OUT OF ITS LIST IS REFUSED AS WITHHELD, NOT READ AS NO RUN', async () => {
    /* The service lists no run, though the company's records name this one. */
    const none = { directory: acmeDirectory, runs: async () => [] } as unknown as CompanyRecordsHere;
    /* RED WHEN: a run named and not listed is read as no such run - a period already raised would look free to raise again. */
    await expect(keptRunHere(none, CO, 'run_anyoneelse1', KEY)).rejects.toBeInstanceOf(RecordWithheld);
    await expect(keptRunHere(none, CO, 'run_anyoneelse1', KEY)).rejects.toThrow(new RegExp(`this payroll run \\(${RUN}\\) was not given, and it is not read as absent`, 'u'));
    /* RED WHEN: the runs this device believes are worked out from a list short of one - a period's totals short of a run charged. */
    await expect(believedRunsHere(none, CO, KEY)).rejects.toBeInstanceOf(RecordWithheld);
    await expect(runsListedHere(none)).rejects.toBeInstanceOf(RecordWithheld);
    /* Listed, it is read. */
    const listed = await runsListedHere({ directory: acmeDirectory, runs: async () => store.listRuns(CO) } as never);
    expect(listed.map((r) => r.id)).toContain(RUN);
  });
});

describe('A PROPOSAL THE COMPANY\'S RECORDS NAME, LEFT OUT OF THE LIST', () => {
  const PROPOSAL = 'prp_withheld0001';
  /* The company's records name this proposal, entered by Ada's seat and waiting for the next anchor. */
  const named = async () => {
    const here = await acmeDirectory();
    return {
      ...here,
      records: await heldEntering(CO, [{ entry: { store: 'proposal', kind: 'proposal', id: PROPOSAL, version: 1, digest: 'ab'.repeat(32) }, signingSecret: ADA.signingSecret as Hex }],
        undefined, here),
    };
  };
  it('IS REFUSED AS WITHHELD WHERE IT IS OPENED, AND IN EVERY LIST A DECISION IS MADE FROM, NOT READ AS WITHDRAWN', async () => {
    const records = { directory: named, proposals: async () => [] } as unknown as CompanyRecordsHere;
    const service = { sealedProposals: async () => [] } as never;
    /* RED WHEN: a proposal named and not listed is read as withdrawn - an approver would pass it over while it is still live. */
    await expect(openTheRoundHere(service, CO, PROPOSAL, KEY, false, records)).rejects.toBeInstanceOf(RecordWithheld);
    /* RED WHEN: what a raise or a retry is decided on is read from a list short of a proposal - a live round of the leg unseen. */
    await expect(proposalsListedHere(records as never)).rejects.toThrow(new RegExp(`this proposal \\(${PROPOSAL}\\) was not given`, 'u'));
    await expect(believedProposalIdsOnChainHere(records, CO)).rejects.toBeInstanceOf(RecordWithheld);
  });
});

describe('A VAULT\'S RECORDS, READ THROUGH THE ANCHOR', () => {
  const VAULT = 'd9'.repeat(32);
  const signers = [{ id: ADA.seat, wrappingPublicKey: ADA.statement.wrappingKey }];
  const poolAt = (version: number) => signFiling('pool', sealPool(VAULT, { notes: [] }, signers, version), ADA.signingSecret as Hex);
  /** The page's store, served `served` as the vault's pool records. */
  const pageStore = (served: ReturnType<typeof poolAt>[]) => {
    const send: WireSend = async (path) => (path.endsWith('/versions')
      ? { status: 200, body: { record: 'pool', versions: served.map((r) => toWire('pool', r)) } }
      : { status: 200, body: { record: 'pool', filed: served.length === 0 ? null : toWire('pool', served.at(-1)!) } });
    return new HttpSealedPoolStore('pool', send, ADA.signingSecret as Hex, directoryJudge(acmeDirectoryDeps()), enteredHere());
  };

  it('AN OLDER POOL SERVED AS THE NEWEST, OR A LIST OF VERSIONS CUT SHORT, IS NOT BELIEVED', async () => {
    const one = poolAt(1);
    const two = poolAt(2);
    for (const rec of [one, two]) {
      await vaultRecords.of('pool').put(VAULT, rec);
      await ADA.entered.enter([vaultRecordEntry('pool', rec)]);
    }
    await anchoredByAda();
    /* RED WHEN: a vault record older than the one the anchor holds is believed as the newest - an older pool read as the vault's. */
    await expect(pageStore([one]).get(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    /* RED WHEN: a list of a record's versions the service cut short is believed whole. */
    await expect(pageStore([one]).versions(VAULT)).rejects.toThrow(/an older version than the one the company's records anchor on chain/u);
    expect((await pageStore([one, two]).get(VAULT))?.version).toBe(2);
    expect((await pageStore([one, two]).versions(VAULT)).map((v) => v.version)).toEqual([1, 2]);
  });

  it('A VAULT RECORD THE COMPANY\'S RECORDS NAME AND THE SERVICE DOES NOT GIVE AT ALL IS REFUSED AS WITHHELD, NOT READ AS ABSENT', async () => {
    /* RED WHEN: a record the anchor holds, answered as never filed, is read as absent - a vault's pool read as empty. */
    await expect(pageStore([]).get(VAULT)).rejects.toBeInstanceOf(RecordWithheld);
    await expect(pageStore([]).get(VAULT)).rejects.toThrow(/the company's records name version 2 of it and the service did not give it/u);
    /* RED WHEN: no versions listed, where the anchor holds two, is read as a record with none. */
    await expect(pageStore([]).versions(VAULT)).rejects.toBeInstanceOf(RecordWithheld);
    /* RED WHEN: a record nothing names is refused - a vault never filed could never be read. */
    await expect(pageStore([]).get('ce'.repeat(32))).resolves.toBeNull();
    await expect(pageStore([]).versions('ce'.repeat(32))).resolves.toEqual([]);
  });

  it('A RECORD NOTHING NAMES IS NOT READ AS ABSENT PAST A BATCH THIS DEVICE CANNOT OPEN: THE BATCH MAY NAME IT', async () => {
    const lastBatch = store.keptTreeOf(CO).headers.at(-1)!;
    /* The service leaves out one entry of the last batch the chain holds, so the fold stops there. */
    const withholding = async (path: string, init?: RequestInit): Promise<any> => {
      const r = await apiAs('ada')(path, init);
      if (!path.includes('/manifest/tree/headers') || r === null || !Array.isArray(r.entries)) return r;
      return { ...r, entries: r.entries.filter((e: unknown) => entryIdOf(e as never) !== lastBatch.changes[0]!.leaf.entryId) };
    };
    const judge = directoryJudge({ ...acmeDirectoryDeps(), anchored: anchoredOver(withholding, CO, acmeChain.read) });
    const send: WireSend = async () => ({ status: 200, body: { record: 'pool', filed: null } });
    /* RED WHEN: a record no opened batch names is read as absent while a batch the device cannot open may name it. */
    await expect(new HttpSealedPoolStore('pool', send, ADA.signingSecret as Hex, judge, enteredHere()).get('ce'.repeat(32)))
      .rejects.toThrow(/cannot be read past a batch this device cannot open/u);
  });

  it('A VERSION FILED AND NEVER ENTERED IS ANCHORED PAST: THE LIST SAYS IT, NEVER BELIEVES IT, AND ITS LATE ENTRY IS SUPERSEDED', async () => {
    /* Version 3 is filed and its entry never entered; version 4 is filed and entered, and anchored. */
    const three = poolAt(3);
    await vaultRecords.of('pool').put(VAULT, three);
    const four = poolAt(4);
    await vaultRecords.of('pool').put(VAULT, four);
    await ADA.entered.enter([vaultRecordEntry('pool', four)]);
    await anchoredByAda();
    const kept = (await vaultRecords.of('pool').versions(VAULT)).map((v) => sealedOf(v) as ReturnType<typeof poolAt>);
    /* RED WHEN: one version whose entry is lost holds every later version unanchored - the vault's newest pool never read again. */
    expect((await pageStore(kept).get(VAULT))?.version).toBe(4);
    /* RED WHEN: the list of versions throws on the version passed over (a freeze), or skips it silently, or gives its bytes. */
    const listed = await pageStore(kept).versions(VAULT);
    expect(listed.map((v) => [v.version, v.neverEntered === true])).toEqual([[1, false], [2, false], [3, true], [4, false]]);
    expect(listed[2]!.sealed).toBeUndefined();
    /* RED WHEN: a list whose newest is the version passed over is read whole - the service withholding version 4. */
    await expect(pageStore(kept.slice(0, 3)).versions(VAULT)).rejects.toBeInstanceOf(FilingNotBelieved);
    /* RED WHEN: the version's entry, arriving after a later one, is entered, or its filer is told to file it again. */
    await expect(ADA.entered.enter([vaultRecordEntry('pool', three)])).rejects.toThrow(/version 3 of vault record .* was superseded: version 4 of it is already in the company's records/u);
    await expect(ADA.entered.enter([vaultRecordEntry('pool', three)])).rejects.toThrow(/read the record again for the version that stands/u);
    /* RED WHEN: Ada's page enters its superseded filing again at every anchor, or lets go of it without telling her. */
    expect((await anchoredByAda()).superseded).toEqual([expect.stringMatching(/version 3 of vault record .* was superseded: version 4/u)]);
    expect((await anchoredByAda()).superseded).toBeUndefined();
  });
});

describe('A SEAT\'S ANCHORED RECORDS, READ AFTER ITS ROLE CHANGES', () => {
  it('A PERSON A SEAT FILED AND THE ANCHOR HOLDS IS STILL READ AFTER THAT SEAT MAY NO LONGER FILE ONE', async () => {
    const q = (await inviteHere(ACME, ADA, 'employee', { ...pay, name: 'Quinn', email: 'quinn@acme.co', baseAmount: 500_102n }, ORIGIN, fromAda)).person!;
    await anchoredByAda();
    /* RED WHEN: a directory served older than the one anchored is believed - a seat's role or retirement could be hidden from a device. */
    const served = store.directoryFilingsOf(CO);
    await expect(directoryHere({ ...acmeDirectoryDeps(), filings: async () => served.slice(0, -1) }))
      .rejects.toThrow(new RegExp(`the company's directory was served without version ${served.length}, which the company's records anchor on chain`, 'u'));
    /* A quorum of one makes Ada an approver: she may no longer file a person. */
    const version = store.directoryFilingsOf(CO).length + 1;
    const unsigned = { kind: 'role', seat: ADA.seat, role: 'approver', threshold: 1, signatures: [] } as const;
    const signature = sign(directoryChangeMessage(CO, version, unsigned as never), ADA.signingSecret);
    const filing = { company: CO, version, change: { ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature }] } } as DirectoryFiling;
    expect((await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) })).status).toBe(201);
    /* RED WHEN: an anchored record is judged by its filer's role now - every person Ada ever filed would stop being read. */
    expect((await readPeopleHere(peopleOn(ADA))).people.map((p) => p.person.id)).toContain(q);
  });
});

describe('A COMPANY RECORD\'S VERSIONS, ONE OF THEM NEVER ENTERED', () => {
  /** The next version of a proposal record Ada's device files, sealed to her seat. */
  const filedByAda = async (id: string) => {
    const version = (await peopleRecords.versions(CO, 'proposal', id)).length + 1;
    const rec = signCompanyFiling({
      company: CO, kind: 'proposal', id, version, keyEpoch: 0, sealed: { iv: id, tag: String(version), body: 'ada' },
      wrapped: [{ signerId: ADA.seat, wrapped: { ephemeral: 'ee'.repeat(32) as Hex, iv: 'i', tag: 't', body: 'b' } }],
    } as never, ADA.signingSecret as Hex);
    await peopleRecords.put(rec);
    return companyRecordEntry(rec);
  };
  it('THE LIST SAYS THE VERSION PASSED OVER, WITHOUT ITS BYTES, AND BELIEVES THE REST', async () => {
    /* Ada is an approver by now, whose role files a company proposal record. */
    const ID = 'prp_passedover2';
    await ADA.entered.enter([await filedByAda(ID)]);
    /* Version 2 is filed and its entry never entered; version 3 is filed and entered. */
    await filedByAda(ID);
    await ADA.entered.enter([await filedByAda(ID)]);
    await anchoredByAda();
    const device = new HttpCompanyRecordStore(CO, (path, init) => sendAs('ada')(path, init as never), ADA.signingSecret as Hex, directoryJudge(acmeDirectoryDeps()));
    /* RED WHEN: the company record's list throws on the version passed over (a freeze), skips it silently, or gives its bytes. */
    const listed = await device.versions('proposal', ID);
    expect(listed.map((v) => [v.version, 'neverEntered' in v])).toEqual([[1, false], [2, true], [3, false]]);
    expect(listed[1]).not.toHaveProperty('sealed');
    expect((await device.get('proposal', ID))?.version).toBe(3);
  });
});
