import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * THE KIT'S ONE CLASS-NAME HELPER. Joins class names and lets a later
 * utility replace an earlier one it conflicts with, so a component's defaults
 * can be overridden by the class a screen passes in.
 *
 * Every component, fetched or written here, imports it from this file, which
 * is the path `components.json` names for it.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
