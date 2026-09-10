import {
  decodeSnapshot,
  encodeInput,
  type ClientMessage,
  type GameMode,
  type InputFrame,
  type ServerMessage,
  type Snapshot,
} from '@kmtank/shared';

import { WS_URL } from '../config.js';

type MessageHandler = (message: ServerMessage) => void;
type SnapshotHandler = (snapshot: Snapshot) => void;

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * The game socket. Owns reconnection-free lifecycle: a dropped connection ends
 * the session and returns the player to the menu, which is the honest thing to
 * do when the authoritative state cannot be resumed.
 */
export class GameSocket {
  private socket: WebSocket | null = null;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly snapshotHandlers = new Set<SnapshotHandler>();
  private stateHandler: ((state: ConnectionState, detail?: string) => void) | null = null;

  private seq = 0;
  private pingTimer: number | null = null;
  /** Smoothed round-trip time in milliseconds. */
  latency = 0;

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.snapshotHandlers.add(handler);
    return () => this.snapshotHandlers.delete(handler);
  }

  onState(handler: (state: ConnectionState, detail?: string) => void): void {
    this.stateHandler = handler;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(join: { mode: GameMode; name?: string; token?: string | null }): void {
    this.disconnect();
    this.stateHandler?.('connecting');

    const socket = new WebSocket(WS_URL);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.stateHandler?.('open');
      this.send({
        t: 'join',
        mode: join.mode,
        name: join.name,
        token: join.token ?? undefined,
      });
      this.startPinging();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.t === 'pong') {
          const rtt = Date.now() - message.at;
          this.latency = this.latency === 0 ? rtt : this.latency * 0.8 + rtt * 0.2;
          return;
        }
        for (const handler of this.messageHandlers) handler(message);
        return;
      }

      const snapshot = decodeSnapshot(event.data as ArrayBuffer);
      if (snapshot) for (const handler of this.snapshotHandlers) handler(snapshot);
    });

    socket.addEventListener('close', (event) => {
      this.stopPinging();
      this.socket = null;
      this.stateHandler?.('closed', event.reason || undefined);
    });

    socket.addEventListener('error', () => {
      this.stateHandler?.('error', 'Could not reach the game server.');
    });
  }

  disconnect(): void {
    this.stopPinging();
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    try {
      socket.close(1000, 'client left');
    } catch {
      // Already closing.
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  sendInput(frame: Omit<InputFrame, 'seq'>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeInput({ ...frame, seq: this.seq++ }));
  }

  private startPinging(): void {
    this.stopPinging();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', at: Date.now() });
    }, 3000);
    this.send({ t: 'ping', at: Date.now() });
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
