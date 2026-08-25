import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";

/**
 * Phase 13A final document hardening — the generic, document-neutral PDF
 * layout kernel (page/y-cursor management, word-wrapping text, a bordered
 * table, a "Label: value" row, page footers, WinAnsi sanitization, and
 * logo embedding). Extracted out of contract-pdf.ts, which was this
 * module's only caller before this pass, so the new invoice-pdf.ts can
 * reuse the exact same primitives instead of a second copy-pasted
 * implementation (Section 50 — "avoid copy-paste between Contract and
 * Invoice"). This module knows nothing about Contracts, Invoices,
 * Company Profiles, or R2 — it is a pure, stable, industry-neutral PDF
 * rendering primitive, the kind of thing that genuinely belongs in a
 * shared kernel rather than being duplicated per document type.
 */

export const PAGE_WIDTH = 612; // US Letter, points (72pt/in)
export const PAGE_HEIGHT = 792;
export const MARGIN = 54;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
export const FOOTER_RESERVE = 40;
export const BOTTOM_LIMIT = MARGIN + FOOTER_RESERVE;

export const INK = rgb(0.12, 0.12, 0.14);
export const MUTED = rgb(0.42, 0.42, 0.46);
export const RULE = rgb(0.82, 0.82, 0.85);
export const ACCENT = rgb(0.09, 0.45, 0.27); // matches the app's green accent, loosely

/** WinAnsiEncoding's characters above U+00FF — the common Microsoft/CP1252
 *  punctuation set (smart quotes, em/en dash, ellipsis, trademark, etc.).
 *  These are genuinely encodable by the base-14 fonts despite having
 *  Unicode code points above 255, so a plain "code point <= 0xFF" check
 *  (this file's first version) is wrong: it would replace a perfectly
 *  renderable em-dash with "?". Only characters truly outside
 *  WinAnsiEncoding (CJK, Cyrillic, Arabic, etc.) should be replaced. */
export const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Base-14 StandardFonts only support WinAnsiEncoding — replace anything
 *  outside that range with "?" rather than letting pdf-lib throw and
 *  failing the entire document generation over one unsupported character.
 *
 *  SECURITY (P1, found by independent review during the original Contract
 *  PDF hardening pass): a plain "code point <= 0xFF passes" check is wrong
 *  in the OTHER direction too — WinAnsiEncoding does not define glyphs for
 *  the C0 control range (0x00-0x1F), DEL (0x7F), or the C1 control range
 *  (0x80-0x9F), even though their code points are <= 0xFF. Whitespace
 *  controls that carry real meaning (tab/LF/CR — wrapText() splits on
 *  newlines) are explicitly preserved; every other C0/C1 control is
 *  replaced with "?" exactly like any other unencodable character. */
