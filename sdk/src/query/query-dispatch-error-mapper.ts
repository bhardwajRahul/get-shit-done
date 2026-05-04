import type { QueryDispatchError, QueryDispatchResult } from './query-dispatch-contract.js';
import { toFailureSignal } from '../query-failure-classification.js';
import { fallbackDispatchErrorFromSignal, nativeDispatchErrorFromSignal } from './query-error-taxonomy.js';
import { dispatchFailure } from './query-dispatch-result-builder.js';

export function toDispatchFailure(
  error: QueryDispatchError,
  stderr: string[] = [],
): QueryDispatchResult {
  return dispatchFailure(error, stderr);
}

export function mapNativeDispatchError(error: unknown, command: string, args: string[]): QueryDispatchError {
  return nativeDispatchErrorFromSignal(toFailureSignal(error), command, args);
}

export function mapFallbackDispatchError(error: unknown, command: string, args: string[]): QueryDispatchError {
  return fallbackDispatchErrorFromSignal(toFailureSignal(error), command, args);
}
