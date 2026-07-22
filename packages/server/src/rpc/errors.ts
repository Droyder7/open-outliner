import type { RpcErrorCode } from '@open-outliner/shared';

/** Thrown by a handler to short-circuit dispatch with a typed RPC error. */
export class RpcHandlerError extends Error {
  readonly code: RpcErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RpcHandlerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
