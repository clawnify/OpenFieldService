import { NextResponse } from "next/server";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { ContractService } from "@/modules/contracts";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { try { const actor = await currentActor(), { id } = await params, result = await new ContractService().signedDocumentUrl(actor!, id); return NextResponse.redirect(result.url, 307); } catch (error) { if (error instanceof ApplicationError) return NextResponse.json({ error: error.message }, { status: error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "UNAUTHORIZED" ? 401 : 409 }); throw error; } }
