import"server-only";
import type{DatabaseExecutor}from"@/db";
import{ConflictError}from"@/lib/errors";
import{AuditRepository}from"@/modules/audit/audit.repository";
import{DrizzleCustomerRepository}from"@/modules/customers/customer.repository";
import{OrganizationRepository}from"@/modules/identity/organization.repository";
import{JobRepository}from"@/modules/jobs/job.repository";

export interface MaintenanceJobExecution{kind:"maintenance_automation";organizationId:string;occurrenceId:string}
export class MaintenanceJobGateway{async create(executor:DatabaseExecutor,context:MaintenanceJobExecution,input:{customerId:string;title:string;description:string;serviceAddress:string}){const organizations=new OrganizationRepository(executor),customers=new DrizzleCustomerRepository(executor),jobs=new JobRepository(executor),audit=new AuditRepository(executor);if(!await customers.findById(context.organizationId,input.customerId))throw new ConflictError("Maintenance Job customer is unavailable");await organizations.lock(context.organizationId);const sequenceNumber=await jobs.nextSequence(context.organizationId),job=await jobs.create({organizationId:context.organizationId,sequenceNumber,identifier:`JOB-${sequenceNumber}`,customerId:input.customerId,title:input.title,description:input.description,serviceAddress:input.serviceAddress,priority:"normal",scheduledDate:null,scheduledTime:null,durationMinutes:60,timezone:"America/Vancouver",createdBy:null,updatedBy:null});await jobs.addStatusHistory({organizationId:context.organizationId,jobId:job.id,fromStatus:null,toStatus:"scheduled",actorUserId:null,reason:"Recurring maintenance occurrence"});await audit.record({organizationId:context.organizationId,actorUserId:null,action:"job.created",entityType:"job",entityId:job.id,metadata:{source:"maintenance_occurrence",occurrenceId:context.occurrenceId}});return job}}
