export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function toPublicError(error: unknown, fallbackAction: string): AppError {
  if (error instanceof AppError) return error;
  return new AppError(500, "internal_error", `${fallbackAction} failed`);
}
