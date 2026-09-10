import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url().startsWith("postgresql://"),
  AUTH_SECRET: z.string().min(32),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ENDPOINT: z.url().optional(),
  MAINTENANCE_SCHEDULER_SECRET: z.string().min(32).optional(),
  PHONE_OPERATIONS_ENCRYPTION_KEY: z.string().min(32).optional(),
}).superRefine((value, context) => {
  const r2 = [value.R2_ACCOUNT_ID, value.R2_ACCESS_KEY_ID, value.R2_SECRET_ACCESS_KEY, value.R2_BUCKET, value.R2_ENDPOINT];
  if (r2.some(Boolean) && !r2.every(Boolean)) context.addIssue({ code: "custom", message: "R2 variables must be configured together" });
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= serverEnvSchema.parse(process.env);
  return cached;
}
