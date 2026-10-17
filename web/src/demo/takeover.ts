type HandoffMessage = { type: 'request' | 'released'; id: string };
interface HandoffChannel {
  postMessage(message: HandoffMessage): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}
interface HandoffOptions {
  release(): Promise<boolean>;
  waiting(): void;
  released(): void;
  timeout(): void;
}

/** Only a completed, addressed release permits the requester to open the pool. */
export class NotebookHandoff {
  private requestId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private releasing = false;
  private closed = false;
  constructor(private channel: HandoffChannel, private options: HandoffOptions) {
    channel.onmessage = event => {
      const message = event.data as Partial<HandoffMessage> | null;
      if (!message || typeof message.id !== 'string') return;
      if (message.type === 'released' && message.id === this.requestId) {
        this.cancel(); this.options.released();
      } else if (message.type === 'request' && !this.releasing) {
        this.releasing = true;
        void this.options.release().then(released => {
          if (released && !this.closed) channel.postMessage({ type: 'released', id: message.id! });
        }).catch(reason => console.error('Workshop handoff failed.', reason)).finally(() => { this.releasing = false; });
      }
    };
  }
  get requested(): boolean { return this.releasing; }
  request(): void {
    this.cancel();
    this.requestId = crypto.randomUUID();
    this.options.waiting();
    this.timer = setTimeout(() => { this.cancel(); this.options.timeout(); }, 5000);
    this.channel.postMessage({ type: 'request', id: this.requestId });
  }
  cancel(): void {
    clearTimeout(this.timer); this.timer = undefined; this.requestId = undefined;
  }
  dispose(): void {
    this.closed = true; this.cancel(); this.channel.onmessage = null; this.channel.close();
  }
}
