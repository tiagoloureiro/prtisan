export interface WorkerRequest {
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export type WorkerResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly stack?: string;
      };
    };

export interface WorkerEvent {
  readonly event: string;
  readonly data: unknown;
}

export type WorkerFrame = WorkerResponse | WorkerEvent;
