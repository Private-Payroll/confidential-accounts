import type { ComponentType } from 'react';
import type { IconSvgElement } from '@hugeicons/react';
import { Building03Icon, SafeIcon, ShieldUserIcon, UserAdd01Icon, UserGroupIcon } from '@hugeicons/core-free-icons';
import { HandOver } from '../actions/hand-over.js';
import { CreateCompany } from '../actions/create-company.js';
import { HANDOVER, type Handover } from '../adapters/handover-state.js';
import type { PageId, Text } from '../pages.js';
import { STEP, type StepId, type StepProps } from './step-ids.js';

/**
 * EVERY SETUP STEP, IN ONE LIST.
 *
 * Each step is one entry: its words, its icon, how the application knows it
 * is done, whether it can be skipped, whether it can be undone once done, and
 * either its component or what it will be while it is not built yet. The
 * setup wizard, its tabs and its progress bar read this list and nothing
 * else, so adding a step is one entry here, its phrases in the language
 * files, and its component.
 *
 * A STEP AND ITS PAGE ARE ONE COMPONENT. A step that is also done from a page
 * of its own names that page; the page shows the same component the wizard
 * does, from `actions/`, and never a copy of it. A step not built yet is in
 * the list as Coming soon, and the change that builds it puts its component
 * here in place of the line.
 */

/** What the application knows about the company being set up, which is all a step's "done" reads. */
export interface SetupFacts {
  /** The company being set up, by id; null before one is created. */
  company: string | null;
  /** Where it stands on being held by its committee; null while that is not known. */
  handover: Handover | null;
}

export interface SetupStep {
  /** Its name, as the wizard's tab and the step's own heading say it. */
  name: (t: Text) => string;
  /** One line on what the step does. */
  line: (t: Text) => string;
  icon: IconSvgElement;
  /** How the application knows the step is done. A step skipped is not done. */
  done: (facts: SetupFacts) => boolean;
  /** Whether it can be skipped for now and returned to. */
  skippable: boolean;
  /**
   * Whether, once done, it can never be undone: a company created, or handed
   * to its signers, stays so. Such a step, once done, shows as done and is
   * never opened again, so its action is never offered a second time.
   */
  cannotBeUndone: boolean;
  /** Its component, or, while it is not built, what it will be. */
  shows: { action: ComponentType<StepProps> } | { comingSoon: (t: Text) => string };
  /** The page the same action is done from outside setup, if it has one. */
  page?: PageId;
}

const never = (): boolean => false;

/** THE LIST, in the order the wizard walks it. */
export const SETUP_STEPS = {
  [STEP.createCompany]: {
    name: (t) => t('setup.step.createCompany.name'), line: (t) => t('setup.step.createCompany.line'), icon: Building03Icon,
    done: (f) => f.company !== null, skippable: true, cannotBeUndone: true, shows: { action: CreateCompany },
  },
  [STEP.signers]: {
    name: (t) => t('setup.step.signers.name'), line: (t) => t('setup.step.signers.line'), icon: UserAdd01Icon,
    done: never, skippable: true, cannotBeUndone: false, shows: { comingSoon: (t) => t('setup.step.signers.soon') }, page: 'settingsSigners',
  },
  [STEP.handOver]: {
    name: (t) => t('setup.step.handOver.name'), line: (t) => t('setup.step.handOver.line'), icon: ShieldUserIcon,
    done: (f) => f.handover?.of === HANDOVER.held, skippable: true, cannotBeUndone: true, shows: { action: HandOver }, page: 'settingsSigners',
  },
  [STEP.vault]: {
    name: (t) => t('setup.step.vault.name'), line: (t) => t('setup.step.vault.line'), icon: SafeIcon,
    done: never, skippable: true, cannotBeUndone: true, shows: { comingSoon: (t) => t('setup.step.vault.soon') }, page: 'vaults',
  },
  [STEP.people]: {
    name: (t) => t('setup.step.people.name'), line: (t) => t('setup.step.people.line'), icon: UserGroupIcon,
    done: never, skippable: true, cannotBeUndone: false, shows: { comingSoon: (t) => t('setup.step.people.soon') }, page: 'people',
  },
} as const satisfies Record<StepId, SetupStep>;

/** Every step, with its id, in the list's order. */
export const EVERY_STEP: readonly (SetupStep & { id: StepId })[] = (Object.keys(SETUP_STEPS) as StepId[]).map((id) => ({ id, ...(SETUP_STEPS[id] as SetupStep) }));

/** Whether a step is built: it has a component rather than a line on what it will be. */
export const isBuiltStep = (step: SetupStep): step is SetupStep & { shows: { action: ComponentType<StepProps> } } =>
  (step.shows as { action?: unknown }).action !== undefined;

export { startSetupAt, takeAsked, type SetupAsked } from './asked.js';
