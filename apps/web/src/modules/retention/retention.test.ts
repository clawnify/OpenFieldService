import { describe, expect, it } from "vitest";
import { can } from "@/auth/permissions";
import { addBusinessDays, assertCampaignTransition, assertNotSelfReferral, channels, createRetentionCapability, creditBalance, hashRetentionCapability, retentionState } from "./retention.rules";
import { followUpResponseSchema, publicCapabilitySchema, retentionSettingsSchema } from "./retention.schema";

describe("retention rules", () => {
  it("enforces campaign lifecycle and channel expansion", () => { expect(() => assertCampaignTransition("draft", "scheduled")).not.toThrow(); expect(() => assertCampaignTransition("completed", "scheduled")).toThrow(); expect(channels("both")).toEqual(["email", "sms"]); });
  it("normalizes self-referral contacts", () => { expect(() => assertNotSelfReferral({ email: null, phone: "+1 (604) 555-1212" }, { phone: "16045551212" })).toThrow(); });
  it("uses issued ledger entries only", () => expect(creditBalance([{ amountCents: 500, status: "issued" }, { amountCents: 200, status: "voided" }])).toBe(500));
  it("computes deterministic retention state", () => expect(retentionState(new Date("2025-01-01T00:00:00Z"), 2, false, new Date("2026-02-01T00:00:00Z"))).toMatchObject({ repeatCustomer: true, atRisk: true, winBackEligible: true }));
  it("keeps technicians out of marketing administration", () => { expect(can({ role: "member" }, "campaign.read")).toBe(false); expect(can({ role: "manager" }, "campaign.read")).toBe(true); expect(can({ role: "manager" }, "campaign.manage")).toBe(false); expect(can({ role: "admin" }, "campaign.execute")).toBe(true); });
  it("mints high-entropy public capabilities and stores only a deterministic hash",()=>{const raw=createRetentionCapability();expect(raw.length).toBeGreaterThanOrEqual(43);expect(publicCapabilitySchema.parse(raw)).toBe(raw);expect(hashRetentionCapability(raw)).toMatch(/^[a-f0-9]{64}$/);expect(hashRetentionCapability(raw)).not.toContain(raw);});
  it("validates immutable satisfaction choices and bounded notes",()=>{expect(followUpResponseSchema.parse({response:"satisfied"})).toEqual({response:"satisfied",notes:""});expect(()=>followUpResponseSchema.parse({response:"positive"})).toThrow();expect(()=>followUpResponseSchema.parse({response:"needs_attention",organizationId:"forged"})).toThrow();});
  it("strictly validates delay and configured public URLs",()=>{expect(retentionSettingsSchema.parse({followUpDelayDays:0,publicBaseUrl:"",reviewUrl:"https://reviews.example.test/leave"})).toEqual({followUpDelayDays:0,publicBaseUrl:null,reviewUrl:"https://reviews.example.test/leave"});expect(()=>retentionSettingsSchema.parse({followUpDelayDays:366,publicBaseUrl:"",reviewUrl:""})).toThrow();expect(()=>retentionSettingsSchema.parse({followUpDelayDays:7,publicBaseUrl:"javascript:alert(1)",reviewUrl:""})).toThrow();});
  it("uses Vancouver business dates for configured follow-up delay",()=>expect(addBusinessDays(new Date("2026-03-08T07:30:00Z"),1)).toBe("2026-03-09"));
});
