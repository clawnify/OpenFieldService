export interface TaxComponentInput { code:string; name:string; rateBasisPoints:number }
export interface TaxResult { taxableBaseCents:number; subtotalCents:number; totalTaxCents:number; totalCents:number; components:Array<TaxComponentInput&{amountCents:number}> }
function roundDiv(n:bigint,d:bigint){return Number((n+d/2n)/d)}
export function calculateTax(lines:{amountCents:number;taxable:boolean}[],profile:{enabled:boolean;pricesIncludeTax:boolean;components:TaxComponentInput[]}):TaxResult {
  const taxable=lines.filter(x=>x.taxable).reduce((n,x)=>n+x.amountCents,0),nonTaxable=lines.filter(x=>!x.taxable).reduce((n,x)=>n+x.amountCents,0),rate=profile.components.reduce((n,x)=>n+x.rateBasisPoints,0);
  if(!profile.enabled||!rate)return{taxableBaseCents:taxable,subtotalCents:taxable+nonTaxable,totalTaxCents:0,totalCents:taxable+nonTaxable,components:[]};
  const base=profile.pricesIncludeTax?roundDiv(BigInt(taxable)*10000n,BigInt(10000+rate)):taxable;
  const tax=profile.pricesIncludeTax?taxable-base:roundDiv(BigInt(base)*BigInt(rate),10000n);
  let allocated=0;
  const components=profile.components.map((x,i)=>{const amount=i===profile.components.length-1?tax-allocated:Number(BigInt(tax)*BigInt(x.rateBasisPoints)/BigInt(rate));allocated+=amount;return{code:x.code,name:x.name,rateBasisPoints:x.rateBasisPoints,amountCents:amount}});
  return{taxableBaseCents:base,subtotalCents:base+nonTaxable,totalTaxCents:tax,totalCents:profile.pricesIncludeTax?taxable+nonTaxable:base+nonTaxable+tax,components};
}
