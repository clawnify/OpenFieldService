import { timingSafeEqual } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { MaintenanceAutomationService } from "@/modules/maintenance/maintenance.automation";
function authorized(request:Request){const configured=getServerEnv().MAINTENANCE_SCHEDULER_SECRET,provided=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";if(!configured)return false;const a=Buffer.from(configured),b=Buffer.from(provided);return a.length===b.length&&timingSafeEqual(a,b)}
export async function POST(request:Request){if(!authorized(request))return Response.json({error:"Not found"},{status:404});const results=await new MaintenanceAutomationService().runTrustedAll({kind:"trusted_maintenance_scheduler"});return Response.json({organizations:results.length,results})}
