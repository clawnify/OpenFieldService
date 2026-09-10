export type ApplicationErrorCode = "VALIDATION" | "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT";

export class ApplicationError extends Error {
  constructor(public readonly code: ApplicationErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  constructor(message = "Invalid input", public readonly issues: ReadonlyArray<{ path: string; message: string }> = []) { super("VALIDATION", message); }
}

export class NotFoundError extends ApplicationError {
  constructor(message = "Resource not found") { super("NOT_FOUND", message); }
}
export class UnauthorizedError extends ApplicationError {
  constructor(message = "Authentication required") { super("UNAUTHORIZED", message); }
}
export class ForbiddenError extends ApplicationError {
  constructor(message = "Operation not permitted") { super("FORBIDDEN", message); }
}
export class ConflictError extends ApplicationError {
  constructor(message = "Resource conflict") { super("CONFLICT", message); }
}
