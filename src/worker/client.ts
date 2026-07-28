import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { prtisanPaths } from "@/prtisan-paths.js";

import type {
  WorkerEvent,
  WorkerFrame,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.js";

export class WorkerClient {
  private socket?: Socket;
  private buffer = "";
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  private readonly listeners = new Set<(event: WorkerEvent) => void>();

  constructor(private readonly socketPath = prtisanPaths().workerSocket) {}

  async connect(options: { readonly start?: boolean } = {}): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    try {
      await this.open();
    } catch (error) {
      if (!options.start) throw error;
      startWorkerProcess();
      await waitForWorker(this.socketPath);
      await this.open();
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  onEvent(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.connect({ start: true });
    const id = randomUUID();
    const request: WorkerRequest = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket?.write(`${JSON.stringify(request)}\n`);
    });
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.on("error", (error) => this.failPending(error));
        socket.on("close", () =>
          this.failPending(new Error("Prtisan Worker disconnected."))
        );
        socket.on("data", (data) => this.handleData(data.toString()));
        this.socket = socket;
        resolve();
      });
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as WorkerFrame;
      if ("event" in frame) {
        for (const listener of this.listeners) listener(frame);
        continue;
      }
      this.settle(frame);
    }
  }

  private settle(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      pending.reject(error);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function startWorkerProcess(): void {
  const child = Bun.spawn([process.execPath, Bun.main, "__worker"], {
    cwd: process.cwd(),
    env: Bun.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
}

async function waitForWorker(socketPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Prtisan Worker did not start: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
