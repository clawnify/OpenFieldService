import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { ConflictError } from "@/lib/errors";
import { PaymentReceipt } from "@/reports/payment-receipt";
import { paymentFilterSchema, postPaymentSchema, reversePaymentSchema } from "./payment.schema";
import { effectiveAmountPaid, paymentBusinessDate, reconciledInvoiceStatus } from "./payment.rules";

describe("Payment domain rules",()=>{
  it("reconciles an append-only payment and reversal ledger",()=>{expect(effectiveAmountPaid([{entryType:"payment",amountCents:4000},{entryType:"payment",amountCents:6000}])).toBe(10000);expect(effectiveAmountPaid([{entryType:"payment",amountCents:4000},{entryType:"reversal",amountCents:4000}])).toBe(0);expect(()=>effectiveAmountPaid([{entryType:"reversal",amountCents:1}])).toThrow(ConflictError)});
  it("derives only issued, partially-paid and paid Invoice states",()=>{expect(reconciledInvoiceStatus(10000,0)).toBe("issued");expect(reconciledInvoiceStatus(10000,1)).toBe("partially_paid");expect(reconciledInvoiceStatus(10000,10000)).toBe("paid");expect(()=>reconciledInvoiceStatus(10000,10001)).toThrow(ConflictError)});
  it("strictly validates payment, reversal and bounded filters",()=>{expect(postPaymentSchema.safeParse({amountCents:100,payerType:"customer",method:"cash"}).success).toBe(true);expect(postPaymentSchema.safeParse({amountCents:0,payerType:"customer",method:"cash"}).success).toBe(false);expect(postPaymentSchema.safeParse({amountCents:100,payerType:"customer",method:"cash",organizationId:crypto.randomUUID(),rawCredential:"forbidden"}).success).toBe(false);expect(reversePaymentSchema.safeParse({reason:"  "}).success).toBe(false);expect(paymentFilterSchema.safeParse({limit:101}).success).toBe(false)});
  it("uses the Vancouver business date and office-only permissions",()=>{expect(paymentBusinessDate(new Date("2026-01-01T07:30:00Z"))).toBe("2025-12-31");expect(can({role:"manager"},"payment.create")).toBe(true);expect(can({role:"member"},"payment.read")).toBe(false);expect(can({role:"viewer"},"payment.receipt.read")).toBe(false)});
  it("renders a receipt from immutable payment facts",async()=>{const bytes=await renderToBuffer(<PaymentReceipt model={{paymentId:crypto.randomUUID(),invoiceIdentifier:"INV-1",customerName:"Synthetic Customer",amountCents:2500,currency:"CAD",payerType:"customer",method:"cash",source:"manual",externalReference:"TEST-1",receivedBy:"Synthetic Clerk",postedAt:new Date("2026-09-08T12:00:00Z"),reversed:false,reversalReason:null,invoiceTotalCents:5000,amountPaidCents:2500,balanceCents:2500}}/>);expect(new Uint8Array(bytes).slice(0,4).toString()).toBe("37,80,68,70")});
});
