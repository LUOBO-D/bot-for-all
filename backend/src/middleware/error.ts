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

/**
 * MySQL client errors that mean the request payload is invalid rather than the
 * server being broken. Everything else stays a 500.
 */
const INVALID_INPUT_BY_ERRNO: Record<number, string> = {
  1406: 'Value is too long', // ER_DATA_TOO_LONG
  1452: 'Referenced record does not exist', // ER_NO_REFERENCED_ROW_2
  1062: 'Duplicate entry', // ER_DUP_ENTRY (business code normally catches it)
};

const INVALID_INPUT_CODES: Record<string, true> = {
  ER_DATA_TOO_LONG: true,
  ER_NO_REFERENCED_ROW_2: true,
  ER_DUP_ENTRY: true,
};

function invalidInputMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as { code?: unknown; errno?: unknown };
  const byErrno =
    typeof candidate.errno === 'number' ? INVALID_INPUT_BY_ERRNO[candidate.errno] : undefined;
  const byCode =
    typeof candidate.code === 'string' && INVALID_INPUT_CODES[candidate.code] === true;
  if (!byCode && byErrno === undefined) {
    return null;
  }
  return byErrno ?? 'Invalid input';
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
  const invalidInput = invalidInputMessage(error);
  if (invalidInput !== null) {
    const candidate = error as { code?: unknown; errno?: unknown };
    logger.warn(
      { code: candidate.code, errno: candidate.errno },
      'rejected request with invalid input',
    );
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: invalidInput } });
    return;
  }
  logger.error({ err: error }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
}
