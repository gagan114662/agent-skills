import { defineAgent } from "eve";

/**
 * Runtime config for the @bid pilot on Vercel's eve framework (#339 spike).
 *
 * The model is the managed fleet default (ipop never lets a user pick a model — see the
 * "remove model picker" change): the same `claude-opus-4-8` the bespoke runtime injects, expressed
 * here as the AI Gateway model id. A bare string id routes through the Vercel AI Gateway, so a
 * deployed pilot authenticates via Vercel OIDC with no provider key in source (mirrors ipop's #192
 * server-side vault: the credential never reaches the agent's env). PILOT ONLY — not wired to prod.
 */
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
