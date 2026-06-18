import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

/**
 * HTTP channel for the @bid pilot (#339). Verbatim from `eve init` so the pilot runs exactly as a
 * fresh eve agent does. Auth fails closed: `placeholderAuth()` rejects production browser traffic,
 * so an unconfigured pilot serves no open routes (honors #200 — no irreversible exposure).
 */
export default eveChannel({
  auth: [
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
