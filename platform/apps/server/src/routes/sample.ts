import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config/loader.js";
import {
  resolveSignupEntryCaps,
  isSampleWorkspaceOffered,
  buildSampleConsole,
  type SignupEntryCaps,
  type SampleConsole,
} from "../onboarding/signup-entry.js";

/**
 * The #300 read-only sample workspace (ADR-0300) — the low-commitment front door.
 *
 * `GET /sample/console` lets a prospect see at least one real agent deliverable with NO account and NO
 * Google data scope — the alternative to the broad-scope OAuth wall at `/start`. It is **unauthenticated**
 * and **read-only**: it creates no workspace, no session and no row, and triggers no real-world action, so
 * there is nothing to undo (#200 §4 bounded blast radius). The payload is a static constant, so a poisoned
 * request can never steer it (#200 §6). Default OFF: when the `signupEntry.sampleWorkspace` flag is unset
 * the route honestly answers `{ offered: false }` (no fake demo, #200 §3) and the web hides the entry.
 */
export interface SampleRoutesOptions {
  /** Injectable caps for tests; `undefined` ⇒ read live from the layered config (default OFF). */
  signupEntry?: SignupEntryCaps;
}

/** The response shape the web reads to decide whether to show the sample entry + what to render. */
export interface SampleConsoleResponse {
  offered: boolean;
  console: SampleConsole | null;
}

export async function sampleRoutes(app: FastifyInstance, opts: SampleRoutesOptions = {}): Promise<void> {
  function caps(): SignupEntryCaps {
    return opts.signupEntry ?? resolveSignupEntryCaps(loadConfig().signupEntry);
  }

  app.get("/sample/console", async (): Promise<SampleConsoleResponse> => {
    if (!isSampleWorkspaceOffered(caps())) return { offered: false, console: null };
    return { offered: true, console: buildSampleConsole() };
  });
}
