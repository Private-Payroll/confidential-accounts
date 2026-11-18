// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Buffer as PolyfillBuffer } from 'buffer/';
import { firstValueFrom } from 'rxjs';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';
import { identityFromWords } from 'midnight-identity';
import type { Identity } from 'midnight-identity';
import { startRehearsal } from './rehearsal.js';
import type { Rehearsal } from './rehearsal.js';

/*
 * THE VERSION EACH PART OF A REHEARSED WALLET REPORTS AFTER IT HAS SYNCED THE PRETEND CHAIN.
 *
 * On the live fork schedule ledger-v9 starts well after the first version, and the facade stamps what it builds with
 * the lowest version its three parts report. A rehearsal that runs the live schedule is only a rehearsal of the wallet
 * if every part reports the version the chain is on once it has synced, and one held on the earlier ledger is caught.
 */

(globalThis as { Buffer?: unknown }).Buffer = PolyfillBuffer;

const ours: Identity = identityFromWords(TEST_MNEMONIC);
const LEDGER_NINE = DefaultForkSchedule.v9;

/** What each part, and the facade over them, reports. */
const reported = async (r: Rehearsal) => ({
  facade: (await firstValueFrom(r.facade.state())).activeProtocolVersion,
  shielded: (await firstValueFrom(r.facade.shielded.state)).protocolVersion,
  unshielded: (await firstValueFrom(r.facade.unshielded.state)).protocolVersion,
  dust: (await firstValueFrom(r.facade.dust.state)).protocolVersion,
});

describe('a rehearsal on the live fork schedule stamps each part with the version the chain is on', () => {
  it('a wallet synced past ledger-v9 reports ledger-v9\'s version in all three parts and in the facade', async () => {
    const rehearsal = await startRehearsal(ours, 0, { ledgerNineFrom: LEDGER_NINE, chainVersion: LEDGER_NINE, withoutDust: true });
    try {
      /* RED WHEN: the private or the DUST part is still reported at the first version after it has synced past ledger-v9,
       * which makes the facade stamp everything it builds with the first version and refuse it. */
      expect(await reported(rehearsal)).toEqual({ facade: LEDGER_NINE, shielded: LEDGER_NINE, unshielded: LEDGER_NINE, dust: LEDGER_NINE });
    } finally { await rehearsal.stop(); }
  });

  it('a wallet held on the earlier ledger, with the chain not yet past ledger-v9, is reported below it', async () => {
    const rehearsal = await startRehearsal(ours, 0, { ledgerNineFrom: LEDGER_NINE, withoutDust: true });
    try {
      /* RED WHEN: a wallet the chain has not carried to ledger-v9 is reported as having reached it. */
      expect((await reported(rehearsal)).facade).toBeLessThan(LEDGER_NINE);
    } finally { await rehearsal.stop(); }
  });

  it('a rehearsal that pays for DUST on the live schedule is refused while the chain is still on the earlier ledger', async () => {
    /* RED WHEN: the live schedule is not given to the facade, so a rehearsal of a wallet the chain has not carried to
     * ledger-v9 starts as though it had. */
    await expect(startRehearsal(ours, 0, { ledgerNineFrom: LEDGER_NINE })).rejects.toThrow(/stamped 0|protocol version 0/u);
  });
});
