import { z } from "zod";
import { parseInput } from "@/lib/validation";

export function nullable(value: string | undefined): string | null | undefined { return value === undefined ? undefined : value || null; }
export function changedFields(input: object): string[] { return Object.keys(input).sort(); }
export function parseEntityId(value: string): string { return parseInput(z.uuid(), value); }
