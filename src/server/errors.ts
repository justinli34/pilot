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
