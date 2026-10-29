/** The same day of the month in another month, at local noon, clamped to that month's length (the 31st lands on the 30th or 28th). */
export function inMonth(from: Date, months: number, day: number): Date {
  const result = new Date(from.getFullYear(), from.getMonth() + months, 1, 12);
  result.setDate(Math.min(day, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
  return result;
}
