import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors';
import { errorHandler } from '../src/middleware/error';

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function mockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number): MockResponse {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown): MockResponse {
      this.body = payload;
      return this;
    },
  };
}

function run(error: unknown): MockResponse {
  const res = mockResponse();
  errorHandler(error, {} as Request, res as unknown as Response, () => undefined);
  return res;
}

describe('error handler', () => {
  it('maps MySQL input errors to 400 INVALID_INPUT', () => {
    const tooLong = run({ code: 'ER_DATA_TOO_LONG', errno: 1406 });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.body).toEqual({
      error: { code: 'INVALID_INPUT', message: 'Value is too long' },
    });

    const missingReference = run({ code: 'ER_NO_REFERENCED_ROW_2', errno: 1452 });
    expect(missingReference.statusCode).toBe(400);
    expect(missingReference.body).toEqual({
      error: { code: 'INVALID_INPUT', message: 'Referenced record does not exist' },
    });

    const duplicate = run({ code: 'ER_DUP_ENTRY', errno: 1062 });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toEqual({
      error: { code: 'INVALID_INPUT', message: 'Duplicate entry' },
    });

    // errno alone is enough (driver-specific error shapes).
    expect(run({ errno: 1406 }).statusCode).toBe(400);
  });

  it('keeps other database errors as 500 INTERNAL', () => {
    const response = run({ code: 'ER_PARSE_ERROR', errno: 1064 });
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal error' },
    });
  });

  it('preserves ApiError status and code', () => {
    const response = run(new ApiError(409, 'CONFLICT', 'Already exists'));
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: { code: 'CONFLICT', message: 'Already exists' } });
  });

  it('maps malformed JSON bodies to 400 INVALID_JSON', () => {
    const response = run({ type: 'entity.parse.failed' });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
    });
  });
});
