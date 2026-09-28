// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageView } from '../app.js';

afterEach(cleanup);

describe('a page loading', () => {
  /*
   * RED WHEN: a page loaded on demand shows nothing while it loads, or
   * something other than the kit's placeholder, which could be read as an
   * answer. Its own file, so the page's module is not loaded yet when it is drawn.
   */
  it('shows the kit\'s placeholder while its screen loads', () => {
    const view = render(<PageView id="people" />);
    const loading = view.container.querySelector('[data-loading]') as HTMLElement | null;
    expect(loading?.getAttribute('aria-busy')).toBe('true');
    expect(loading?.querySelectorAll('[data-slot=skeleton]').length).toBeGreaterThan(0);
    expect(loading?.textContent).toBe('');
  });
});
