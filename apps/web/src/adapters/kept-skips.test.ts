import { describe, expect, it } from 'vitest';
import { keepSkips, readSkips } from './kept-skips.js';

/* THE SKIPPED SETUP STEPS KEPT IN THE TAB'S STORAGE, read back as step ids and nothing else. */
const storage = (): Pick<Storage, 'getItem' | 'setItem'> & { kept: Map<string, string> } => {
  const kept = new Map<string, string>();
  return { kept, getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } };
};

describe('the skipped steps kept in the tab', () => {
  /* RED WHEN: a skip is read back under another company, the person's skips before a company are lost, or a company with none kept is kept. */
  it('reads back what it kept, for each company and for none', () => {
    const s = storage();
    keepSkips(s, new Map([[null, new Set(['createCompany' as const])], ['c-1', new Set(['signers' as const, 'vault' as const])], ['c-2', new Set()]]));
    expect([...readSkips(s).entries()].map(([c, v]) => [c, [...v]])).toEqual([[null, ['createCompany']], ['c-1', ['signers', 'vault']]]);
  });

  /* RED WHEN: anything kept that is not a step id (words, a removed step, a number) is handed on, or what cannot be read is taken for a skip. */
  it('hands on step ids and nothing else', () => {
    const s = storage();
    s.setItem('private-vaults.setup-skipped', JSON.stringify({ 'c-1': ['deposit', 'Run payroll', 7, 'people'], 'c-2': 'signers' }));
    expect([...readSkips(s).entries()].map(([c, v]) => [c, [...v]])).toEqual([['c-1', ['people']]]);
    s.setItem('private-vaults.setup-skipped', 'not json');
    expect(readSkips(s).size).toBe(0);
    expect(readSkips(null).size).toBe(0);
    keepSkips({ setItem: () => { throw new Error('refused'); } }, new Map([[null, new Set(['vault' as const])]]));
  });
});
