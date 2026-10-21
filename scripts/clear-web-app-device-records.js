/*
 * CLEARS THE WEB APP'S OWN RECORDS ON THIS DEVICE, for http://localhost:5173
 * only: its IndexedDB databases, local storage and session storage.
 *
 * Paste the whole of this file into the DevTools console of a tab open on
 * http://localhost:5173 and press Return. It refuses on any other address, so
 * the wallet at http://localhost:5180 (another origin, with its own keys) can
 * not be cleared by it.
 *
 * It lists what the page holds, deletes it, lists again and prints what
 * remains. The answer it wants to give is: nothing remains.
 */
(async () => {
  const ONLY = 'http://localhost:5173';
  if (location.origin !== ONLY) {
    console.error('REFUSED: this tab is at ' + location.origin + '. It clears ' + ONLY + ' and nothing else. Nothing was deleted.');
    return { refused: true, origin: location.origin };
  }
  const keys = (s) => Object.keys(s).sort();
  const look = async () => ({
    indexedDB: ((await indexedDB.databases()) || []).map((d) => d.name).sort(),
    localStorage: keys(localStorage),
    sessionStorage: keys(sessionStorage),
  });
  const show = (title, w) => {
    console.log(title + ' (' + location.origin + ')');
    for (const [k, v] of Object.entries(w)) console.log('  ' + k + ': ' + (v.length ? v.join(', ') : '(none)'));
  };
  const before = await look();
  show('BEFORE', before);
  for (const name of before.indexedDB) {
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = () => resolve();
      r.onblocked = () => console.log('waiting: another tab on ' + ONLY + ' holds ' + name + ' open');
      setTimeout(resolve, 5000);
    });
  }
  localStorage.clear();
  sessionStorage.clear();
  const after = await look();
  show('AFTER', after);
  const left = Object.entries(after).filter(([, v]) => v.length);
  console.log(left.length === 0
    ? 'NOTHING REMAINS on ' + location.origin + '. Reload the page. The wallet at http://localhost:5180 was not touched.'
    : 'STILL THERE: ' + left.map(([k, v]) => k + ' [' + v.join(', ') + ']').join('; ') + '. Close other tabs on ' + ONLY + ' and run this again.');
  return { refused: false, before, after };
})();
