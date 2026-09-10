import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import { MaintenanceAgreementReport } from "@/reports/maintenance-agreement-report";
import { assertUniqueChecklistKeys, calculateMaintenanceBenefit, contentHash, validateRequiredResponses } from "./maintenance-parity.rules";
import { createAssetSchema, createChecklistTemplateSchema, updateServiceReportSchema } from "./maintenance-parity.schema";
import { parseInput } from "@/lib/validation";
describe("Maintenance parity rules",()=>{
  const plan={discountType:"percent",discountBasisPoints:1000,discountFixedCents:null,includedServices:'["inspection"]',excludedServices:'["repair"]',equipmentEligibility:'["furnace"]'};
  it("applies exact eligible benefits and exclusions",()=>{expect(calculateMaintenanceBenefit(plan,"inspection","furnace",12345)).toBe(12345);expect(calculateMaintenanceBenefit(plan,"repair","furnace",12345)).toBe(0);expect(calculateMaintenanceBenefit(plan,"tuneup","furnace",12345)).toBe(1235);expect(calculateMaintenanceBenefit(plan,"tuneup","boiler",12345)).toBe(0)});
  it("enforces unique and required checklist items",()=>{expect(()=>assertUniqueChecklistKeys([{items:[{key:"a"}]},{items:[{key:"a"}]}])).toThrow(ConflictError);expect(()=>validateRequiredResponses([{items:[{key:"a",required:true}]}],{})).toThrow(ConflictError);expect(()=>validateRequiredResponses([{items:[{key:"a",required:true}]}],{a:true})).not.toThrow()});
  it("strictly validates assets, templates and completion evidence",()=>{expect(()=>parseInput(createAssetSchema,{customerId:crypto.randomUUID(),type:"furnace",serviceLocation:"x",organizationId:crypto.randomUUID()})).toThrow();expect(()=>parseInput(createChecklistTemplateSchema,{name:"Annual",sections:[{title:"Safety",items:[{key:"ok",label:"Safe",type:"PASS_FAIL",required:true}]}]})).not.toThrow();expect(()=>parseInput(updateServiceReportSchema,{responses:{},findings:"",deficiencies:"",recommendations:""})).toThrow()});
  it("hashes snapshots deterministically",()=>expect(contentHash({a:1})).toBe(contentHash({a:1})));
  it("renders a narrow signed Agreement PDF",async()=>{const pdf=await renderToBuffer(MaintenanceAgreementReport({model:{identifier:"MAINT-1",plan:{name:"Gold"},customer:{name:"Synthetic"},serviceLocation:{address:"100 Test"},effectiveDate:"2026-01-01",expiresOn:"2026-12-31",totalPriceCents:10000,currency:"CAD",terms:"Terms",coverage:[],signer:{name:"Synthetic",method:"typed",signedAt:"2026-01-01T00:00:00Z"},documentHash:"a".repeat(64)}}));expect(new Uint8Array(pdf).slice(0,5)).toEqual(new TextEncoder().encode("%PDF-"))});
});
