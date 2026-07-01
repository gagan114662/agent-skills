export const DEFAULT_PUBLIC_APP_ORIGIN = "https://ipop.ai";
export const DEFAULT_PUBLIC_API_ORIGIN = "https://api.ipop.ai";

function trimOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

export function publicAppOrigin(source: NodeJS.ProcessEnv = process.env): string {
  return (
    trimOrigin(source.IPOP_APP_URL) ??
    trimOrigin(source.RELOAD_WEB_ORIGIN) ??
    trimOrigin(source.SITE_ORIGIN) ??
    DEFAULT_PUBLIC_APP_ORIGIN
  );
}

export function publicApiOrigin(source: NodeJS.ProcessEnv = process.env): string {
  return (
    trimOrigin(source.IPOP_API_URL) ??
    trimOrigin(source.RELOAD_API_ORIGIN) ??
    trimOrigin(source.IMESSAGE_RELAY_API_BASE) ??
    DEFAULT_PUBLIC_API_ORIGIN
  );
}

export function productUrl(path: string, source: NodeJS.ProcessEnv = process.env): string {
  return new URL(path, publicAppOrigin(source)).toString();
}
