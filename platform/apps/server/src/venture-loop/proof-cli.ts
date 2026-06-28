#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyAutonomousVentureLoopProof, type AutonomousVentureLoopProof } from "./proof.js";

export interface AutonomousVentureLoopProofCliConfig {
  file: string;
  readStdin?: () => Promise<string>;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefix = name + "=";
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function parseAutonomousVentureLoopProofCliConfig(
  argv: string[] = process.argv.slice(2),
): AutonomousVentureLoopProofCliConfig {
  return { file: argValue(argv, "--file") ?? argValue(argv, "-f") ?? "" };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadAutonomousVentureLoopProofJson(
  config: AutonomousVentureLoopProofCliConfig,
): Promise<AutonomousVentureLoopProof> {
  const raw = config.file.trim()
    ? await readFile(config.file, "utf8")
    : await (config.readStdin ?? readStdin)();
  if (!raw.trim()) {
    throw new Error(
      "autonomous-venture-loop proof JSON is required; pass --file <path> or pipe JSON on stdin",
    );
  }
  return JSON.parse(raw) as AutonomousVentureLoopProof;
}

export function formatAutonomousVentureLoopProofReport(proof: AutonomousVentureLoopProof): string[] {
  const result = verifyAutonomousVentureLoopProof(proof);
  if (result.proven) {
    return [
      "PASS autonomous-venture-loop-proof: start -> earn -> learn -> kill/scale -> repeat -> safety proven",
    ];
  }
  return [
    "FAIL autonomous-venture-loop-proof: " + result.gaps.length + " gap(s)",
    ...result.gaps.map((gap) => "FAIL " + gap.requirement + ": " + gap.message),
  ];
}

async function main(): Promise<void> {
  const proof = await loadAutonomousVentureLoopProofJson(parseAutonomousVentureLoopProofCliConfig());
  const lines = formatAutonomousVentureLoopProofReport(proof);
  for (const line of lines) console.log(line);
  if (lines.some((line) => line.startsWith("FAIL "))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
