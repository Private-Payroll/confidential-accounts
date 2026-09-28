import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES, isBuilt, type Page } from '../pages.js';
import { STEP } from './step-ids.js';
import { EVERY_STEP, isBuiltStep, SETUP_STEPS } from './steps.js';
import { firstOpen, STANDING, standingOf } from './standing.js';

/*
 * THE ONE LIST OF SETUP STEPS, HELD TO WHAT IT PROMISES: every step is in it,
 * every entry is a step, a step and its page are one component, and a step
 * skipped is never taken for done.
 */
const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (p: string): string => readFileSync(SRC + p, 'utf8');
const ACTIONS = 'actions';
const actionFiles = (): string[] => readdirSync(SRC + ACTIONS).filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n)).sort();
/** Every file of the application's own source, relative to it, but tests. */
const everyFile = (dir = ''): string[] => readdirSync(SRC + dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? everyFile(`${dir}${e.name}/`) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [`${dir}${e.name}`] : []);
/** Every name a file exports, however it is written. */
const exportedNames = (text: string): string[] => [
  ...[...text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]!),
  ...[...text.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim().split(/\s+as\s+/).pop()!).filter(Boolean)),
  ...(/export\s+default\b/.test(text) ? ['default'] : []),
];
/**
 * Every module a file names, by any way of naming one: an import or export
 * from it, in either quote, and an import() of a string written whole;
 * resolved against the file, without its extension.
 */
