import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { quoteOptionLines, quoteOptions, quotes, quoteStatusHistory, quoteVersions } from "@/db/schema";
export class EstimateRepository {
  constructor(private readonly db: DatabaseExecutor = getDb()) {}
  async nextSequence(org:string){const r=await this.db.select({n:sql<number>`coalesce(max(${quotes.sequenceNumber}),0)+1`}).from(quotes).where(eq(quotes.organizationId,org));return Number(r[0]!.n)}
  async createQuote(v:typeof quotes.$inferInsert){return(await this.db.insert(quotes).values(v).returning())[0]!}
  async createVersion(v:typeof quoteVersions.$inferInsert){return(await this.db.insert(quoteVersions).values(v).returning())[0]!}
  async setCurrent(org:string,id:string,versionId:string){await this.db.update(quotes).set({currentVersionId:versionId}).where(and(eq(quotes.organizationId,org),eq(quotes.id,id)))}
  async createOptions(v:(typeof quoteOptions.$inferInsert)[]){return this.db.insert(quoteOptions).values(v).returning()}
  find(org:string,id:string){return this.db.query.quotes.findFirst({where:and(eq(quotes.organizationId,org),eq(quotes.id,id),sql`${quotes.archivedAt} is null`)})}
  async lock(org:string,id:string){return(await this.db.select().from(quotes).where(and(eq(quotes.organizationId,org),eq(quotes.id,id))).for("update"))[0]}
  getVersion(org:string,id:string){return this.db.query.quoteVersions.findFirst({where:and(eq(quoteVersions.organizationId,org),eq(quoteVersions.id,id))})}
  async listOptions(org:string,quoteId:string,versionId:string){const options=await this.db.select().from(quoteOptions).where(and(eq(quoteOptions.organizationId,org),eq(quoteOptions.quoteId,quoteId),eq(quoteOptions.versionId,versionId))).orderBy(asc(quoteOptions.sortOrder));const lines=options.length?await this.db.select().from(quoteOptionLines).where(and(eq(quoteOptionLines.organizationId,org),inArray(quoteOptionLines.optionId,options.map(o=>o.id)))).orderBy(asc(quoteOptionLines.sortOrder)):[];return options.map(o=>({...o,lines:lines.filter(l=>l.optionId===o.id)}))}
  findOption(org:string,quoteId:string,id:string){return this.db.query.quoteOptions.findFirst({where:and(eq(quoteOptions.organizationId,org),eq(quoteOptions.quoteId,quoteId),eq(quoteOptions.id,id))})}
  async lockOption(org:string,id:string){return(await this.db.select().from(quoteOptions).where(and(eq(quoteOptions.organizationId,org),eq(quoteOptions.id,id))).for("update"))[0]}
  async addLine(v:typeof quoteOptionLines.$inferInsert){return(await this.db.insert(quoteOptionLines).values(v).returning())[0]!}
  lines(org:string,optionId:string){return this.db.select().from(quoteOptionLines).where(and(eq(quoteOptionLines.organizationId,org),eq(quoteOptionLines.optionId,optionId))).orderBy(asc(quoteOptionLines.sortOrder))}
  async updateOption(org:string,id:string,v:Partial<typeof quoteOptions.$inferInsert>){return(await this.db.update(quoteOptions).set({...v,rowVersion:sql`${quoteOptions.rowVersion}+1`}).where(and(eq(quoteOptions.organizationId,org),eq(quoteOptions.id,id))).returning())[0]}
  async clearRecommended(org:string,versionId:string){await this.db.update(quoteOptions).set({recommended:false}).where(and(eq(quoteOptions.organizationId,org),eq(quoteOptions.versionId,versionId)))}
  async transition(org:string,id:string,from:typeof quotes.$inferSelect.status,v:Partial<typeof quotes.$inferInsert>){return(await this.db.update(quotes).set({...v,updatedAt:new Date()}).where(and(eq(quotes.organizationId,org),eq(quotes.id,id),eq(quotes.status,from))).returning())[0]}
  async history(v:typeof quoteStatusHistory.$inferInsert){await this.db.insert(quoteStatusHistory).values(v)}
  async list(org:string,f:{query?:string;customerId?:string;status?:typeof quotes.$inferSelect.status;limit:number;offset:number}){const w=and(eq(quotes.organizationId,org),sql`${quotes.archivedAt} is null`,f.customerId?eq(quotes.customerId,f.customerId):undefined,f.status?eq(quotes.status,f.status):undefined,f.query?ilike(quotes.identifier,`%${f.query}%`):undefined);const[items,total]=await Promise.all([this.db.select().from(quotes).where(w).orderBy(desc(quotes.createdAt),asc(quotes.id)).limit(f.limit).offset(f.offset),this.db.select({n:count()}).from(quotes).where(w)]);return{items,total:total[0]?.n??0}}
}
