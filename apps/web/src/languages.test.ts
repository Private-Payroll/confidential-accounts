// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { KitProvider } from 'vaults-ui';
import { PageView } from './app.js';
import { LANGUAGES, wordsFor } from './languages.js';
import { untilPageShown } from './page-shown.test-support.js';
import { wordsOf } from './english.test-support.js';

afterEach(cleanup);

describe('the words a screen needs', () => {
  /* RED WHEN: the first download's language holds a screen's words, so they are in the download before the screen is. */
  it('are not in the languages the first download carries', () => {
    const english = LANGUAGES.find((l) => l.tag === 'en')!.messages;
    expect(english).toHaveProperty('page.home.name');
    expect(english).not.toHaveProperty('invite.title');
    expect(Object.keys(english).length).toBeLessThan(Object.keys(wordsOf('en')).length / 2);
  });

  /* RED WHEN: a page's words come without the common ones, or without its own, or with another page's. */
  it('are the common words and the page\'s own, each language\'s under its tag', async () => {
    const join = (await wordsFor('join')())['en']!;
    const vault = (await wordsFor('vault')())['en']!;
    expect(Object.keys(join)).toContain('join.noToken.title');
    expect(Object.keys(join)).toContain('invite.title');
    expect(join).not.toHaveProperty('vault.back');
    expect(vault).toHaveProperty('vault.back');
    expect(vault).not.toHaveProperty('join.noToken.title');
    expect(Object.keys(await wordsFor('no-such-page')())).toEqual(['en']);
  });

  /* RED WHEN: asking again fetches again, so one set of words is two objects and is put into the translator twice. */
  it('are fetched once, however often a screen opens', async () => {
    expect(await wordsFor('apps')()).toBe(await wordsFor('apps')());
  });

  /* RED WHEN: a page opened from the first download's languages alone shows keys, because its screen does not bring its words, or brings the common words but not its own. */
  it('come with the screen, so a page opens with its words from the first download\'s languages alone', async () => {
    const view = render(createElement(KitProvider, { languages: LANGUAGES, pick: 'en' }, createElement(PageView, { id: 'apps' })));
    const screen = await untilPageShown(view.container);
    expect(screen.textContent).toContain('Interoperability');
    expect(screen.textContent).not.toMatch(/\bapps\.[a-z]/);
  });
});
