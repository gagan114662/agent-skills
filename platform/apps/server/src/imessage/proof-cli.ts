#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyIMessageRoomProof, type IMessageRoomProof } from "./proof.js";

export interface IMessageRoomProofCliConfig {
  file: string;
  readStdin?: () => Promise<string>;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefix = name + "=";
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function parseIMessageRoomProofCliConfig(
  argv: string[] = process.argv.slice(2),
): IMessageRoomProofCliConfig {
  return { file: argValue(argv, "--file") ?? argValue(argv, "-f") ?? "" };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadIMessageRoomProofJson(config: IMessageRoomProofCliConfig): Promise<IMessageRoomProof> {
  const raw = config.file.trim()
    ? await readFile(config.file, "utf8")
    : await (config.readStdin ?? readStdin)();
  if (!raw.trim()) {
    throw new Error("imessage-room proof JSON is required; pass --file <path> or pipe JSON on stdin");
  }
  return JSON.parse(raw) as IMessageRoomProof;
}

export function formatIMessageRoomProofReport(proof: IMessageRoomProof): string[] {
  const result = verifyIMessageRoomProof(proof);
  if (result.proven) {
    return [
      "PASS imessage-room-proof: verified recipient -> room send -> inbound reply -> agent response -> iMessage reply proven",
    ];
  }
  return [
    "FAIL imessage-room-proof: " + result.gaps.length + " gap(s)",
    ...result.gaps.map((gap) => "FAIL " + gap.requirement + ": " + gap.message),
  ];
}

async function main(): Promise<void> {
  const proof = await loadIMessageRoomProofJson(parseIMessageRoomProofCliConfig());
  const lines = formatIMessageRoomProofReport(proof);
  for (const line of lines) console.log(line);
  if (lines.some((line) => line.startsWith("FAIL "))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
