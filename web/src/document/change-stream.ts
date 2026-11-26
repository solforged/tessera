import type { ApiClient, ChangeSocket } from '../api/client';
import { CHANGE_CONNECTING, CHANGE_OPEN } from '../api/client';
import type { ChangeEvent } from '../api/types';

/** Beyond one history page, fresh snapshots cost less than replaying full-block events. */
const MAX_CATCH_UP = 500;

/**
 * What the change stream needs from the workshop that owns open documents.
 * The stream reads the replay cursor and the recovery floor, delivers each
 * socket event through `onChange`, and asks the host to reload when the gap
 * is too wide to replay. `api.stream` is the stream factory, including one
 * injected through `setStreamFactory`.
 */
export interface WorkshopChangeHost {
  readonly api: Pick<ApiClient, 'changeHead' | 'changes' | 'stream'>;
  /** Settles once the workshop has loaded; read when connecting, so the stream can be built first. */
  ready(): Promise<void>;
  closed(): boolean;
  /** Replay cursor. Receipts may run ahead of it; a snapshot taken now includes this floor. */
  cursor(): number;
  setCursor(value: number): void;
  seeded(): boolean;
  setSeeded(value: boolean): void;
  /** Pages opened from a cache, with the cursor those snapshots already include. */
  recoveryPages(): ReadonlyMap<string, number | undefined>;
  /**
   * Reload every open document and reseed from `head`.
   * When `resetJournal` is set, drop the local change journal first.
   * Marks each open page recovering before reloading it, publishes `head` as
   * the observed sequence, and clears capability and work-session watermarks.
   */
  reloadOpenDocuments(head: number, resetJournal: boolean): Promise<void>;
  refreshRoots(): Promise<void>;
  refreshSettings(): Promise<void>;
  refreshWork(sequence: number): Promise<void>;
  /** Reload one open page. Missing pages resolve without a read, as the inline optional call did. */
  reloadPage(pageId: string): Promise<void> | undefined;
  /** Apply one socket event, including its own cursor advance. */
  onChange(event: ChangeEvent): Promise<void>;
  /** Apply one `/api/changes` page, including its own cursor advance. */
  onCatchUp(events: readonly ChangeEvent[]): Promise<void>;
  connection(): 'connecting' | 'live' | 'offline';
  setConnection(state: 'connecting' | 'live' | 'offline'): void;
  retryLookups(): void;
  reloadReanchored(): Promise<void>;
  /** Wake the command pump with the same zero delay the socket used inline. */
  scheduleCommands(): void;
  setFailure(message: string): void;
  touch(): void;
  /** Replace the observed sequence. Used when the floor is first seeded from the service head. */
  setObservedSequence(value: number): void;
}

/**
 * Opens the workshop change stream, catches up through `/api/changes`, and
 * keeps the replay floor. A gap wider than one history page reloads open
 * documents instead of replaying them.
 */
