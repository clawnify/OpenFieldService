import { renderToBuffer } from "@react-pdf/renderer";
import { currentActor } from "@/auth/current-actor";
import { InvoiceService } from "@/modules/invoices";
import { InvoiceReport } from "@/reports/invoice-report";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const actor=await currentActor();if(!actor)return new Response("Not found",{status:404});try{const{id}=await params,model=await new InvoiceService().pdfModel(actor,id),pdf=await renderToBuffer(<InvoiceReport model={model}/>);return new Response(new Uint8Array(pdf),{headers:{"content-type":"application/pdf","content-disposition":`inline; filename="${model.identifier}.pdf"`,"cache-control":"private, no-store"}})}catch{return new Response("Not found",{status:404})}}
