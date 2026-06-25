import { readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";

export type AppExtensionContext = Record<string, never>;

export interface AppExtension {
  name: string;
  register(app: FastifyInstance, context: AppExtensionContext): void | Promise<void>;
}

export interface RegisterAppExtensionsOptions {
  directory?: string;
}

function isExtensionModule(file: string): boolean {
  return (
    file !== "registry.ts" &&
    file !== "registry.js" &&
    !file.endsWith(".d.ts") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".test.js") &&
    [".ts", ".js"].includes(extname(file))
  );
}

function normalizeExtension(module: unknown, file: string): AppExtension {
  const candidate =
    module && typeof module === "object" && "default" in module
      ? (module as { default?: unknown }).default
      : module;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(file + ": app extension must export an AppExtension object");
  }
  const extension = candidate as Partial<AppExtension>;
  if (typeof extension.name !== "string" || typeof extension.register !== "function") {
    throw new Error(file + ": app extension requires name and register(app, context)");
  }
  return extension as AppExtension;
}

export async function registerAppExtensions(
  app: FastifyInstance,
  context: AppExtensionContext = {},
  options: RegisterAppExtensionsOptions = {},
): Promise<void> {
  const directory = options.directory ?? dirname(fileURLToPath(import.meta.url));
  let files: string[];
  try {
    files = (await readdir(directory)).filter(isExtensionModule).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const file of files) {
    const module = await import(pathToFileURL(join(directory, file)).href);
    const extension = normalizeExtension(module, file);
    await extension.register(app, context);
  }
}
