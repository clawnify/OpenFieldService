import "server-only";
import { compare, hash } from "bcryptjs";

const PASSWORD_COST = 12;
const DUMMY_HASH = "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxvF8QHuUueJ.fRmY3izW4Y2B/G";

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_COST);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

export function verifyPasswordOrDummy(password: string, passwordHash?: string | null): Promise<boolean> {
  return compare(password, passwordHash ?? DUMMY_HASH);
}