const modulesNamed = (file: string, text: string): string[] => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`$]+)\1/g)]
  .map((m) => m[2]!).filter((s) => s.startsWith('.')).map((s) => normalize(join(dirname(file), s)).replace(/\.(js|ts|tsx|jsx)$/, ''));

/** The adapter that acts for each action, which that action alone may import. */
const ACTS_FOR: Record<string, string> = {
  'create-company.tsx': 'adapters/create-company.js',
  'hand-over.tsx': 'adapters/hand-over.js',
};

describe('every step is in the list, and every entry is a step', () => {
  /*
   * RED WHEN: the list's steps, their order, or which are built changes without
   * this test saying so: a step dropped, a Coming soon step shown as built, or
   * an everyday action (depositing, running payroll) made a setup step again.
   * The design's five steps, written out by hand.
   */
  it('has the design\'s five steps, in order, and builds only creating the company and handing it over', () => {
    expect(EVERY_STEP.map((s) => s.id)).toEqual(['createCompany', 'signers', 'handOver', 'vault', 'people']);
    expect(EVERY_STEP.filter(isBuiltStep).map((s) => s.id)).toEqual([STEP.createCompany, STEP.handOver]);
    expect(Object.values(STEP).sort()).toEqual(Object.keys(SETUP_STEPS).sort());
  });

  /* RED WHEN: a file in actions/ is a step's component that no entry shows (a step with no entry), or an entry's component is not in actions/ (an entry with no step). */
  it('shows every component in actions/ from exactly one entry, and every entry\'s component is one of them', async () => {
    /* One export a file, and that export is, by identity, one entry's component: not a same-named copy made elsewhere. */
    const exported: unknown[] = [];
    for (const f of actionFiles()) {
      const names = exportedNames(read(`${ACTIONS}/${f}`));
      expect(names, f).toHaveLength(1);
      const mod = (await import(`../${ACTIONS}/${f.replace(/\.tsx?$/, '.js')}`)) as Record<string, unknown>;
      exported.push(mod[names[0]!]);
    }
    const shown = EVERY_STEP.filter(isBuiltStep).map((s) => (s.shows as { action: unknown }).action);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.every((c) => exported.includes(c))).toBe(true);
    expect(exported.every((c) => shown.includes(c))).toBe(true);
  });

  /* RED WHEN: a step cannot be skipped. */
  it('lets every step be skipped', () => {
    expect(EVERY_STEP.filter((s) => !s.skippable).map((s) => s.id)).toEqual([]);
  });
});

describe('a step and its page are one component', () => {
  /*
   * RED WHEN: an action's adapter is imported anywhere but its action's own
   * file, which is what a copy of a step, made into a page or another step,
   * has to do to act; or an action has no adapter listed here.
   */
  it('lets only an action\'s own file reach the adapter that acts for it', () => {
    expect(Object.keys(ACTS_FOR).sort()).toEqual(actionFiles());
    for (const [file, adapter] of Object.entries(ACTS_FOR)) {
      const target = adapter.replace(/\.js$/, '');
      const importers = everyFile().filter((p) => modulesNamed(p, read(p)).includes(target));
      expect(importers, adapter).toEqual([`${ACTIONS}/${file}`]);
    }
  });

  /*
   * RED WHEN: a file names a module by a name built at run time (an import()
   * of a template with a value, of a name, or of a sum), which the check above
   * cannot read, so a copy of a step could reach an action's adapter unseen.
   * Every module is named whole, so the check above reads every one.
   */
  it('names every module whole, so the check above reads each', () => {
    const built = /\bimport\s*\(\s*(?!(['"])[^'"`$]*\1\s*\))/g;
    const breaches = everyFile().flatMap((p) => [...read(p).matchAll(built)].map(() => p));
    expect(breaches).toEqual([]);
    /* The check reads what it is for: the list of pages names its screens whole, by import(). */
    expect([...read('pages.ts').matchAll(/\bimport\s*\(\s*'\.\/screens\//g)].length).toBeGreaterThan(5);
    const probe = "const a = import(`../adapters/${n}.js`); const b = import(name); const c = import('../adapters/' + n); const d = import('../x.js');";
    expect([...probe.matchAll(built)].length).toBe(3);
  });

  /*
   * RED WHEN: a built page named by a step shows something other than that
   * step's component from actions/: a screen of its own, or a copy.
   */
  it('shows, on every built page a step names, the step\'s own component', () => {
    const checked: string[] = [];
    for (const s of EVERY_STEP) {
      if (s.page === undefined) continue;
      expect(Object.keys(PAGES), s.id).toContain(s.page);
      const page = PAGES[s.page] as Page;
      if (!isBuilt(page) || !isBuiltStep(s)) continue;
      /* A screen loaded on demand is found by the name the list gives it. */
      const name = (page.shows.screen as { screenName?: string }).screenName ?? page.shows.screen.name;
      const screen = everyFile().find((p) => p.startsWith('screens/') && new RegExp(`export function ${name}\\b`).test(read(p)))!;
      expect(read(screen), s.id).toMatch(new RegExp(`import \\{[^}]*\\b${s.shows.action.name}\\b[^}]*\\} from '\\.\\./${ACTIONS}/`));
      checked.push(`${s.id} on ${s.page}`);
    }
    /* No built step's page is built yet; the change that builds one adds it here, and the check above then reads it. */
    expect(checked).toEqual([]);
  });
});

describe('where a step stands', () => {
  const none = { company: null, handover: null };
  const created = { company: 'c-1', handover: null };

  /* RED WHEN: a step skipped is shown as done, a step done is shown as skipped, or a step neither is shown as either. */
  it('never shows a skipped step as done', () => {
    const create = EVERY_STEP.find((s) => s.id === STEP.createCompany)!;
    expect(standingOf(create, none, new Set([STEP.createCompany]))).toBe(STANDING.skipped);
    expect(standingOf(create, none, new Set())).toBe(STANDING.open);
    expect(standingOf(create, created, new Set([STEP.createCompany]))).toBe(STANDING.done);
    for (const s of EVERY_STEP.filter((x) => !isBuiltStep(x))) expect(standingOf(s, created, new Set([s.id])), s.id).toBe(STANDING.skipped);
  });

  /* RED WHEN: the wizard opens at a step that is done or skipped while one before it is neither. */
  it('opens at the first step neither done nor skipped', () => {
    expect(firstOpen(none, new Set())).toBe(STEP.createCompany);
    expect(firstOpen(created, new Set())).toBe(STEP.signers);
    expect(firstOpen(created, new Set([STEP.signers]))).toBe(STEP.handOver);
  });
});
