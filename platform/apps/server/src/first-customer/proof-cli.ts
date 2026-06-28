#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyFirstCustomerProof, type FirstCustomerProof } from "./proof.js";

export interface FirstCustomerProofCliConfig {
  file: string;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefix = name + "=";
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function parseFirstCustomerProofCliConfig(
  argv: string[] = process.argv.slice(2),
): FirstCustomerProofCliConfig {
  return { file: argValue(argv, "--file") ?? argValue(argv, "-f") ?? "" };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadFirstCustomerProofJson(
  config: FirstCustomerProofCliConfig,
): Promise<FirstCustomerProof> {
  const raw = config.file.trim() ? await readFile(config.file, "utf8") : await readStdin();
  if (!raw.trim())
    throw new Error(
      "first-customer proof JSON is required; pass --file <path> or pipe JSON on stdin",
    );
  return JSON.parse(raw) as FirstCustomerProof;
}

export function formatFirstCustomerProofReport(proof: FirstCustomerProof): string[] {
  const result = verifyFirstCustomerProof(proof);
  if (result.proven)
    return [
      "PASS first-customer-proof: full source -> send -> reply -> route -> booking spine proven",
    ];
  return [
    "FAIL first-customer-proof: " + result.gaps.length + " gap(s)",
    ...result.gaps.map((gap) => "FAIL " + gap.requirement + ": " + gap.message),
  ];
}

async function main(): Promise<void> {
  const proof = await loadFirstCustomerProofJson(parseFirstCustomerProofCliConfig());
  const lines = formatFirstCustomerProofReport(proof);
  for (const line of lines) console.log(line);
  if (lines.some((line) => line.startsWith("FAIL "))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
