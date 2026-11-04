import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * THE WORDS OF A LANGUAGE, ALL OF THEM, FOR A TEST THAT DRAWS A SCREEN.
 *
 * The application's words are in several files under `locales/`, and a screen
 * loads the ones it needs when it opens. A test that draws a screen by itself
 * wants every word, so it asks here, and never reads a language file by name:
 * what is in which file is then free to change without the tests knowing.
 */

/** The folder the application's language files are in. */
export const LOCALES = join(dirname(fileURLToPath(import.meta.url)), 'locales');

/** Every language file of `tag` in the locales folder and the folders beneath it, as paths relative to it, sorted. */
export function filesOf(tag: string): string[] {
  return (readdirSync(LOCALES, { recursive: true }) as string[]).filter((p) => basename(p) === `${tag}.json`).sort();
}

/** The words of `tag`, every file of it joined. A key in two files is a mistake and is refused. */
export function wordsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of filesOf(tag)) {
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(join(LOCALES, file), 'utf8')) as Record<string, string>)) {
      if (key in out) throw new Error(`${key} is in ${file} and in another ${tag} file`);
      out[key] = value;
    }
  }
  return out;
}

/** Every English word. */
export const ENGLISH: Record<string, string> = wordsOf('en');
