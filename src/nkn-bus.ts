import { EventEmitter } from "events";
import nkn from "nkn-sdk";
import { NKN_SEED_RPC_SERVERS, type NknConnectionState } from "./types.js";

export interface NknBusOptions {
  seed: string;
  numSubClients?: number;
  /** Heartbeat echo-test interval in ms (default 60 000). Set 0 to disable. */
  heartbeatIntervalMs?: number;
  /** Consecutive heartbeat failures before reconnecting (default 3). */
  heartbeatMaxFailures?: number;
}

/** Payload used for heartbeat echo-test messages (self → self). */
const HEARTBEAT_ECHO_PREFIX = "__nkn_heartbeat_echo__:";

/**
 * NKN MultiClient wrapper for D-Chat wire-format messaging.
 * Handles connect, send, receive, subscribe, heartbeat, and reconnection.
 */

export class NknBus extends EventEmitter {
  private client: nkn.MultiClient | null = null;
  private state: NknConnectionState = "disconnected";
  private address: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seed: string | undefined;
  private numSubClients: number;
  private abortSignal: AbortSignal | undefined;

  private heartbeatIntervalMs: number = 60_000;
  private heartbeatMaxFailures: number = 3;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatFailures: number = 0;
  private pendingEchoId: string | null = null;
  private pendingEchoResolve: (() => void) | null = null;
  private isReconnecting: boolean = false;

  constructor() {
    super();
    this.numSubClients = 4;
  }

  getState(): NknConnectionState {
    return this.state;
  }

  getAddress(): string | undefined {
    return this.address;
  }

  async connect(opts: NknBusOptions, abortSignal?: AbortSignal): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    this.seed = opts.seed;
    this.numSubClients = opts.numSubClients ?? 4;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 60_000;
    this.heartbeatMaxFailures = opts.heartbeatMaxFailures ?? 3;
    this.abortSignal = abortSignal;
    this.setState("connecting");

    try {
      this.client = new nkn.MultiClient({
        seed: opts.seed,
        numSubClients: this.numSubClients,
        originalClient: false,
        rpcServerAddr: NKN_SEED_RPC_SERVERS[0],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("NKN connection timeout after 30s"));
        }, 30000);

        if (abortSignal?.aborted) {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
          return;
        }

        const onAbort = () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        this.client!.onConnect(() => {
          clearTimeout(timeout);
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });

      this.address = this.client.addr;
      this.setState("connected");

      // Register message handler: src may include __N__. sub-client prefix; caller should normalize
      this.client.onMessage(({ src, payload }: { src: string; payload: Uint8Array | string }) => {
        let data: string;
        if (payload instanceof Uint8Array) {
          data = new TextDecoder().decode(payload);
        } else {
          data = payload;
        }

        // Intercept heartbeat echo responses — don't emit as regular messages
        if (data.startsWith(HEARTBEAT_ECHO_PREFIX)) {
          const echoId = data.slice(HEARTBEAT_ECHO_PREFIX.length);
          if (echoId === this.pendingEchoId && this.pendingEchoResolve) {
            this.pendingEchoResolve();
            this.pendingEchoResolve = null;
            this.pendingEchoId = null;
          }
          return;
        }

        this.emit("message", src, data);
      });

      this.startHeartbeat();

