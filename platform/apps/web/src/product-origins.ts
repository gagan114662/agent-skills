export const DEFAULT_PUBLIC_WEB_ORIGIN = "https://ipop.ai";
export const DEFAULT_PUBLIC_API_ORIGIN = "https://api.ipop.ai";
export const PUBLIC_WEB_HOSTS = new Set(["ipop.ai", "www.ipop.ai"]);

export function trimOrigin(value: string | undefined): string {
  return (value ?? "").replace(/\/+$/, "");
}

export function resolvePublicWebOrigin(env: Record<string, string | undefined> = {}): string {
  return trimOrigin(env.SITE_ORIGIN || env.VITE_SITE_ORIGIN || env.VITE_PUBLIC_WEB_ORIGIN || DEFAULT_PUBLIC_WEB_ORIGIN);
}