export class WorkshopChangeStream {
  private socket?: ChangeSocket;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 500;
  private streamWork = Promise.resolve();
  private reloadRequired = false;
  private socketStale = false;
  constructor(private host: WorkshopChangeHost) {}
  /** Drop the reconnect timer and the socket. The host has already marked itself closed. */
  stop() {
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
  markOffline(staleSocket = false) {
    if (staleSocket || (typeof navigator !== 'undefined' && navigator.onLine === false)) this.socketStale = true;
    this.host.setConnection('offline');
  }
  serviceReached() {
    if (this.host.closed()) return;
    if (!this.socketStale && this.socket?.readyState === CHANGE_OPEN) {
      const recovered = this.host.connection() !== 'live';
      this.host.setConnection('live');
      this.reconnectDelay = 500;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      if (recovered) this.host.retryLookups();
    } else void this.connect();
  }
  async seedCursor() {
    const head = await this.host.api.changeHead();
    if (this.host.seeded()) return;
    this.host.setCursor(head);
    this.host.setSeeded(true);
    this.host.setObservedSequence(head);
  }
  private async prepareReplay(replaceSocket = false) {
    const head = await this.host.api.changeHead();
    let after = this.host.seeded() ? this.host.cursor() : head;
    let reset = after > head;
    let reload = this.reloadRequired || (!this.host.seeded() && !this.host.recoveryPages().size) || reset;
    for (const cursor of this.host.recoveryPages().values()) {
      if (cursor === undefined) reload = true;
      else if (cursor > head) {
        reload = true;
        reset = true;
      } else after = Math.min(after, cursor);
    }
    reload ||= head - after > MAX_CATCH_UP;
    if (replaceSocket || reload || after !== this.host.cursor()) {
      // Detach before closing so the old socket cannot append events behind the new floor.
      const socket = this.socket;
      this.socket = undefined;
      this.socketStale = false;
      socket?.close();
    }
    const recovering = !this.host.seeded() || this.host.recoveryPages().size > 0;
    if (reload) {
      this.reloadRequired = true;
      await this.host.reloadOpenDocuments(head, reset);
    } else {
      this.host.setCursor(after);
      this.host.setSeeded(true);
      if (recovering) {
        await this.host.refreshRoots();
        await this.host.refreshSettings();
        await this.host.refreshWork(head);
      }
      // A cache can be opened after this window already consumed its missed events.
      // Refresh it before resuming, including structural changes and sync rebases.
      for (const id of this.host.recoveryPages().keys()) await this.host.reloadPage(id);
    }
    if (this.host.recoveryPages().size) throw new Error('Cached atoms still need a server snapshot.');
    this.reloadRequired = false;
  }
  async connect() {
    await this.host.ready();
    if (this.host.closed()) return;
    if (this.connecting) return this.connecting;
    const work = this.reconcileConnection();
    this.connecting = work;
    try {
      await work;
    } finally {
      if (this.connecting === work) this.connecting = undefined;
    }
  }
  private async reconcileConnection() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const wasOffline = this.socketStale;
    this.host.setConnection('connecting');
    try {
      const work = this.streamWork.then(async () => {
        await this.prepareReplay(wasOffline);
        while (!this.host.closed()) {
          const events = await this.host.api.changes(this.host.cursor());
          await this.host.onCatchUp(events);
          if (events.length < MAX_CATCH_UP) break;
        }
      });
      this.streamWork = work.catch(() => undefined);
      await work;
      if (this.host.closed()) return;
      this.host.retryLookups();
      await this.host.reloadReanchored();
      if (this.host.closed()) return;
      if (this.socket?.readyState === CHANGE_OPEN) {
        // A failed request can mark the workshop offline while the socket stays up. Nothing else
        // wakes the commands it left queued, so resend them now that the service answered.
        this.serviceReached();
        this.host.scheduleCommands();
        return;
      }
      if (this.socket?.readyState === CHANGE_CONNECTING) return;
      const socket = this.host.api.stream(this.host.cursor());
      this.socket = socket;
      this.socketStale = false;
      socket.onopen = () => {
        if (this.host.closed() || this.socket !== socket) return;
        this.serviceReached();
        this.host.scheduleCommands();
      };
      socket.onmessage = message => {
        if (this.host.closed() || this.socket !== socket) return;
        this.streamWork = this.streamWork
          .then(async () => {
            if (!this.host.closed() && this.socket === socket)
              await this.host.onChange(JSON.parse(String(message.data)) as ChangeEvent);
          })
          .catch(error => {
            this.host.setFailure(
              `Could not read workshop changes: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.host.touch();
          });
      };
      socket.onerror = () => {
        if (this.socket === socket) socket.close();
      };
      socket.onclose = () => {
        if (this.host.closed() || this.socket !== socket) return;
        this.socket = undefined;
        this.markOffline();
        this.scheduleReconnect();
      };
      this.host.scheduleCommands();
    } catch {
      if (!this.host.closed()) {
        this.markOffline();
        this.scheduleReconnect();
      }
    }
  }
  scheduleReconnect() {
    if (this.host.closed() || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(10000, this.reconnectDelay * 2);
  }
}
