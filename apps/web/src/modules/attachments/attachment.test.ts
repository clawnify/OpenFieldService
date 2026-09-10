import { describe, expect, it, vi } from "vitest";
import { can } from "@/auth/permissions";
import { assertFileSignature, createObjectKey, safeDisplayFilename, type ObjectStorage } from "@/lib/r2";
import { AttachmentService } from "./attachment.service";
import type { AttachmentRepository } from "./attachment.repository";
import type { AttachmentUnitOfWork } from "./attachment.unit-of-work";
const uuid="00000000-0000-4000-8000-000000000001";
describe("attachment security and storage",()=>{
  it("generates scoped opaque keys and rejects path-like scopes",()=>{const key=createObjectKey(uuid,"note",uuid);expect(key).toMatch(new RegExp(`^organizations/${uuid}/note/${uuid}/[0-9a-f-]{36}$`));expect(()=>createObjectKey(uuid,"../deal",uuid)).toThrow();});
  it("sanitizes display filenames without using them as keys",()=>{expect(safeDisplayFilename("../folder\\report.pdf")).toBe("report.pdf");expect(()=>safeDisplayFilename(".." )).toThrow();});
  it("validates MIME signatures, non-empty size and allowlist",()=>{expect(()=>assertFileSignature(new TextEncoder().encode("%PDF-1.7"),"application/pdf")).not.toThrow();expect(()=>assertFileSignature(new TextEncoder().encode("not pdf"),"application/pdf")).toThrow();expect(()=>assertFileSignature(new Uint8Array(),"image/png")).toThrow();});
  it("keeps viewers read-only",()=>{expect(can({role:"viewer"},"attachment.read")).toBe(true);expect(can({role:"viewer"},"attachment.create")).toBe(false);expect(can({role:"manager"},"attachment.create")).toBe(true);expect(can({role:"manager"},"attachment.delete")).toBe(false);});
  it("deletes an uploaded object when metadata creation fails",async()=>{const storage:ObjectStorage={put:vi.fn(async()=>{}),delete:vi.fn(async()=>{}),signedDownloadUrl:vi.fn(async()=>"https://example.test")};let transaction=0;const uow={transaction:vi.fn(async(operation:(repositories:{targets:{exists():Promise<boolean>}})=>Promise<unknown>)=>{transaction++;if(transaction===1)return operation({targets:{exists:async()=>true}});throw new Error("database failed");})} as unknown as AttachmentUnitOfWork;const service=new AttachmentService({} as AttachmentRepository,async(actor)=>actor,uow,storage);await expect(service.uploadAttachment({userId:uuid,organizationId:uuid,role:"owner"},{filename:"report.pdf",contentType:"application/pdf",sizeBytes:8,targetType:"deal",targetId:uuid},new TextEncoder().encode("%PDF-1.7"))).rejects.toThrow("database failed");expect(storage.put).toHaveBeenCalledOnce();expect(storage.delete).toHaveBeenCalledOnce();});
});
