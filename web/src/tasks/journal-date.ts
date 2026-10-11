/** A journal's civil date spoken in English; UTC carries the label without a time-zone shift. */
export function spokenJournalDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).replace(',', '');
}

/** ISO weeks are named by their Thursday, including dates that fall in the neighbouring week-year. */
export function journalWeek(date: string): number {
  const thursday = new Date(`${date}T12:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3 - (thursday.getUTCDay() + 6) % 7);
  const first = new Date(thursday);
  first.setUTCMonth(0, 4);
  first.setUTCDate(first.getUTCDate() + 3 - (first.getUTCDay() + 6) % 7);
  return 1 + Math.round((thursday.getTime() - first.getTime()) / 604_800_000);
}
