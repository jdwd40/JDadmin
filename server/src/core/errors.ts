export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errors = {
  badRequest: (msg: string, details?: unknown) => new ApiError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Forbidden', code = 'FORBIDDEN') => new ApiError(403, code, msg),
  notFound: (msg = 'Not found') => new ApiError(404, 'NOT_FOUND', msg),
  conflict: (msg: string) => new ApiError(409, 'CONFLICT', msg),
  tooMany: (msg = 'Too many requests') => new ApiError(429, 'RATE_LIMITED', msg),
  unsupported: (capability: string) =>
    new ApiError(403, 'UNSUPPORTED_CAPABILITY', `This app does not support capability: ${capability}`),
  destructiveDisabled: () =>
    new ApiError(
      403,
      'DESTRUCTIVE_DISABLED',
      'Destructive actions are disabled by server configuration (ALLOW_DESTRUCTIVE / production ack).',
    ),
};
