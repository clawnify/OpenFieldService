import { renderToBuffer } from "@react-pdf/renderer";
import { currentActor } from "@/auth/current-actor";
import { PaymentService } from "@/modules/payments";
import { PaymentReceipt } from "@/reports/payment-receipt";

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){const actor=await currentActor();if(!actor)return new Response("Not found",{status:404});try{const{id}=await params,model=await new PaymentService().receiptModel(actor,id),pdf=await renderToBuffer(<PaymentReceipt model={model}/>);return new Response(new Uint8Array(pdf),{headers:{"content-type":"application/pdf","content-disposition":`inline; filename="receipt-${model.invoiceIdentifier}-${model.paymentId}.pdf"`,"cache-control":"private, no-store"}})}catch{return new Response("Not found",{status:404})}}
