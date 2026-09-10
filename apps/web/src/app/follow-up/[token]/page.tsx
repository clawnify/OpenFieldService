import { notFound } from "next/navigation";
import { ApplicationError } from "@/lib/errors";
import { RetentionService } from "@/modules/retention";
import { FollowUpForm } from "./follow-up-form";

export default async function FollowUpPage({params}:{params:Promise<{token:string}>}){const{token}=await params;let view;try{view=await new RetentionService().publicFollowUpView(token);}catch(error){if(error instanceof ApplicationError)notFound();throw error;}const complete=["satisfied","needs_attention","closed"].includes(view.status);return <main className="mx-auto max-w-xl px-4 py-12 sm:px-6"><p className="text-sm font-medium text-primary">Service follow-up · {view.jobIdentifier}</p><h1 className="mt-2 text-4xl font-semibold">How did we do?</h1><p className="mt-3 text-muted-foreground">Hi {view.customerName}, we’d appreciate feedback on your recent service.</p>{complete?<section className="mt-8 rounded-xl border p-6"><h2 className="text-xl font-semibold">Thanks, we already received your response.</h2><p className="mt-2 text-muted-foreground">There’s nothing else you need to submit.</p></section>:<FollowUpForm token={token}/>}</main>}
