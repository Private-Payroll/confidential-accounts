import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANY_PHASE, COMPANY_USUAL_SECONDS, stageTimeRecord, stageTimeNoter, type StageTimeRecord } from './usual-times.js';

/**
 * **EACH STAGE'S MEASURED SECONDS ARE KEPT WHEN THE STAGE ENDS, IN DEVELOPMENT ONLY.**
 *
 * The usual times on the progress display are estimates except proving. A run writes the real ones to
 * the development console log, one line per stage, so the constants can be corrected from them.
 *
 * RED WHEN: a stage ends and no line is written, or one is written while it still runs or twice; the line does not
 * name the stage, its measured seconds (to a tenth) and the usual figure shown ("none" where none is shown); a stage
 * that follows another is measured from before it began; a screen that goes away leaves its stage unwritten; the
 * production build writes a line; or a constant of the usual times is changed by the recorder. A line is one object
 * (`stageTime`, `measuredSeconds`, `usualShownSeconds`), so no wording of its own stands in the application.
 */
afterEach(() => { vi.unstubAllEnvs(); });

const noting = () => { const lines: StageTimeRecord[] = []; return { lines, note: stageTimeNoter((l) => { lines.push(l); }) }; };
const rec = (stageTime: readonly string[], measuredSeconds: number, usualShownSeconds: number | null): StageTimeRecord => ({ stageTime, measuredSeconds, usualShownSeconds });

describe('the stage times', () => {
  it('the line names the stage, the measured seconds and the usual figure shown', () => {
    expect(stageTimeRecord(['deploy', 'proving'], 112.34, 120)).toEqual(rec(['deploy', 'proving'], 112.3, 120));
    expect(stageTimeRecord(['waiting-for-approvals'], 5, null)).toEqual(rec(['waiting-for-approvals'], 5, null));
    expect(JSON.stringify(stageTimeRecord(['sending'], 31.25, 30))).toBe('{"stageTime":["sending"],"measuredSeconds":31.3,"usualShownSeconds":30}');
  });

  it('writes one line when a stage ends, measured from its start to the start of the next', () => {
    const { lines, note } = noting();
    note(['checking'], 1_000, 5, 1_000);
    note(['checking'], 1_000, 5, 4_000);
    expect(lines).toEqual([]);
    note(['building'], 9_500, 120, 10_000);
    expect(lines).toEqual([rec(['checking'], 8.5, 5)]);
    note(['building'], 9_500, 120, 20_000);
    expect(lines).toHaveLength(1);
    note(['sending'], 129_500, 30, 131_000);
    expect(lines[1]).toEqual(rec(['building'], 120, 120));
  });

  it('a stage named in parts is one stage while its parts are the same', () => {
    const { lines, note } = noting();
    note(['deploy', 'sending'], 0, 30, 0);
    note(['deploy', 'sending'], 0, 30, 5_000);
    note(['deploy', 'waiting'], 7_000, 60, 7_000);
    note(null, 0, null, 8_000);
    expect(lines).toEqual([rec(['deploy', 'sending'], 7, 30), rec(['deploy', 'waiting'], 1, 60)]);
  });

  it('a stage that ends with nothing after it is measured to the moment it was seen to end', () => {
    const { lines, note } = noting();
    note(['sending'], 2_000, 30, 2_000);
    note(null, 0, null, 33_250);
    note(null, 0, null, 40_000);
    expect(lines).toEqual([rec(['sending'], 31.3, 30)]);
  });

  it('writes nothing in the production build, and keeps no stage', () => {
    vi.stubEnv('DEV', false);
    const { lines, note } = noting();
    note(['checking'], 0, 5, 0);
    note(['building'], 9_000, 120, 9_000);
    note(null, 0, null, 12_000);
    expect(lines).toEqual([]);
    vi.stubEnv('DEV', true);
    note(['building'], 20_000, 120, 20_000);
    note(null, 0, null, 21_000);
    expect(lines).toEqual([rec(['building'], 1, 120)]);
  });

  it('the usual figures themselves are the recorder\'s to read, never to change', () => {
    const { note } = noting();
    note(['deploy', COMPANY_PHASE.proving], 0, COMPANY_USUAL_SECONDS[COMPANY_PHASE.proving], 0);
    note(null, 0, null, 1_000);
    expect(COMPANY_USUAL_SECONDS).toEqual({ proving: 120, sending: 30, waiting: 60 });
  });
});
