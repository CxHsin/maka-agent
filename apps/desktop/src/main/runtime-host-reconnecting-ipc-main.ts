import type { IpcMain } from "electron";
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from "@maka/runtime-host/client";

const RECONNECTABLE_READ_CHANNELS = new Set([
  "onboarding:getSnapshot",
  "sessions:list",
  "skills:listInvocable",
]);

type IpcHandler = Parameters<IpcMain["handle"]>[1];

interface HandlerWaiter {
  readonly resolve: (handler: IpcHandler) => void;
  readonly reject: (error: Error) => void;
}

interface HandlerSlot {
  readonly waiters: Set<HandlerWaiter>;
  handler?: IpcHandler;
}

/**
 * Keeps Electron IPC admission stable while a Runtime Host candidate is replaced.
 */
export class RuntimeHostReconnectingIpcMain
  implements Pick<IpcMain, "handle" | "removeHandler">
{
  readonly #ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly #slots = new Map<string, HandlerSlot>();
  #closed = false;

  constructor(ipcMain: Pick<IpcMain, "handle" | "removeHandler">) {
    this.#ipcMain = ipcMain;
  }

  handle(channel: string, listener: IpcHandler): void {
    if (this.#closed) {
      throw new Error("Desktop Runtime Host IPC router is closed");
    }
    let slot = this.#slots.get(channel);
    if (!slot) {
      const created: HandlerSlot = { waiters: new Set() };
      this.#ipcMain.handle(channel, (event, ...args) =>
        this.#dispatch(channel, created, event, args),
      );
      this.#slots.set(channel, created);
      slot = created;
    }
    if (slot.handler) {
      throw new Error(`Desktop Runtime Host IPC handler already exists: ${channel}`);
    }
    slot.handler = listener;
    for (const waiter of slot.waiters) waiter.resolve(listener);
    slot.waiters.clear();
  }

  removeHandler(channel: string): void {
    const slot = this.#slots.get(channel);
    if (slot) slot.handler = undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Desktop Runtime Host IPC router is closed");
    for (const [channel, slot] of this.#slots) {
      for (const waiter of slot.waiters) waiter.reject(error);
      slot.waiters.clear();
      slot.handler = undefined;
      this.#ipcMain.removeHandler(channel);
    }
    this.#slots.clear();
  }

  async #dispatch(
    channel: string,
    slot: HandlerSlot,
    event: Parameters<IpcHandler>[0],
    args: readonly unknown[],
  ): Promise<unknown> {
    let handler = slot.handler ?? (await this.#waitForHandler(slot));
    while (true) {
      try {
        return await handler(event, ...args);
      } catch (error) {
        if (
          !RECONNECTABLE_READ_CHANNELS.has(channel) ||
          !isReconnectableReadFailure(error)
        ) {
          throw error;
        }
        handler = await this.#waitForHandler(slot, handler);
      }
    }
  }

  #waitForHandler(slot: HandlerSlot, previous?: IpcHandler): Promise<IpcHandler> {
    if (this.#closed) {
      return Promise.reject(
        new Error("Desktop Runtime Host IPC router is closed"),
      );
    }
    if (slot.handler && slot.handler !== previous) {
      return Promise.resolve(slot.handler);
    }
    return new Promise((resolve, reject) => {
      slot.waiters.add({ resolve, reject });
    });
  }
}

function isReconnectableReadFailure(error: unknown): boolean {
  return (
    (error instanceof RuntimeHostOperationError &&
      error.code === "host_draining") ||
    (error instanceof RuntimeHostRequestInterruptedError && error.retryable)
  );
}
