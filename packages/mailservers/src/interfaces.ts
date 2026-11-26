// POP3, SMTP and IMAP as one door, with a switch on each protocol.
//
// The three listeners are separate sockets, but from the station's point of view they are
// one thing: the way a mail program reaches the mailboxes. The configuration decides which
// addresses exist at all; this supervisor decides which of those are listening right now,
// so an operator can take one out of service — or bring back one that failed to bind —
// without editing the configuration and restarting. A restart returns to the
// configuration, because that is the record of what the station is meant to offer.
//
// A failed start is recorded, never thrown: one protocol that cannot bind must not stop
// the other two, nor the web UI that shows the operator what happened.

import type { Logger, MailInterface, MailInterfaceName } from '@rfmail/shared';
import { MAIL_INTERFACE_NAMES } from '@rfmail/shared';
import type { Store } from '@rfmail/store';
import type { PeerPolicy } from './access.ts';
import type { MailEvents } from './events.ts';
import { ImapServer } from './imap.ts';
import { Pop3Server } from './pop3.ts';
import { SmtpServer } from './smtp.ts';

/** The state this supervisor reports is the API's state; one definition, in shared. */
export type { MailInterface, MailInterfaceName } from '@rfmail/shared';

export interface MailInterfaceAddress {
  host: string;
  port: number;
}

export interface MailInterfacesOptions {
  store: Store;
  policy: PeerPolicy;
  events: MailEvents;
  logger: Logger;
  /** The addresses the configuration offers; a name that is absent has nothing to bind. */
  specs: Partial<Record<MailInterfaceName, MailInterfaceAddress>>;
}

type MailServer = Pop3Server | SmtpServer | ImapServer;

interface Entry {
  name: MailInterfaceName;
  /** What the configuration asks for; null means this protocol is not offered at all. */
  address: MailInterfaceAddress | null;
  server: MailServer | null;
  error: string | null;
}

export class MailInterfaces {
  private readonly opts: MailInterfacesOptions;
  private readonly entries = new Map<MailInterfaceName, Entry>();

  constructor(options: MailInterfacesOptions) {
    this.opts = options;
    for (const name of MAIL_INTERFACE_NAMES) {
      this.entries.set(name, {
        name,
        address: options.specs[name] ?? null,
        server: null,
        error: null,
      });
    }
  }

  status(): MailInterface[] {
    return MAIL_INTERFACE_NAMES.map((name) => this.describe(this.entry(name)));
  }

  /** Starts every interface the configuration offers, and answers with how each one is. */
  async startAll(): Promise<MailInterface[]> {
    for (const name of MAIL_INTERFACE_NAMES) {
      const entry = this.entry(name);
      if (entry.address) await this.start(entry);
    }
    return this.status();
  }

  /**
   * Switches one interface. Throws only when the request itself makes no sense (an
   * unknown name, or a protocol the configuration does not offer); a listener that
   * fails to bind is reported in the returned state instead.
   */
  async set(name: MailInterfaceName, on: boolean): Promise<MailInterface> {
    const entry = this.entry(name);
    if (!entry.address) {
      throw new Error(`${name.toUpperCase()} has no address in the configuration`);
    }
    if (on) await this.start(entry);
    else await this.close(entry);
    return this.describe(entry);
  }

  async closeAll(): Promise<void> {
    for (const name of MAIL_INTERFACE_NAMES) await this.close(this.entry(name));
  }

  private entry(name: MailInterfaceName): Entry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`unknown mail interface '${String(name)}'`);
    return entry;
  }

  private create(entry: Entry): MailServer {
    const address = entry.address;
    if (!address) throw new Error(`${entry.name.toUpperCase()} has no address in the configuration`);
    const common = {
      store: this.opts.store,
      policy: this.opts.policy,
      host: address.host,
      port: address.port,
      logger: this.opts.logger,
    };
    if (entry.name === 'pop3') return new Pop3Server(common);
    if (entry.name === 'smtp') return new SmtpServer({ ...common, events: this.opts.events });
    return new ImapServer({ ...common, events: this.opts.events });
  }

  private async start(entry: Entry): Promise<void> {
    entry.error = null;
    const server = entry.server ?? this.create(entry);
    entry.server = server;
    try {
      await server.listen();
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      this.opts.logger.error('mail interface did not start', {
        interface: entry.name,
        address: `${entry.address?.host ?? '?'}:${entry.address?.port ?? '?'}`,
        error: entry.error,
      });
    }
  }

  private async close(entry: Entry): Promise<void> {
    const server = entry.server;
    if (!server) return;
    await server.close();
    entry.error = null;
  }

  private describe(entry: Entry): MailInterface {
    const running = entry.server?.listening === true;
    return {
      name: entry.name,
      configured: entry.address !== null,
      address: running
        ? (entry.server?.address ?? null)
        : entry.address
          ? `${entry.address.host}:${entry.address.port}`
          : null,
      running,
      error: entry.error,
    };
  }
}
