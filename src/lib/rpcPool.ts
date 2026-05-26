import { Connection } from "@solana/web3.js";

export class RpcPool {
  private readonly connections: Connection[];
  private nextIndex = 0;

  public constructor(urls: string[]) {
    this.connections = urls.map(
      (url) =>
        new Connection(url, {
          commitment: "confirmed",
          confirmTransactionInitialTimeout: 60_000,
        }),
    );
  }

  public current(): Connection {
    return this.connections[this.nextIndex % this.connections.length]!;
  }

  public all(): Connection[] {
    return [...this.connections];
  }

  public rotate(): Connection {
    this.nextIndex = (this.nextIndex + 1) % this.connections.length;
    return this.current();
  }

  public async withFailover<T>(operation: (connection: Connection) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.connections.length; attempt += 1) {
      const connection = this.current();
      try {
        return await operation(connection);
      } catch (error) {
        lastError = error;
        this.rotate();
      }
    }

    throw lastError;
  }
}
