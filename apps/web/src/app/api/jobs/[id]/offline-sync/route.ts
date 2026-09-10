import { NextResponse } from "next/server";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError, ValidationError } from "@/lib/errors";
import { TechnicianSyncService } from "@/modules/technician-sync/technician-sync.service";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await currentActor();
    if (!actor) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    const { id } = await params;
    const data = await request.formData();
    const encoded = data.get("mutation");
    if (typeof encoded !== "string" || encoded.length > 100_000) throw new ValidationError("Invalid sync mutation");
    const mutation: unknown = JSON.parse(encoded);
    if (!mutation || typeof mutation !== "object" || (mutation as { jobId?: unknown }).jobId !== id) {
      throw new ValidationError("Sync Job does not match request path");
    }
    const staged = data.get("file");
    const file = staged instanceof File ? {
      bytes: new Uint8Array(await staged.arrayBuffer()),
      filename: staged.name,
      contentType: staged.type,
    } : undefined;
    const result = await new TechnicianSyncService().apply(actor, mutation, file);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid sync mutation" }, { status: 400 });
    if (error instanceof ApplicationError) {
      const status = error.code === "UNAUTHORIZED" ? 401 : error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION" ? 400 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Sync could not be completed" }, { status: 500 });
  }
}
