export const REPORTING_TIMEZONE = "America/Vancouver";

export function vancouverBusinessDate(value = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function effectivePaymentCents(entryType: "payment" | "reversal", amountCents: number): number {
  return entryType === "reversal" ? -amountCents : amountCents;
}

export const dashboardMetricDefinitions = {
  totalJobs: "All non-archived Jobs in the organization; cancelled Jobs remain historical Jobs.",
  customers: "Active, non-archived Customers. Technician scope counts distinct Customers on assigned Jobs.",
  todayJobs: "Non-cancelled Jobs scheduled on the current America/Vancouver business date.",
  upcomingJobs: "Scheduled Jobs on or after the current America/Vancouver business date.",
  completedJobs: "Jobs whose authoritative current state is completed or invoiced.",
  netCollected: "Posted Payment entries minus posted reversal entries, grouped by currency; Invoice status never substitutes for cash movement.",
  outstandingInvoices: "Non-archived Invoices currently issued or partially paid.",
  overdueInvoices: "Outstanding Invoices whose due date is before the current America/Vancouver business date.",
} as const;
