// In-process notification of new mail.
//
// The API, SMTP submission and (later) the B2F engine publish; IMAP IDLE and the
// web client's event stream subscribe. Deliberately not a queue: a missed
// notification only delays an EXISTS update until the next poll.

export interface MailEvent {
  userId: number;
  folderId: number;
  /** Folder name, for clients that track mailboxes by name. */
  folder: string;
}

type Listener = (event: MailEvent) => void;

export class MailEvents {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(event: MailEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a subscriber's failure must not break delivery
      }
    }
  }
}
