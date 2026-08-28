import { PdfWriter, sanitizeForPdf, formatDateTime, MARGIN, INK, MUTED } from "./pdf-writer.js";
import type { ServiceReportRow } from "./maintenance-service-reports.js";

/**
 * Phase 19B — Digital Maintenance Service Report PDF. Same shared
 * `pdf-writer.ts` kernel as Contracts/Agreements. Rendered exactly once at
 * finalization (see maintenance-service-reports.ts's finalizeServiceReport)
 * — never re-rendered afterward. Internal notes are deliberately NEVER
 * rendered here (Section 20: "Keep internal notes separate" — this is the
 * customer-facing artifact).
 */

export interface ServiceReportPdfInput {
  report: ServiceReportRow;
  jobId: number;
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  PASS_FAIL: "Pass/Fail", YES_NO: "Yes/No", TEXT: "Text", NUMBER: "Number", MEASUREMENT: "Measurement", SELECT: "Select", PHOTO_REQUIRED: "Photo",
};

export async function renderServiceReportPdf(input: ServiceReportPdfInput): Promise<Uint8Array> {
  const w = await PdfWriter.create();
  const { report } = input;
  const checklist = JSON.parse(report.checklist_snapshot || "[]") as { title: string; items: { id: string; label: string; input_type: string }[] }[];
  const results = JSON.parse(report.checklist_results || "{}") as Record<string, unknown>;
  const measurements = JSON.parse(report.measurements || "{}") as Record<string, unknown>;
  const ack = JSON.parse(report.customer_acknowledgement || "{}") as { signer_name?: string; relationship?: string; signed_at?: string };

  w.page.drawText("MAINTENANCE SERVICE REPORT", { x: MARGIN, y: w.y, size: 16, font: w.fonts.bold, color: INK });
  w.y -= 22;
  w.labelValue("Job ID:", String(report.job_id));
  w.labelValue("Report ID:", String(report.id));
  w.labelValue("Status:", report.status === "finalized" ? `Finalized · ${formatDateTime(report.finalized_at)}` : "Draft");
  w.hr();

  w.heading("Work Performed");
  w.text(report.work_performed || "—", { size: 9.5 });
  w.spacer(10);

  if (checklist.length > 0) {
    w.heading("Checklist Results");
    for (const section of checklist) {
      w.text(section.title, { size: 10, bold: true });
      const rows = section.items.map((item) => [item.label, ITEM_TYPE_LABELS[item.input_type] || item.input_type, formatResultValue(results[item.id])]);
      w.table(["Item", "Type", "Result"], rows, [220, 100, 140], [false, false, false]);
      w.spacer(6);
    }
  }

  const measurementEntries = Object.entries(measurements);
  if (measurementEntries.length > 0) {
    w.heading("Measurements");
    for (const [key, value] of measurementEntries) {
      w.labelValue(`${sanitizeForPdf(key)}:`, String(value));
    }
    w.spacer(10);
  }

  w.heading("Findings");
  w.text(report.findings || "None noted.", { size: 9.5 });
  w.spacer(10);

  w.heading("Recommendations");
  w.text(report.recommendations || "None.", { size: 9.5 });
  w.spacer(10);

  if (report.notes.trim()) {
    w.heading("Notes");
    w.text(report.notes, { size: 9.5 });
    w.spacer(10);
  }

  w.heading("Customer Acknowledgement");
  if (ack.signer_name) {
    w.labelValue("Acknowledged by:", ack.signer_name);
    if (ack.relationship) w.labelValue("Relationship:", ack.relationship);
    if (ack.signed_at) w.labelValue("Date:", formatDateTime(ack.signed_at));
  } else {
    w.text("No customer acknowledgement was captured for this visit.", { size: 9, color: MUTED });
  }

  w.finalizeFooters(`Service Report #${report.id} · Job #${report.job_id}`);
  return w.save();
}

function formatResultValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return sanitizeForPdf(String(value));
}
