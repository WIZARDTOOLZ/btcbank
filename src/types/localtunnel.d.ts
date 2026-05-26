declare module "localtunnel" {
  interface Tunnel {
    url: string;
    close(): void;
  }

  interface TunnelOptions {
    port: number;
    subdomain?: string;
    host?: string;
  }

  export default function localtunnel(options: TunnelOptions): Promise<Tunnel>;
}