      return this.address;
    } catch (err) {
      this.setState("disconnected");
      if (this.client) {
        try {
          this.client.close();
        } catch {
          // ignore close errors during cleanup
        }
        this.client = null;
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }
    this.address = undefined;
    this.setState("disconnected");
  }

  /**
   * Send a message and wait for recipient ACK.
   * Used for direct text messages.
   */
  async send(dest: string, payload: string): Promise<void> {
    this.ensureConnected();
    await this.client!.send(dest, payload, {
      msgHoldingSeconds: 3600,
    });
  }

  /**
   * Send without waiting for ACK (fire-and-forget).
   * Used for media messages and topic broadcasts.
   */
  sendNoReply(dest: string, payload: string): void {
    this.ensureConnected();
    this.client!.send(dest, payload, {
      noReply: true,
      msgHoldingSeconds: 3600,
    });
  }

  /**
   * Send to multiple destinations (topic broadcast).
   * Fire-and-forget.
   */
  sendToMultiple(dests: string[], payload: string): void {
    this.ensureConnected();
    if (dests.length === 0) return;
    this.client!.send(dests, payload, {
      noReply: true,
      msgHoldingSeconds: 3600,
    });
  }

  /** Subscribe to a topic on the NKN blockchain. */
  async subscribe(topicHash: string, duration = 400000, fee = "0"): Promise<string> {
    this.ensureConnected();
    const txnHash = await this.client!.subscribe(topicHash, duration, "", "", {
      fee,
      attrs: undefined,
      buildOnly: undefined,
    } as nkn.TransactionOptions);
    return String(txnHash);
  }

  /** Unsubscribe from a topic. */
  async unsubscribe(topicHash: string, fee = "0"): Promise<string> {
    this.ensureConnected();
    const txnHash = await this.client!.unsubscribe(topicHash, "", {
      fee,
      attrs: undefined,
      buildOnly: undefined,
    } as nkn.TransactionOptions);
    return String(txnHash);
  }

  /** Fetch subscriber addresses for a topic. */
  async getSubscribers(topicHash: string): Promise<string[]> {
    this.ensureConnected();
    const result = await this.client!.getSubscribers(topicHash, {
      offset: 0,
      limit: 1000,
      txPool: true,
    });
    const subs = result.subscribers;
    if (Array.isArray(subs)) {
      return subs;
    }
    // Record<string, string> form — keys are addresses
    return Object.keys(subs);
  }

  /** Register a handler for incoming NKN messages. */
  onMessage(handler: (src: string, data: string) => void): void {
    this.on("message", handler);
  }

  /** Start periodic heartbeat echo test (self → self). */
  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatFailures = 0;
    this.scheduleNextHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Reject any pending echo wait
    this.pendingEchoResolve = null;
    this.pendingEchoId = null;
  }

  private scheduleNextHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      void this.runHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.client || this.state !== "connected" || !this.address) {
      return;
    }

    const echoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const echoPayload = HEARTBEAT_ECHO_PREFIX + echoId;

    try {
      const echoReceived = await new Promise<boolean>((resolve) => {
        this.pendingEchoId = echoId;
        // Timeout: half the heartbeat interval or 15s, whichever is smaller
        const timeout = Math.min(this.heartbeatIntervalMs / 2, 15_000);
        const timer = setTimeout(() => {
          this.pendingEchoResolve = null;
          this.pendingEchoId = null;
          resolve(false);
        }, timeout);

        this.pendingEchoResolve = () => {
          clearTimeout(timer);
          resolve(true);
        };

        // Send echo to self (fire-and-forget send, we wait for the message handler)
        this.client!.send(this.address!, echoPayload, { noReply: true });
      });

      if (echoReceived) {
        this.heartbeatFailures = 0;
        this.emit("heartbeat", { success: true, failures: 0 });
      } else {
        this.heartbeatFailures++;
        this.emit("heartbeat", { success: false, failures: this.heartbeatFailures });

        if (this.heartbeatFailures >= this.heartbeatMaxFailures) {
          this.emit("heartbeatReconnect", { failures: this.heartbeatFailures });
          await this.reconnect();
          return; // reconnect starts a new heartbeat loop
        }
      }
    } catch {
      this.heartbeatFailures++;
      this.emit("heartbeat", { success: false, failures: this.heartbeatFailures });

      if (this.heartbeatFailures >= this.heartbeatMaxFailures) {
        this.emit("heartbeatReconnect", { failures: this.heartbeatFailures });
        await this.reconnect();
        return;
      }
    }

    // Schedule next heartbeat if still connected
    if (this.state === "connected") {
      this.scheduleNextHeartbeat();
    }
  }

  /** Close the current connection and create a new one using stored options. */
  private async reconnect(): Promise<void> {
    if (this.isReconnecting || !this.seed) return;
    this.isReconnecting = true;

    try {
      this.stopHeartbeat();

      // Close existing client
      if (this.client) {
        try {
          this.client.close();
        } catch {
          // ignore close errors
        }
        this.client = null;
      }
      this.address = undefined;
      this.setState("connecting");

      // Create a fresh client
      this.client = new nkn.MultiClient({
        seed: this.seed,
        numSubClients: this.numSubClients,
        originalClient: false,
        rpcServerAddr: NKN_SEED_RPC_SERVERS[0],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("NKN reconnection timeout after 30s"));
        }, 30_000);

        if (this.abortSignal?.aborted) {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
          return;
        }

        const onAbort = () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        };
        this.abortSignal?.addEventListener("abort", onAbort, { once: true });

        this.client!.onConnect(() => {
          clearTimeout(timeout);
          this.abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });

      this.address = this.client.addr;
      this.setState("connected");

      // Re-register message handler
      this.client.onMessage(({ src, payload }: { src: string; payload: Uint8Array | string }) => {
        let data: string;
        if (payload instanceof Uint8Array) {
          data = new TextDecoder().decode(payload);
        } else {
          data = payload;
        }

        if (data.startsWith(HEARTBEAT_ECHO_PREFIX)) {
          const id = data.slice(HEARTBEAT_ECHO_PREFIX.length);
          if (id === this.pendingEchoId && this.pendingEchoResolve) {
            this.pendingEchoResolve();
            this.pendingEchoResolve = null;
            this.pendingEchoId = null;
          }
          return;
        }

        this.emit("message", src, data);
      });

      this.heartbeatFailures = 0;
      this.startHeartbeat();
    } catch (err) {
      this.setState("disconnected");
      if (this.client) {
        try {
          this.client.close();
        } catch {
          // ignore
        }
        this.client = null;
      }
      this.emit("reconnectFailed", err);
    } finally {
      this.isReconnecting = false;
    }
  }

  private ensureConnected(): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("NKN client not connected");
    }
  }

  private setState(next: NknConnectionState): void {
    this.state = next;
    this.emit("stateChange", next);
  }
}
