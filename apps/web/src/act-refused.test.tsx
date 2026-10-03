// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { ActRefused } from './act-refused.js';
import { ACT_REFUSAL, type ActRefusal } from './adapters/refusals.js';
import en from './locales/en.json';

/*
 * Why an action on a company did not happen, said in the person's language:
 * every refusal by its own phrase, none by another's.
 */
afterEach(() => { cleanup(); });

const LANGUAGES = languagesFrom({ './locales/en.json': en });

const said = (why: ActRefusal): string | null => {
  const { container } = render(<KitProvider languages={LANGUAGES} pick="en"><ActRefused why={why} /></KitProvider>);
  const text = container.querySelector(`[data-refusal="${why}"] [data-slot="alert-description"]`)?.textContent ?? null;
  cleanup();
  return text;
};

describe('a refusal on the screen', () => {
  /* RED WHEN: a refusal is said with another refusal's phrase, or with none: a phrase the English file does not have shows as its key. */
  it('says each refusal in its own words', () => {
    const words = new Set(Object.values(en as Record<string, string>));
    const phrases = Object.values(ACT_REFUSAL).map((why) => said(why));
    expect(phrases.filter((p) => p === null || !words.has(p))).toEqual([]);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  /* RED WHEN: a signer whose records name no seat for them, or a seat their own key does not make, is told only that it did not finish. */
  it('says a seat that is missing, or not the signer\'s own, as that', () => {
    const words = en as Record<string, string>;
    expect(said(ACT_REFUSAL.noSeat)).toBe(words['act.refused.noSeat']);
    expect(said(ACT_REFUSAL.notYourSeat)).toBe(words['act.refused.notYourSeat']);
  });
});
