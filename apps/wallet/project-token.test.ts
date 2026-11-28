import { describe, expect, it } from 'vitest';
import { NETWORK_IDS, networkRecord } from '../../src/core/networks.js';
import { projectTokenSettings } from './project-token.js';

const asking = NETWORK_IDS.filter((id) => networkRecord(id).endpoints?.projectToken);

describe('a wallet built for a network that asks for a project token carries that token and no other', () => {
  it("THE BUILT NETWORK'S TOKEN, UNDER THE ONE SETTING ITS RECORD NAMES, AND NOTHING ELSE", () => {
    /* RED WHEN no network asks for a token, so the build below proves nothing. */
    expect(asking.length).toBeGreaterThan(0);
    for (const id of asking) {
      const { setting } = networkRecord(id).endpoints!.projectToken!;
      const asked: string[] = [];
      const settings = projectTokenSettings(id, (name) => {
        asked.push(name);
        return ` token-for-${name} `;
      });
      /* RED WHEN the build reads any setting but the one the built network's record names,
       * which is how another network's token would reach the wallet. */
      expect(asked, id).toEqual([setting]);
      /* RED WHEN the token reaches the page under another name than the one the record's reader asks for. */
      expect(settings, id).toEqual({ [`import.meta.env.${setting}`]: JSON.stringify(`token-for-${setting}`) });
    }
  });

  it('A BUILD FOR SUCH A NETWORK WITH NO TOKEN STOPS, NAMING THE SETTING', () => {
    for (const id of asking) {
      const { setting } = networkRecord(id).endpoints!.projectToken!;
      for (const none of [undefined, '', '  ']) {
        /* RED WHEN a wallet is built that every call to its network would be refused from. */
        expect(() => projectTokenSettings(id, () => none), id).toThrow(`${setting} is not set`);
      }
    }
  });

  it('a build for a network that asks for no token reads no setting and carries nothing', () => {
    for (const id of NETWORK_IDS.filter((n) => !asking.includes(n))) {
      const asked: string[] = [];
      /* RED WHEN a token is put into a wallet whose network never asked for one. */
      expect(
        projectTokenSettings(id, (name) => {
          asked.push(name);
          return 'x';
        }),
        id
      ).toEqual({});
      expect(asked, id).toEqual([]);
    }
  });
});
