import { describe, expect, it } from 'vitest';
import { DEFAULT_BASE_COLOR } from 'vaults-ui';
import { DEFAULT_PREFERENCES, keepPreferences, readPreferences, showAppearance, themeFor } from './preferences.js';

/** A browser's storage, kept in a map. */
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
};

describe('the person\'s choices', () => {
  /* RED WHEN: a choice kept is not read back as it was, or "follow my browser" is kept as a language. */
  it('are read back as they were kept', () => {
    const s = storage();
    keepPreferences(s, { mode: 'dark', base: 'olive', language: 'en' });
    expect(readPreferences(s)).toEqual({ mode: 'dark', base: 'olive', language: 'en' });
    keepPreferences(s, { mode: 'light', base: 'olive', language: null });
    expect(readPreferences(s).language).toBeNull();
  });

  /* RED WHEN: nothing kept, a value from an older version, or a storage that refuses is not read as not chosen: the computer's light or dark on the default colour. */
  it('are taken as not chosen when nothing, or nothing known, is kept, or the browser will not say', () => {
    expect(readPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    const s = storage();
    s.m.set('private-vaults.mode', 'sepia');
    s.m.set('private-vaults.base', 'slate');
    expect(readPreferences(s)).toEqual(DEFAULT_PREFERENCES);
    const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(readPreferences(refusing)).toEqual(DEFAULT_PREFERENCES);
    expect(() => keepPreferences(refusing, DEFAULT_PREFERENCES)).not.toThrow();
    expect(DEFAULT_PREFERENCES.base).toBe(DEFAULT_BASE_COLOR);
  });

  /* RED WHEN: "same as my computer" does not follow the computer, or a mode chosen does not win over it; or the theme and colour are not put where the kit's stylesheet reads them. */
  it('are shown on the root element, following the computer only when asked to', () => {
    expect([themeFor('system', true), themeFor('system', false), themeFor('light', true), themeFor('dark', false)]).toEqual(['dark', 'light', 'light', 'dark']);
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    showAppearance(root, 'dark', 'mauve');
    expect(root.dataset).toEqual({ theme: 'dark', base: 'mauve' });
  });
});
