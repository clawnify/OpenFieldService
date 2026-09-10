import { ApplicationError } from "@/lib/errors";
import { PhoneOperationsService } from "@/modules/phone-operations/phone.service";

const xml = (value: string) => value.replace(/[<>&'\"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[c]!);
const response = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" } });

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const fields = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
    const result = await new PhoneOperationsService().receiveInboundForm(request.url, fields, request.headers.get("x-twilio-signature") ?? "");
    if (!result?.voiceRuntimeUrl) return response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"rejected\"/></Response>");
    return response(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(result.voiceRuntimeUrl)}"><Parameter name="callId" value="${xml(result.call.id)}"/></Stream></Connect></Response>`);
  } catch (error) {
    if (error instanceof ApplicationError) return response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"rejected\"/></Response>", error.code === "UNAUTHORIZED" ? 401 : 400);
    return response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"rejected\"/></Response>", 500);
  }
}
