import { spawn } from "node:child_process";

/** The outcome of a single `git` invocation. */
export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs `git` with an explicit argv (never a shell). Mirrors the #50 harness rule: untrusted input is
 * passed as data (argv elements), never interpolated into a command line, so a hostile string can't
 * inject. Injectable so tests can use a fake without spawning a process when they want to.
 */
export interface GitRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitResult>;
}

/** The real runner: spawns the host `git` binary with the given argv in `cwd`. No shell. */
export class SpawnGitRunner implements GitRunner {
  constructor(private readonly bin = "git") {}

  run(args: string[], opts: { cwd: string }): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd: opts.cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  }
}
