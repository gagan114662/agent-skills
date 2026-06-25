#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "../apps/server/drizzle");

export function migrationSlug(input) {
  const slug = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new Error("usage: node scripts/new-migration.mjs <slug>");
  return slug;
}

export function timestampPrefix(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

export function migrationFileNames(slugInput, date = new Date()) {
  const name = timestampPrefix(date) + "_" + migrationSlug(slugInput);
  return {
    up: name + ".sql",
    down: name + ".down.sql",
  };
}

async function main() {
  const files = migrationFileNames(process.argv.slice(2).join(" "));
  await mkdir(MIGRATIONS_DIR, { recursive: true });
  await writeFile(join(MIGRATIONS_DIR, files.up), "-- up\n", { flag: "wx" });
  await writeFile(join(MIGRATIONS_DIR, files.down), "-- down\n", { flag: "wx" });
  console.log("created " + files.up);
  console.log("created " + files.down);
}

if (import.meta.url === "file://" + process.argv[1]) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
