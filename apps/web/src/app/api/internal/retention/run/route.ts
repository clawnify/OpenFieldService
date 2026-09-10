import { timingSafeEqual } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { RetentionAutomationService } from "@/modules/retention";
function authorized(request:Request){const configured=getServerEnv().MAINTENANCE_SCHEDULER_SECRET,provided=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";if(!configured)return false;const expected=Buffer.from(configured),actual=Buffer.from(provided);return expected.length===actual.length&&timingSafeEqual(expected,actual);}
export async function POST(request:Request){if(!authorized(request))return Response.json({error:"Not found"},{status:404});const results=await new RetentionAutomationService().runTrustedAll({kind:"trusted_retention_scheduler"});return Response.json({organizations:results.length,results});}
