import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors';
import { logger } from '../logger';

type AsyncRoute = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

export function asyncHandler(fn: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  ) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
    return;
  }
  logger.error({ err: error }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
}
