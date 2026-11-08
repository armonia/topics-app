/** Format an author timestamp like Git's `%ar`, without starting Git. */
export function gitRelativeDate(authorTime: number, now = Math.floor(Date.now() / 1000)): string {
  const seconds = Math.abs(now - authorTime);
  const future = authorTime > now;
  const result = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  let value: number;

  if (seconds < 90) {
    value = seconds;
    return relative(result(value, "second"), future);
  }
  value = Math.floor((seconds + 30) / 60);
  if (value < 90) return relative(result(value, "minute"), future);
  value = Math.floor((value + 30) / 60);
  if (value < 36) return relative(result(value, "hour"), future);
  value = Math.floor((value + 12) / 24);
  const days = value;
  if (value < 14) return relative(result(value, "day"), future);
  value = Math.floor((value + 3) / 7);
  if (days < 70) return relative(result(value, "week"), future);
  value = Math.floor((days * 12 + 182) / 365);
  if (days < 365) return relative(result(value, "month"), future);
  const totalMonths = value;
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  if (years >= 5) return relative(result(Math.floor((seconds + 183 * 86400) / (365 * 86400)), "year"), future);
  const label = months === 0
    ? result(years, "year")
    : `${result(years, "year")}, ${result(months, "month")}`;
  return relative(label, future);
}

function relative(label: string, future: boolean): string {
  return future ? "in the future" : `${label} ago`;
}
