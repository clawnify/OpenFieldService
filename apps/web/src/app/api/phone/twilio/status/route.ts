import { NextResponse } from "next/server";
import { ApplicationError } from "@/lib/errors";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";

export async function POST(request: Request) {
  try {
    const form = await request.formData(), fields = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
    await new PhoneOperationsService().receiveProviderEventForm(request.url, fields, request.headers.get("x-twilio-signature") ?? "");
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ApplicationError) return NextResponse.json({ error: error.code === "UNAUTHORIZED" ? "Invalid provider request" : error.message }, { status: error.code === "UNAUTHORIZED" ? 401 : 400 });
    return NextResponse.json({ error: "Provider event could not be processed" }, { status: 500 });
  }
}
