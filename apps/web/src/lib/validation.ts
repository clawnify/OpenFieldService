import { z } from "zod";
import { ValidationError } from "./errors";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError("Invalid input", result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
}
