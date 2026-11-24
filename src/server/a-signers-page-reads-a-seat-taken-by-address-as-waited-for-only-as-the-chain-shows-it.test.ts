/**
 * A signer opening the company through the page's own read of its signers, while a seat taken by address waits for
 * Finish adding, reads that seat as waited for and as no believed signer; a seat the chain holds that nobody waits for is
 * still refused there, and so is one waited for on an invitation for another company, on one a key that is no seat signed,
 * or on a proposal the chain shows took a seat whose own entry the directory holds.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { toHex, type Hex } from '../core/crypto.js';
import type { SealedProposal } from '../core/types.js';
import { sealRoster } from '../core/roster-record.js';
import { vaultKeyIndexOf } from '../core/vault-keys.js';
import { signCompanyFiling, toCompanyWire } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { approveSeatInvitationOnDevice } from 'vaults-web-shared/seat-invited-on-device.js';
import { rosterHere, RosterNotBelieved } from 'vaults-web-shared/roster-here.js';
import { admitSignerHere } from 'vaults-web-shared/roster-filed-here.js';
import { companyJudges } from 'vaults-web-shared/company-judges.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { PROPOSALS_NOT_READ, SEAT_READ_STOP, SeatingRefusedOnTheChain, TWO_SEATINGS } from 'vaults-web-shared/seat-not-read-on-the-chain.js';
import { seatingRefusedRead } from 'vaults-web-shared/roster-seating-refused.js';
import { acmeReads, seatsTakenByInvitation } from './a-company-of-two-seats.test-support.js';
import { aCompanyWhoseSignersChange, ADA, api, BO, chains, CO, companyNow, CY, ID, KEY, LABEL, rosterDoorsOf, sendAs } from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { freshViews, inviteAddressOf, seatingDevice, withCommitments, EVE, SAM, TOM, XAN, openedOnThePage, servedWithInvitation, invited, seatTaken, seated } from './a-signer-invited-by-address.test-support.js';
aCompanyWhoseSignersChange();

describe('A SIGNER\'S PAGE READS A SEAT TAKEN BY ADDRESS AS WAITED FOR ONLY AS THE CHAIN SHOWS IT', () => {

  beforeAll(async () => {
    await seated(EVE);
  }, 120_000);

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('a signer opens the company while a seat taken by address waits for Finish adding, and then admits it', { timeout: 120_000 }, async () => {
    const sam = await invited(SAM);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: sam.shown }, inviteAddressOf);
    const signerId = await seatTaken(SAM, sam);
    const stop = async (o: Parameters<typeof openedOnThePage>[1]) => {
      const e = await openedOnThePage(ADA, o)().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RosterNotBelieved);
      const r = e as RosterNotBelieved;
      return { check: r.check, followable: r.followable, stoppedBy: r.stoppedBy, said: r.message, held: seatingRefusedRead(e) };
    };
    const unread = await stop({ took: async () => { throw new Error('the indexer did not answer'); } });
    /* RED WHEN: a signer's page that cannot read which seat an invitation's proposal took refuses the roster without saying what stopped it. */
    expect(unread.stoppedBy).toContain(SEAT_READ_STOP.notRead);
    /* RED WHEN: a page that could not read the chain refuses the roster as leaving a seat out, sending the signer to ask another device, in place of reading again. */
    expect([unread.check, unread.followable]).toEqual(['chain-unread', null]);
    expect(unread.said).toMatch(/Reload the page to check again/u);
    /* RED WHEN: a wallet that names no indexer is told to read again, which cannot resolve it, in place of what can. */
    const noIndexerRead = await stop({ noIndexer: true });
    /*
     * Every invited seat's leaf is read from the chain, so a wallet that names no indexer stops at the company's own
     * directory, before the roster's seats are counted: the stop says so, and what clears it.
     */
    expect([noIndexerRead.check, noIndexerRead.followable, noIndexerRead.stoppedBy.includes(SEAT_READ_STOP.noIndexer)]).toEqual(['filer-not-checked', null, true]);
    expect([/check its network/u.test(noIndexerRead.said), /to read again|press again/iu.test(noIndexerRead.said)]).toEqual([true, false]);
    /* RED WHEN: two seats taken under one invitation's proposal are told as a read to make again, which never clears it, or the roster is followed past them. */
    const refused = await stop({ took: async () => { throw new SeatingRefusedOnTheChain(TWO_SEATINGS); } });
    expect([refused.check, refused.followable, refused.stoppedBy.includes(SEAT_READ_STOP.refused)]).toEqual(['seating-refused', null, true]);
    expect([/will not change it/u.test(refused.said), /Reload the page/u.test(refused.said)]).toEqual([true, false]);
    /* RED WHEN: the stop drops the seat it could not tell, so the removal that clears it cannot name the seat it may take. */
    const samsSeat = seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase());
    /*
     * The seats it could not tell are every seat the chain holds that no active entry names: Sam's, and any other seat the
     * chain holds that no active entry names.
     */
    const named = new Set(companyNow().signers.filter((x) => x.status === 'active').map((x) => String(x.leafCommitment).toLowerCase()));
    const leftOut = [...seatsTakenByInvitation.values()].map((leaf) => leaf.toLowerCase()).filter((leaf) => !named.has(leaf));
    expect(leftOut).toContain(samsSeat);
    expect([...(refused.held?.unread ?? [])].sort()).toEqual(leftOut.sort());
    /* RED WHEN: a stop for any other reason carries a read to count a removal from. */
    expect([unread.held, noIndexerRead.held]).toEqual([null, null]);
    /* RED WHEN: a wallet that names no indexer is read as an answer that no invitation's proposal took a seat. */
    const noIndexer = companyJudges({
      view: freshViews(api(ADA.person)), keysFor: () => null, servedKeyFor: () => KEY as Hex, indexer: async () => null,
      builder: async () => ({ invitedSeats: async () => ({}) }) as never, released: () => null, askReleased: async () => null, treeKept: () => treeKeptInMemory() as never,
      openAccount: async () => null, seatsAdmittedFor: async () => new Set(), noAccount: () => { throw new Error('unused'); },
    }).rosterReadsFor(CO, LABEL, '00'.repeat(32) as never).invitedSeats!([sam.offer.invited.terms.proposal!.toLowerCase()]);
    await expect(noIndexer).rejects.toMatchObject({ name: SEAT_READ_STOP.noIndexer });
    /* RED WHEN: a signer's page reads a seat the chain holds, taken on an invitation by address whose request waits for Finish adding, as a seat the roster leaves out. */
    const waiting = await openedOnThePage(ADA)();
    /* RED WHEN: the stop drops the signers it believed, or keeps one a read that does not stop refuses, so the removal that clears it miscounts who approves it. */
    expect(refused.held?.account.signers.filter((x) => x.status === 'active').map((x) => x.name))
      .toEqual(waiting?.signers.filter((x) => x.status === 'active').map((x) => x.name));
    expect(refused.held?.account.signers.length).toBeGreaterThan(0);
    /* RED WHEN: a seat on the chain no believed signer names is not listed as left out by the stop, so a count would go ahead past it. */
    expect(refused.held?.account.notBelieved).toEqual(waiting?.notBelieved);
    expect(waiting?.signers.some((x) => x.name === SAM.name && x.status === 'active')).toBe(false);
    /* RED WHEN: the seat that waits is read as a believed signer, so a committee or a reader list is built from a roster that does not name it. */
    expect(waiting?.notBelieved).toContain(seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase()));
    /* RED WHEN: the company the page opens does not carry the seats its roster read waits for, so the page cannot list them. */
    expect(waiting?.waited).toContain(seatsTakenByInvitation.get(sam.offer.invited.terms.proposal!.toLowerCase()));
    expect(waiting?.signers.find((x) => x.id === ID[ADA.person])?.status).toBe('active');
    await admitSignerHere(withCommitments(ADA), { signerId, readOut: '', name: SAM.name });
    /* RED WHEN: a signer's page refuses the whole roster once Finish adding admits a seat taken by address, before its signer files their own entry. */
    const admitted = await openedOnThePage(ADA)();
    expect(admitted?.refused.find((x) => x.name === SAM.name)?.why).toBe('no-entry-of-their-own');
    expect(admitted?.signers.find((x) => x.id === ID[ADA.person])?.status).toBe('active');
  });

  it('RED WHEN: a signer\'s page believes a roster that leaves out a seat the chain holds and nobody waits for', async () => {
    const was = chains.get(CO)!;
    const stray = '5e'.repeat(32);
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [...was.seats.seats, stray], committee: [...was.seats.committee, was.seats.committee[0]!] } });
    try {
      const refused = await openedOnThePage(ADA)().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect(String((refused as Error).message)).toMatch(/it has no entry for 1 seat\(s\) the company's account holds on the chain/u);
      expect((refused as RosterNotBelieved).check).toBe('seat-unnamed');
    } finally {
      chains.set(CO, was);
    }
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain, which hashes the signers' tree again on every call: about 7 s alone and more beside a parallel run, so it has the longest limit this folder uses. */
  it('RED WHEN: a signer\'s page reads a seat taken by address as waited for on an invitation for another company, or one signed by a key that is no seat', { timeout: 120_000 }, async () => {
    const tom = await invited(TOM);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: tom.shown }, inviteAddressOf);
    await seatTaken(TOM, tom);
    const leaf = seatsTakenByInvitation.get(tom.offer.invited.terms.proposal!.toLowerCase());
    /* The request Tom's wallet filed is not served, so his seat is waited for only through the proposal that seated it. */
    const proposalsAre = (list: (all: SealedProposal[]) => unknown[]) => (path: string, body: any) => {
      if (path === `/api/accounts/${CO}`) return { ...body, pendingSigners: [] };
      return path === `/api/accounts/${CO}/proposals` ? list(body as SealedProposal[]) : body;
    };
    const waiting = await openedOnThePage(ADA, { served: proposalsAre((all) => all) })();
    expect(waiting?.notBelieved).toContain(leaf);
    for (const forged of [
      await servedWithInvitation(tom, { company: 'acc_anothercompany' }, ADA.signingSecret as Hex),
      await servedWithInvitation(tom, {}, toHex(new Uint8Array(32).fill(9)) as Hex),
    ]) {
      const refused = await openedOnThePage(ADA, { served: proposalsAre((all) => all.map((p) => (p.id === tom.proposal.id ? forged : p))) })()
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect((refused as RosterNotBelieved).check).toBe('seat-unnamed');
    }
  });

  /* Raises a proposal, approves it and seats a signer through the simulated chain: about 7 s alone, so it has the longest limit this folder uses. */
  it('a signer\'s page whose read of the company\'s proposals, or of the seat an invitation by address took, failed stops in place of reading the seat as left out', { timeout: 120_000 }, async () => {
    const xan = await invited(XAN);
    await approveSeatInvitationOnDevice(seatingDevice(BO), { viewingKey: KEY, shown: xan.shown }, inviteAddressOf);
    await seatTaken(XAN, xan);
    const proposal = xan.offer.invited.terms.proposal!.toLowerCase();
    /* The request Xan's wallet filed is not served, so the seat is waited for only through the proposal that seated it. */
    const noRequest = (proposals: (body: unknown) => unknown) => (path: string, body: any) => {
      if (path === `/api/accounts/${CO}`) return { ...body, pendingSigners: [] };
      return path === `/api/accounts/${CO}/proposals` ? proposals(body) : body;
    };
    const stopped = async (o: Parameters<typeof openedOnThePage>[1]) => {
      const e = await openedOnThePage(ADA, o)().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RosterNotBelieved);
      return [(e as RosterNotBelieved).check, (e as RosterNotBelieved).followable, (e as RosterNotBelieved).stoppedBy];
    };
    /* RED WHEN: a read of the company's proposals that failed is taken as no invitation, so the roster is refused as leaving the seat out and followed. */
    expect(await stopped({ served: noRequest(() => { throw new Error('the service answered with an error'); }) })).toEqual(['chain-unread', null, [PROPOSALS_NOT_READ]]);
    /* RED WHEN: a read of the seat the served invitation's proposal took that failed is taken as no seat taken, with no request waiting to say so. */
    const took = async (asked: readonly string[]) => {
      if (asked.includes(proposal)) throw new Error('the indexer did not answer');
      return acmeReads.invitedSeats(asked);
    };
    expect(await stopped({ served: noRequest((body) => body), took })).toEqual(['chain-unread', null, [SEAT_READ_STOP.notRead]]);
    /* Read whole, the seat is waited for. */
    expect((await openedOnThePage(ADA, { served: noRequest((body) => body) })())?.waited).toContain(seatsTakenByInvitation.get(proposal));
  });

  it('RED WHEN: a signer\'s page reads a seat whose own entry the directory holds as waited for, because the chain shows a proposal by address took it', async () => {
    const was = chains.get(CO)!;
    const stray = '5f'.repeat(32);
    const now = await rosterHere(rosterDoorsOf(ADA));
    const fileRoster = async (signers: typeof now.carried.signers, version: number) => {
      const rec = signCompanyFiling(sealRoster(CO, { name: now.carried.name, signers }, version, 0, KEY as Hex), ADA.signingSecret as Hex);
      const filed = await sendAs(ADA.person)(`/api/accounts/${CO}/roster`, {
        method: 'POST', body: JSON.stringify({ roster: { version, message: toCompanyWire(rec) }, folded: [], index: vaultKeyIndexOf({ id: CO, signers }) }),
      });
      expect(filed.status).toBe(201);
      await ADA.entered.enter([companyRecordEntry(rec)]);
    };
    const seated = now.carried.signers.filter((x) => x.status === 'active');
    /* Ada files a roster that leaves out Cy, whose own entry the directory holds, and the chain holds a seat nobody waits for. */
    await fileRoster(seated.filter((x) => x.id !== ID[CY.person]), now.version + 1);
    chains.set(CO, { ...was, seats: { ...was.seats, seats: [...was.seats.seats, stray], committee: [...was.seats.committee, was.seats.committee[0]!] } });
    /* A proposal by address whose seat the roster names as an active signer, so only Cy's reading of it changes. */
    const named = new Set(seated.map((x) => String(x.leafCommitment).toLowerCase()));
    const proposal = [...seatsTakenByInvitation].find(([, leaf]) => named.has(leaf.toLowerCase()))![0];
    try {
      /* The chain is shown to have seated Cy from that proposal by address; every other proposal took the seat it did. */
      const took = async (asked: readonly string[]) => ({ ...(await acmeReads.invitedSeats(asked)), ...(asked.includes(proposal) ? { [proposal]: CY.seat.toLowerCase() } : {}) });
      const refused = await openedOnThePage(ADA, { took })().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(RosterNotBelieved);
      expect(String((refused as Error).message)).toMatch(/it has no entry for 2 seat\(s\) the company's account holds on the chain/u);
    } finally {
      chains.set(CO, was);
      await fileRoster(seated, now.version + 2);
    }
  });
});
