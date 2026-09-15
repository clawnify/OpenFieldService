// Scheduled dates are local calendar days, not UTC instants.
export function calendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function weekRange(today = new Date()): [string, string] {
  const monday = new Date(today);
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [calendarDate(monday), calendarDate(sunday)];
}

export function daysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  const date = new Date(start + "T00:00:00");
  const last = new Date(end + "T00:00:00");
  while (date <= last) {
    days.push(calendarDate(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}
