import { NextResponse } from "next/server";
import { ApplicationError } from "@/lib/errors";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const { id } = await params, result = await new PhoneOperationsService().invokeTool(bearer(request), id, await request.json()); return NextResponse.json(result, { headers: { "cache-control": "no-store" } }); } catch (error) { if (error instanceof ApplicationError) return NextResponse.json({ error: error.message }, { status: error.code === "UNAUTHORIZED" ? 401 : error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 409 }); return NextResponse.json({ error: "Phone tool invocation failed" }, { status: 500 }); } }
