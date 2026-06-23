#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "../apps/server/drizzle");
const UP_RE = /^(\d{4})_(?!.*\.down\.sql$)(.+)\.sql$/;
const DOWN_RE = /^(\d{4})_(.+)\.down\.sql$/;

function stripSqlComments(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeObjectName(name) {
  return name.replace(/^only\s+/i, "").replace(/["']/g, "").toLowerCase();
}

export function touchedObjects(sql) {
  const clean = stripSqlComments(sql);
  const objects = new Set();
  const patterns = [
    /\b(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z0-9_."']+)/gi,
    /\bcreate\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[a-zA-Z0-9_."']+\s+on\s+([a-zA-Z0-9_."']+)/gi,
    /\bdrop\s+index\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."']+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      if (match[1]) objects.add(normalizeObjectName(match[1]));
    }
  }
  return [...objects].sort();
}

function baseName(file) {
  return file.replace(/\.down\.sql$/, ".sql");
}

export function validateMigrationSet(entries) {
  const files = [...entries].sort((a, b) => a.file.localeCompare(b.file));
  const up = files.filter((entry) => UP_RE.test(entry.file));
  const down = files.filter((entry) => DOWN_RE.test(entry.file));
  const upNames = new Set(up.map((entry) => entry.file));
  const downBases = new Set(down.map((entry) => baseName(entry.file)));
  const errors = [];

  for (const entry of files) {
    if (!UP_RE.test(entry.file) && !DOWN_RE.test(entry.file) && entry.file !== "README.md") {
      errors.push(entry.file + ": migration files must be NNNN_name.sql or NNNN_name.down.sql");
    }
  }

  for (const entry of up) {
    if (!downBases.has(entry.file)) errors.push(entry.file + ": missing paired down migration");
  }
  for (const entry of down) {
    const base = baseName(entry.file);
    if (!upNames.has(base)) errors.push(entry.file + ": missing paired up migration " + base);
  }

  const byPrefix = new Map();
  for (const entry of up) {
    const prefix = entry.file.match(UP_RE)?.[1];
    if (!prefix) continue;
    const group = byPrefix.get(prefix) ?? [];
    group.push({ ...entry, objects: touchedObjects(entry.sql) });
    byPrefix.set(prefix, group);
  }

  for (const [prefix, group] of byPrefix.entries()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i];
        const right = group[j];
        const overlap = left.objects.filter((object) => right.objects.includes(object));
        if (overlap.length > 0) {
          errors.push(
            prefix +
              ": " +
              left.file +
              " and " +
              right.file +
              " share touched object(s): " +
              overlap.join(", "),
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    order: up.map((entry) => entry.file),
  };
}

async function main() {
  const names = await readdir(MIGRATIONS_DIR);
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".sql") || name === "README.md")
      .map(async (file) => ({
        file,
        sql: file.endsWith(".sql") ? await readFile(join(MIGRATIONS_DIR, file), "utf8") : "",
      })),
  );
  const result = validateMigrationSet(entries);
  if (!result.ok) {
    console.error("migration guard failed in " + relative(process.cwd(), MIGRATIONS_DIR) + ":");
    for (const error of result.errors) console.error("- " + error);
    process.exit(1);
  }
  console.log("migration guard ok: " + result.order.length + " migrations, deterministic filename order");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
