import type {
  RuntimeError,
  RuntimePhase,
  RuntimeState,
  SessionStatus,
} from "../shared/protocol.js";

export type LocalOperation = "prompt-preflight" | "abort" | "compact" | "set-model";
export type OperationToken = symbol;

export interface PiRuntimeState {
  readonly isIdle: boolean;
  readonly isCompacting: boolean;
}

export class RuntimeStateTracker {
  private readonly operations = new Map<OperationToken, LocalOperation>();
  private retry: RuntimeState["retry"];
  private queueDepth = 0;
  private error?: RuntimeError;

  begin(operation: LocalOperation): OperationToken {
    const token = Symbol(operation);
    this.operations.set(token, operation);
    return token;
  }

  end(token: OperationToken): void {
    this.operations.delete(token);
  }

  has(operation: LocalOperation): boolean {
    return [...this.operations.values()].includes(operation);
  }

  isIdle(session: PiRuntimeState): boolean {
    return this.operations.size === 0 && session.isIdle && !session.isCompacting;
  }

  setQueueDepth(depth: number): void {
    this.queueDepth = depth;
  }

  startRetry(retry: NonNullable<RuntimeState["retry"]>, error: RuntimeError): void {
    this.retry = retry;
    this.error = error;
  }

  endRetry(): void {
    this.retry = undefined;
  }

  clearError(): void {
    this.error = undefined;
  }

  setError(error: RuntimeError): void {
    this.error = error;
    this.retry = undefined;
  }

  get lastError(): RuntimeError | undefined {
    return this.error;
  }

  snapshot(session: PiRuntimeState): RuntimeState {
    // Model configuration still blocks concurrent commands, but it is not an agent run and
    // should not make clients replace their idle composer with running-state UI.
    const hasVisibleOperation = [...this.operations.values()].some(
      (operation) => operation !== "set-model",
    );
    const isBusy = hasVisibleOperation || !session.isIdle || session.isCompacting;
    let phase: RuntimePhase;
    if (this.has("abort")) phase = "aborting";
    else if (session.isCompacting || this.has("compact")) phase = "compacting";
    else if (this.retry) phase = "retrying";
    else if (isBusy) phase = "running";
    else if (this.error) phase = "error";
    else phase = "idle";
    const status: SessionStatus = isBusy ? "running" : this.error ? "error" : "idle";
    return {
      phase,
      status,
      isBusy,
      ...(this.retry ? { retry: this.retry } : {}),
      queueDepth: this.queueDepth,
      ...(this.error ? { lastError: this.error } : {}),
      updatedAt: Date.now(),
    };
  }
}
