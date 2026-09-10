import { ConflictError, ValidationError } from "@/lib/errors";
export const DEFAULT_JOB_TIMEZONE="America/Vancouver";
export function isValidIanaTimezone(value:string){if(value==="UTC")return true;try{return Intl.supportedValuesOf("timeZone").includes(value);}catch{return false;}}
export function timeToMinutes(value:string){const[h,m]=value.split(":").map(Number);return h*60+m;}
export function overlaps(startA:number,durationA:number,startB:number,durationB:number){return startA<startB+durationB&&startB<startA+durationA;}
export function assertTransition(from:string,to:string,reopenTarget?:string|null){if(from===to)throw new ConflictError(`Job is already ${to}`);if(from==="cancelled"){if(to!==reopenTarget)throw new ConflictError("Cancelled Job can only reopen to its prior state");return;}const next:{[key:string]:string[] }={scheduled:["in_progress","cancelled"],in_progress:["completed","cancelled"],completed:["invoiced"],invoiced:[]};if(!next[from]?.includes(to))throw new ConflictError(`Cannot transition Job from ${from} to ${to}`);if(to==="completed")throw new ConflictError("Completion requires the deferred compliance report and signature workflow");}
export function assertTimezone(value:string){if(!isValidIanaTimezone(value))throw new ValidationError("Timezone must be a canonical IANA timezone");}
