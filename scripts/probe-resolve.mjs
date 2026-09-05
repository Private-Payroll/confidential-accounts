const mods = [
  'midnight-identity/profile/disclosure',
  'midnight-identity/profile/payload',
  'midnight-identity/profile/request',
  'midnight-identity/profile/channel',
];
for (const m of mods) {
  try { console.log(m, '->', import.meta.resolve(m)); }
  catch (e) { console.log(m, 'FAILED', e.message.split('\n')[0]); }
}
