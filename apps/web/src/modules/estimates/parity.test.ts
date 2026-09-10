import { describe, expect, it } from "vitest";
import { calculateTax } from "./tax.rules";
import { publicTokenSchema, reorderLinesSchema } from "./parity.schema";
describe("Estimate parity rules",()=>{const components=[{code:"GST",name:"GST",rateBasisPoints:500},{code:"PST",name:"PST",rateBasisPoints:700}];
it("calculates exclusive component tax with exact allocation",()=>expect(calculateTax([{amountCents:10000,taxable:true},{amountCents:1000,taxable:false}],{enabled:true,pricesIncludeTax:false,components})).toEqual({taxableBaseCents:10000,subtotalCents:11000,totalTaxCents:1200,totalCents:12200,components:[{...components[0],amountCents:500},{...components[1],amountCents:700}]}));
it("extracts inclusive tax without double taxation",()=>expect(calculateTax([{amountCents:11200,taxable:true}],{enabled:true,pricesIncludeTax:true,components})).toMatchObject({taxableBaseCents:10000,totalTaxCents:1200,totalCents:11200}));
it("validates 256-bit URL-safe tokens",()=>{expect(publicTokenSchema.safeParse("a".repeat(43)).success).toBe(true);expect(publicTokenSchema.safeParse("short").success).toBe(false)});
it("rejects duplicate reorder IDs",()=>expect(reorderLinesSchema.safeParse({optionId:"00000000-0000-4000-8000-000000000001",lineIds:["00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000002"],expectedRowVersion:0}).success).toBe(false));});
