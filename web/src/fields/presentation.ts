/** Conservative English suffixes, mirrored by core notes::auto_plural. */
export function autoPlural(title: string): string {
  if (!title || [...title].some(c => /\p{L}/u.test(c) && !/[A-Za-z\u00c0-\u024f]/u.test(c))) return title;
  const lower = title.toLowerCase();
  let stem = title, suffix = 's';
  if (lower.endsWith('is')) { stem = title.slice(0, -2); suffix = 'es'; }
  else if (/(ss|us|x|z|ch|sh)$/.test(lower)) suffix = 'es';
  else if (lower.endsWith('s')) return title;
  else if (/[^aeiou\W\d_]y$/.test(lower)) { stem = title.slice(0, -1); suffix = 'ies'; }
  return stem + (title === title.toUpperCase() ? suffix.toUpperCase() : suffix);
}
