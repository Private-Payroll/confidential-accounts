import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NETWORK_IDS } from '../../../src/core/networks.js';

/*
 * THE SEND SCREEN NAMES NO NETWORK IN ITS OWN WORDS.
 * The wallet is built for one network and the same text must be true on any test network, so a
 * sentence that names a network takes its name from the network's record (`networkRecord(id).label`)
 * and never writes one. This reads the send screen's files and refuses any that spell a network id.
 */

const readAll = (folder: URL, pattern: RegExp): { name: string; text: string }[] =>
  readdirSync(folder)
    .filter((name) => pattern.test(name) && !name.includes('.test.'))
    .map((name) => ({ name, text: readFileSync(new URL(name, folder), 'utf8') }));

const files = readAll(new URL('./screens/', import.meta.url), /^send(-[a-z-]+)?\.tsx?$/u);

describe('the words of the send screen', () => {
  it('are read from the right files', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(NETWORK_IDS).toContain('stagenet');
  });

  it('spell no network id', () => {
    /* RED WHEN: a line or comment in one of these files writes a network's name, such as
     * `submits through the stagenet node`, instead of taking it from the network record. */
    for (const { name, text } of files) {
      for (const id of NETWORK_IDS) {
        expect(text, `${name} spells "${id}"`).not.toMatch(new RegExp(`\\b${id}\\b`, 'iu'));
      }
    }
  });
});
