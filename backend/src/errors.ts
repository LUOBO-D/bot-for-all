export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthorized = (message = 'Unauthorized') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const notFound = (code: string, message: string) => new ApiError(404, code, message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
export const tooMany = (message = 'Too many requests') => new ApiError(429, 'RATE_LIMITED', message);
