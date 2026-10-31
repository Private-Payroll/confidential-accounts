// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { useCalendarDay, useMoment } from './parts.js';

afterEach(cleanup);
const LANGUAGES = languagesFrom({ './locales/en.json': {} });

function Shown({ date, moment }: { date: string; moment: string }) {
  const day = useCalendarDay();
  const when = useMoment();
  return <p data-day={day(date)} data-moment={when(moment)} />;
}
const shown = (date: string, moment: string) => {
  const { container } = render(<KitProvider languages={LANGUAGES} pick="en"><Shown date={date} moment={moment} /></KitProvider>);
  const p = container.querySelector('p')!;
  return { day: p.getAttribute('data-day'), moment: p.getAttribute('data-moment') };
};
const inZone = (zone: string, run: () => void) => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { run(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};

describe('a calendar date and a moment', () => {
  /* RED WHEN: a calendar date is shown a day early west of UTC, or a day late east of it. */
  it('shows the calendar date as written, west and east of UTC', () => {
    for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
      inZone(zone, () => expect(shown('2026-10-03', '2026-10-03T12:00:00Z').day).toBe('Oct 3, 2026'));
    }
  });

  /* RED WHEN: a moment is shown in UTC, or without its time, instead of in the viewer's own zone. */
  it('shows a moment with its time in the viewer\'s own zone', () => {
    inZone('America/Los_Angeles', () => expect(shown('2026-10-03', '2026-10-03T02:30:00Z').moment).toMatch(/^Oct 2, 2026.*7:30\s?PM$/));
    inZone('Pacific/Auckland', () => expect(shown('2026-10-03', '2026-10-03T02:30:00Z').moment).toMatch(/^Oct 3, 2026.*3:30\s?PM$/));
  });

  /* RED WHEN: text that is not a calendar date or a moment is shown as a date, or throws. */
  it('shows nothing for what is not a date', () => {
    expect(shown('2026-02-30', 'soon')).toEqual({ day: '', moment: '' });
    expect(shown('', '')).toEqual({ day: '', moment: '' });
  });
});
