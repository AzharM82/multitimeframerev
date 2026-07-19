// Ported from ShouldIBeTrading (api/src/lib/marketHours.ts).

export function getETTime(): Date {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(etString);
}

export function isMarketOpen(): boolean {
  const et = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return false; // weekend

  const hours = et.getHours();
  const minutes = et.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  // 9:30 AM = 570, 4:00 PM = 960
  return totalMinutes >= 570 && totalMinutes < 960;
}

export function isWeekday(): boolean {
  const et = getETTime();
  const day = et.getDay();
  return day !== 0 && day !== 6;
}

export function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

export function today(): string {
  return formatDate(new Date());
}
