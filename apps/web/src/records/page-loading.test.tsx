// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageView } from '../app.js';

afterEach(cleanup);

describe('a page loading', () => {
  /*
   * RED WHEN: a page loaded on demand shows nothing while it loads, a few
   * loose lines rather than the kit's page loading (a heading and sections,
   * the shape of a page), or anything that could be read as an answer. Its
   * own file, so the page's module is not loaded yet when it is drawn.
   */
  it('shows the kit\'s page loading while its screen loads', () => {
    const view = render(<PageView id="people" />);
    const loading = view.container.querySelector('[data-loading]') as HTMLElement | null;
    expect(loading?.getAttribute('data-slot')).toBe('page-loading');
    expect(loading?.getAttribute('aria-busy')).toBe('true');
    expect(loading?.querySelectorAll('[data-slot=section-loading]').length).toBeGreaterThan(0);
    expect(loading?.textContent).toBe('');
  });
});
