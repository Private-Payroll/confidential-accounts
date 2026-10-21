import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGES, isBuilt, type Page } from '../pages.js';
import { STEP } from './step-ids.js';
import { EVERY_STEP, isBuiltStep, SETUP_STEPS } from './steps.js';
import { blockedBy, firstOpen, skippedFor, skipStep, STANDING, standingOf } from './standing.js';
import type { CompanyCreation } from '../adapters/creation-standing.js';

/*
 * THE ONE LIST OF SETUP STEPS, HELD TO WHAT IT PROMISES: every step is in it,
 * every entry is a step, a step and its page are one component, a step
 * skipped is never taken for done, and the step that must be finished before
 * the others is the one that says so.
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
  'finish-company.tsx': 'adapters/finish-company.js',
  'committee-change.tsx': 'adapters/committee-change.js',
  'create-vault.tsx': 'adapters/create-vault.js',
  'start-again.tsx': 'adapters/start-again.js',
};
/** The components in actions/ that are no step's: each with the only files that may show it, one component called from each, never a copy. */
const NO_STEP: Record<string, string[]> = {
  'committee-change.tsx': ['records/vault-pending', 'screens/settings-sections'],
  'start-again.tsx': ['actions/finish-company'],
};

describe('every step is in the list, and every entry is a step', () => {
  /*
   * RED WHEN: the list's steps, their order, or which are built changes without
   * this test saying so: a step dropped, a Coming soon step shown as built, or
   * an everyday action (depositing, running payroll) made a setup step again.
   * The design's five steps, written out by hand: there is no step for handing the company over.
   */
  it('has the design\'s five steps, in order, and builds only creating the company, finishing it and creating a vault', () => {
    expect(EVERY_STEP.map((s) => s.id)).toEqual(['createCompany', 'finishCompany', 'signers', 'vault', 'people']);
    expect(EVERY_STEP.filter(isBuiltStep).map((s) => s.id)).toEqual([STEP.createCompany, STEP.finishCompany, STEP.vault]);
    expect(Object.values(STEP).sort()).toEqual(Object.keys(SETUP_STEPS).sort());
  });

  /* RED WHEN: a file in actions/ is a step's component that no entry shows (a step with no entry), or an entry's component is not in actions/ (an entry with no step). A component no step shows is listed by hand as such. */
  it('shows every component in actions/ that is a step\'s from exactly one entry, and every entry\'s component is one of them', async () => {
    /* One export a file, and that export is, by identity, one entry's component: not a same-named copy made elsewhere. */
    const exported: unknown[] = [];
    for (const f of actionFiles().filter((n) => NO_STEP[n] === undefined)) {
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

  /*
   * RED WHEN: the committee change is a step again, or is shown from any file but the vault panel's and the signers
   * page's (a copy of it, or a third place it is drawn), or the signers step is built before adding signers is.
   */
  it('shows the committee change from the vault panel and the signers page only, and leaves the signers step Coming soon', () => {
    /* Every one of them is a file in actions/, and no step shows it. */
    const shown = EVERY_STEP.filter(isBuiltStep).map((st) => (st.shows as { action: { name: string } }).action.name);
    expect(Object.keys(NO_STEP).every((f) => actionFiles().includes(f))).toBe(true);
    expect(shown).not.toContain('CommitteeChange');
    for (const [file, mounts] of Object.entries(NO_STEP)) {
      const target = `${ACTIONS}/${file}`.replace(/\.tsx$/, '');
      expect(everyFile().filter((p) => modulesNamed(p, read(p)).includes(target)).map((p) => p.replace(/\.tsx?$/, '')).sort(), file).toEqual([...mounts].sort());
    }
    expect('comingSoon' in SETUP_STEPS[STEP.signers].shows).toBe(true);
    expect(SETUP_STEPS[STEP.signers].page).toBe('settingsSigners');
    expect(PAGES.settingsSigners.shows).toHaveProperty('already');
    expect(((PAGES.settingsSigners as Page).shows as unknown as { already: { screenName: string } }).already.screenName).toBe('SignersBuilt');
    expect(read('screens/settings-sections.tsx')).toMatch(/export function SignersBuilt\b[\s\S]*<CommitteeChange \/>/);
  });

  /* RED WHEN: a step that can be skipped cannot be, or finishing the company can be skipped. */
  it('lets every step be skipped but finishing the company', () => {
    expect(EVERY_STEP.filter((s) => !s.skippable).map((s) => s.id)).toEqual([STEP.finishCompany]);
  });

  /* RED WHEN: a step other than finishing the company holds the later steps back, or finishing the company no longer does. */
  it('holds the later steps back only until the company is finished', () => {
    expect(EVERY_STEP.filter((s) => s.blocksLater === true).map((s) => s.id)).toEqual([STEP.finishCompany]);
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
    /* Each built step whose page is built, named here, so the check above is seen reading it. */
    expect(checked).toEqual(['vault on vaults']);
  });
});

describe('the vault step', () => {
  /*
   * RED WHEN: a vault of a standing other than one the company's committee
   * holds closes the vault step, which cannot be undone: one not finished,
   * not yet on the chain, held by keys that are not the committee now, or of
   * a standing not known; or one the committee holds does not.
   */
  it('is done only by a vault the company\'s committee holds', async () => {
    const { VAULT } = await import('../adapters/company-records.js');
    const { wasHandedOver } = await import('../adapters/vault-rows.js');
    const held = Object.values(VAULT).filter((standing) => wasHandedOver({ standing }));
    expect(held.sort()).toEqual([VAULT.accountNotFundable, VAULT.accountNotHandedOver, VAULT.held, VAULT.notFundable].sort());
    const vault = EVERY_STEP.find((s) => s.id === STEP.vault)!;
    for (const standing of Object.values(VAULT)) {
      expect(vault.done({ company: 'c-1', vaults: [{ standing }], creation: null }), standing).toBe(held.includes(standing));
    }
    expect(vault.done({ company: 'c-1', vaults: null, creation: null })).toBe(false);
    expect(vault.done({ company: 'c-1', vaults: [], creation: null })).toBe(false);
  });
});

const creation = (over: Partial<CompanyCreation> = {}): CompanyCreation => ({
  company: 'c-1', standing: 'finished', awaitingSecondPress: false, kept: false, confirmedFinished: true, mark: null, ...over,
});

describe('where a step stands', () => {
  const none = { company: null, vaults: null, creation: null };
  const created = { company: 'c-1', vaults: null, creation: creation({ standing: 'pay-key-owed', confirmedFinished: false, mark: 'not-finished' }) };
  const finished = { ...created, creation: creation() };

  /* RED WHEN: a step skipped is shown as done, a step done is shown as skipped, or a step neither is shown as either. */
  it('never shows a skipped step as done', () => {
    const create = EVERY_STEP.find((s) => s.id === STEP.createCompany)!;
    expect(standingOf(create, none, new Set([STEP.createCompany]))).toBe(STANDING.skipped);
    expect(standingOf(create, none, new Set())).toBe(STANDING.open);
    expect(standingOf(create, created, new Set([STEP.createCompany]))).toBe(STANDING.done);
    for (const s of EVERY_STEP.filter((x) => !isBuiltStep(x) && x.skippable)) expect(standingOf(s, created, new Set([s.id])), s.id).toBe(STANDING.skipped);
  });

  /* RED WHEN: a step that cannot be skipped is shown as skipped because a skip was kept for it, so the wizard moves past it. */
  it('never shows a step that cannot be skipped as skipped', () => {
    const finish = EVERY_STEP.find((s) => s.id === STEP.finishCompany)!;
    expect(standingOf(finish, created, new Set([STEP.finishCompany]))).toBe(STANDING.open);
  });

  /* RED WHEN: a skip is kept for a step that cannot be skipped, or a step that can be skipped is not kept. */
  it('keeps no skip for a step that cannot be skipped', () => {
    skippedFor('c-skip').clear();
    expect(skipStep('c-skip', STEP.finishCompany)).toBe(false);
    expect([...skippedFor('c-skip')]).toEqual([]);
    expect(skipStep('c-skip', STEP.signers)).toBe(true);
    expect([...skippedFor('c-skip')]).toEqual([STEP.signers]);
    skippedFor('c-skip').clear();
  });

  /* RED WHEN: the company is not done once it exists or its creation is kept in this tab, or is done when neither is so. */
  it('counts creating the company done once it exists, or once this tab keeps its creation', () => {
    const create = EVERY_STEP.find((s) => s.id === STEP.createCompany)!;
    expect(create.done(none)).toBe(false);
    expect(create.done({ ...none, creation: creation({ company: null, standing: null, confirmedFinished: false }) })).toBe(false);
    expect(create.done({ ...none, creation: creation({ company: 'c-new', standing: 'not-created', kept: true, awaitingSecondPress: true, confirmedFinished: false }) })).toBe(true);
    expect(create.done(created)).toBe(true);
  });

  /* RED WHEN: finishing the company is done on the service's word alone, or is not done once the wallet confirms it. */
  it('counts finishing the company done only when the wallet confirms it', () => {
    const finish = EVERY_STEP.find((s) => s.id === STEP.finishCompany)!;
    expect(finish.done(none)).toBe(false);
    expect(finish.done({ ...created, creation: creation({ standing: 'finished', confirmedFinished: false }) })).toBe(false);
    expect(finish.done(created)).toBe(false);
    expect(finish.done(finished)).toBe(true);
  });

  /* RED WHEN: the wizard opens at a step that is done or skipped while one before it is neither. */
  it('opens at the first step neither done nor skipped', () => {
    expect(firstOpen(none, new Set())).toBe(STEP.createCompany);
    expect(firstOpen(created, new Set())).toBe(STEP.finishCompany);
    expect(firstOpen(finished, new Set())).toBe(STEP.signers);
    expect(firstOpen(finished, new Set([STEP.signers]))).toBe(STEP.vault);
  });

  /* RED WHEN: a step after an unfinished company is not held back, one before it or the blocking step itself is, or a finished company holds any back. */
  it('holds back every step after finishing the company until it is done', () => {
    const index = (id: string) => EVERY_STEP.findIndex((s) => s.id === id);
    expect(blockedBy(index(STEP.createCompany), created)).toBeNull();
    expect(blockedBy(index(STEP.finishCompany), created)).toBeNull();
    for (const id of [STEP.signers, STEP.vault, STEP.people]) {
      expect(blockedBy(index(id), created), id).toBe(STEP.finishCompany);
      expect(blockedBy(index(id), none), id).toBe(STEP.finishCompany);
      expect(blockedBy(index(id), finished), id).toBeNull();
    }
  });
});
