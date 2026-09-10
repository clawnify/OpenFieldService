import { z } from "zod";
const id=z.uuid();
export const mutateLineSchema=z.strictObject({description:z.string().trim().min(1).max(1000),category:z.enum(["service","labor","material","equipment","other"]),quantityMilli:z.int().min(1).max(1_000_000),unit:z.string().trim().min(1).max(40),unitPriceCents:z.int().nonnegative().max(9_000_000_000_000),taxable:z.boolean(),expectedRowVersion:z.int().nonnegative()});
export const reorderLinesSchema=z.strictObject({optionId:id,lineIds:z.array(id).min(1).max(200),expectedRowVersion:z.int().nonnegative()}).superRefine((v,c)=>{if(new Set(v.lineIds).size!==v.lineIds.length)c.addIssue({code:"custom",path:["lineIds"],message:"Line IDs must be unique"})});
export const createRevisionSchema=z.strictObject({reason:z.string().trim().max(1000).optional()});
export const publicSelectionSchema=z.strictObject({optionId:id,selectorName:z.string().trim().min(1).max(200)});
export const publicTokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