const PRESERVED_WHITESPACE = new Set([0x09, 0x0a, 0x0d]); // tab, LF, CR
function isControlCharacter(code: number): boolean {
  if (PRESERVED_WHITESPACE.has(code)) return false;
  return (code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

export function sanitizeForPdf(text: string): string {
  return Array.from(text ?? "").map((ch) => {
    const code = ch.codePointAt(0)!;
    if (isControlCharacter(code)) return "?";
    return code <= 0xff || WINANSI_EXTRA.has(code) ? ch : "?";
  }).join("");
}

interface Fonts { regular: PDFFont; bold: PDFFont; italic: PDFFont }

/** Greedy word-wrap against a font/size/max-width — pdf-lib has no
 *  built-in text layout, so this is the minimum needed to avoid clipping
 *  or overlapping long text bodies, long descriptions, or long names. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitizeForPdf(text).split(/\r?\n/)) {
    if (paragraph.trim() === "") { lines.push(""); continue; }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export class PdfWriter {
  doc: PDFDocument;
  fonts: Fonts;
  page!: PDFPage;
  y = 0;

  private constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc;
    this.fonts = fonts;
  }

  static async create(): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    const fonts: Fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    };
    const writer = new PdfWriter(doc, fonts);
    writer.newPage();
    return writer;
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  ensureSpace(height: number): void {
    if (this.y - height < BOTTOM_LIMIT) this.newPage();
  }

  spacer(height: number): void {
    this.y -= height;
  }

  hr(): void {
    this.ensureSpace(10);
    this.y -= 6;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness: 0.75, color: RULE });
    this.y -= 10;
  }

  heading(text: string): void {
    this.ensureSpace(20);
    this.page.drawText(sanitizeForPdf(text), { x: MARGIN, y: this.y, size: 12, font: this.fonts.bold, color: ACCENT });
    this.y -= 18;
  }

  /** Wrapped, page-breaking paragraph/line writer — the workhorse every
   *  text section is built from. */
  text(str: string, opts: { size?: number; bold?: boolean; italic?: boolean; color?: ReturnType<typeof rgb>; lineGap?: number; maxWidth?: number; x?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.fonts.bold : opts.italic ? this.fonts.italic : this.fonts.regular;
    const color = opts.color ?? INK;
    const lineGap = opts.lineGap ?? size * 1.4;
    const x = opts.x ?? MARGIN;
    const maxWidth = opts.maxWidth ?? (PAGE_WIDTH - MARGIN - x);
    for (const line of wrapText(str, font, size, maxWidth)) {
      this.ensureSpace(lineGap);
      if (line) this.page.drawText(line, { x, y: this.y, size, font, color });
      this.y -= lineGap;
    }
  }

  /** A single "Label: value" row — used throughout metadata sections.
   *  Wraps the value if it's too long to fit on one line rather than
   *  letting it run off the page edge. */
  labelValue(label: string, value: string): void {
    const valueX = MARGIN + 110;
    const valueWidth = PAGE_WIDTH - MARGIN - valueX;
    const lines = wrapText(value || "—", this.fonts.regular, 9, valueWidth);
    this.ensureSpace(14 * lines.length);
    this.page.drawText(sanitizeForPdf(label), { x: MARGIN, y: this.y, size: 9, font: this.fonts.bold, color: MUTED });
    lines.forEach((line, i) => {
      this.page.drawText(line, { x: valueX, y: this.y - i * 14, size: 9, font: this.fonts.regular, color: INK });
    });
    this.y -= 14 * lines.length;
  }

  /** Simple bordered table with a header row, right-aligned numeric
   *  columns, and per-row text wrapping (so a long cell never clips or
   *  overlaps the next row). */
  table(headers: string[], rows: string[][], colWidths: number[], alignRight: boolean[]): void {
    const rowPad = 4;
    const headerHeight = 16;
    this.ensureSpace(headerHeight + 20);
    let x = MARGIN;
    this.page.drawRectangle({ x: MARGIN, y: this.y - headerHeight, width: CONTENT_WIDTH, height: headerHeight, color: rgb(0.94, 0.95, 0.94) });
    headers.forEach((h, i) => {
      const w = colWidths[i];
      const tx = alignRight[i] ? x + w - this.fonts.bold.widthOfTextAtSize(h, 8) - rowPad : x + rowPad;
      this.page.drawText(sanitizeForPdf(h), { x: tx, y: this.y - 11, size: 8, font: this.fonts.bold, color: MUTED });
      x += w;
    });
    this.y -= headerHeight;

    for (const row of rows) {
      const wrapped = row.map((cell, i) => wrapText(cell, this.fonts.regular, 9, colWidths[i] - rowPad * 2));
      const rowLines = Math.max(1, ...wrapped.map((w) => w.length));
      const rowHeight = rowLines * 12 + rowPad * 2;
      this.ensureSpace(rowHeight);
      x = MARGIN;
      row.forEach((_cell, i) => {
        const w = colWidths[i];
        wrapped[i].forEach((line, li) => {
          const ty = this.y - rowPad - 9 - li * 12;
          const tx = alignRight[i] ? x + w - this.fonts.regular.widthOfTextAtSize(line, 9) - rowPad : x + rowPad;
          this.page.drawText(line, { x: tx, y: ty, size: 9, font: this.fonts.regular, color: INK });
        });
        x += w;
      });
      this.y -= rowHeight;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    }
  }

  /** Embeds an image (PNG or JPEG bytes — a company logo or a captured
   *  drawn signature) and draws it at (MARGIN, current y) on the CURRENT
   *  page, scaled to fit within maxWidth/maxHeight while preserving aspect
   *  ratio. Returns the drawn dimensions so the caller can offset
   *  following content around it. Never throws on a malformed image — a
   *  broken/corrupt image must not be able to fail document generation;
   *  the caller should treat a null return as "no image," not an error. */
  async drawImage(bytes: Uint8Array, format: "png" | "jpeg", maxWidth = 90, maxHeight = 60): Promise<{ width: number; height: number } | null> {
    let image: PDFImage;
    try {
      image = format === "png" ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    } catch {
      return null;
    }
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;
    this.page.drawImage(image, { x: MARGIN, y: this.y - height, width, height });
    return { width, height };
  }

  /** Draws a consistent footer on every page, called once at the very end
   *  once the total page count is known (page numbering needs "Page X of
   *  Y"). `tenantNote` is optional free text (e.g. a Default Contract
   *  Footer) rendered as up to 2 wrapped lines above the fixed
   *  identifier/page-number line, on every page. */
  finalizeFooters(footerLeft: string, tenantNote?: string): void {
    const pages = this.doc.getPages();
    const noteLines = tenantNote
      ? wrapText(tenantNote, this.fonts.regular, 7.5, CONTENT_WIDTH).slice(0, 2)
      : [];
    const ruleY = MARGIN - 6;
    pages.forEach((page, i) => {
      const label = `${footerLeft}  ·  Page ${i + 1} of ${pages.length}`;
      page.drawLine({ start: { x: MARGIN, y: ruleY }, end: { x: PAGE_WIDTH - MARGIN, y: ruleY }, thickness: 0.5, color: RULE });
      page.drawText(sanitizeForPdf(label), { x: MARGIN, y: ruleY - 12, size: 7.5, font: this.fonts.regular, color: MUTED });
      // Tenant note lines sit above the rule, closest line first.
      noteLines.forEach((line, li) => {
        page.drawText(sanitizeForPdf(line), { x: MARGIN, y: ruleY + 2 + (noteLines.length - 1 - li) * 10, size: 7.5, font: this.fonts.regular, color: MUTED });
      });
    });
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toUTCString().replace(" GMT", " UTC");
}

export function formatDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : `${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().split("T")[0];
}
