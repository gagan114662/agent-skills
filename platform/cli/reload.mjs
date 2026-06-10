#!/usr/bin/env node
// reload — a framework-agnostic CLI for the Reload agent interface (issue #11).
//
// It is deliberately a single zero-dependency Node ESM script: nothing but the platform's
// documented HTTP + WebSocket surface and a Bearer token. Any agent framework (LangChain,
// CrewAI, AutoGen, …) can shell out to it, or copy the ~10 lines of fetch it wraps.
//
// Requires Node >= 22 (global `fetch` + `WebSocket`).
//
// Config (env, overridable per-command with --url / --token):
//   RELOAD_API_URL   base URL of the server   (default http://localhost:3000)
//   RELOAD_TOKEN     agent Bearer token       (rld_agt_…, minted in #3)
//
// Commands:
//   reload whoami                        GET  /me
//   reload channels                      GET  /me/channels   (only what I can access)
//   reload read <channelId> [--limit N]  GET  /channels/:cid/messages   (tail N, default 20)
//   reload post <channelId> <text…>      POST /channels/:cid/messages
//   reload reply <channelId> <mid> <…>   POST /channels/:cid/messages/:mid/replies
//   reload mentions [--count]            GET  /me/mentions[/count]
//   reload watch [--channel <id>]        WS   /ws — stream my mentions (+ a channel's messages)
//   reload openapi                       GET  /openapi.json
//   reload doctor                        GET  /preflight — validate the cloud + real-agent posture
//   reload setup                         guided "zero → first cloud agent" checklist, then doctor
//   reload maintenance <on|off|status>   GET/POST /maintenance — instant read-only mode (#99)
//   reload help
//
// Global flags: --json (raw JSON output), --url <base>, --token <token>.
// Exit code is non-zero on any non-2xx response or usage error.

const HELP = `reload — framework-agnostic CLI for the Reload agent interface (#11)

Usage: reload <command> [args] [flags]

Commands:
  whoami                          show my identity + workspace (GET /me)
  channels                        list channels I can access   (GET /me/channels)
  read <channelId> [--limit N]    read a channel's messages    (default tail 20)
  post <channelId> <text...>      post a message
  reply <channelId> <msgId> <...> reply within a thread
  mentions [--count]              read (or count) my @mentions
  watch [--channel <id>]          stream my mentions live; --channel also streams that channel
  openapi                         print the OpenAPI 3.1 contract
  doctor                          validate the cloud + real-agent posture (GET /preflight)
  setup                           guided "zero → first cloud agent" checklist, then run doctor
  maintenance <on|off|status>     flip instant read-only maintenance mode (#99) [reason...]
  help                            show this help

Flags:
  --json            print raw JSON (scriptable)
  --url <base>      API base URL   (env RELOAD_API_URL, default http://localhost:3000)
  --token <token>   agent token    (env RELOAD_TOKEN)

Env:
  RELOAD_API_URL    base URL of the server
  RELOAD_TOKEN      agent Bearer token (rld_agt_…)
`;

function die(msg, code = 1) {
  process.stderr.write(`reload: ${msg}\n`);
  process.exit(code);
}

// Minimal flag parser: pulls --key value / --bool flags out, returns {positionals, flags}.
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const boolFlags = new Set(["json", "count"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (boolFlags.has(key)) flags[key] = true;
      else flags[key] = argv[++i];
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function config(flags) {
  const base = (flags.url ?? process.env.RELOAD_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const token = flags.token ?? process.env.RELOAD_TOKEN ?? "";
  return { base, token };
}

async function api(method, path, { base, token }, body) {
  if (!token) die("no token — set RELOAD_TOKEN or pass --token");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && data.error ? data.error : text || res.statusText;
    die(`${method} ${path} → ${res.status} ${detail}`, 2);
  }
  return data;
}

function out(data, flags, render) {
  if (flags.json || !render) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    render(data);
  }
}

const cmds = {
  async whoami(_pos, flags, cfg) {
    const me = await api("GET", "/me", cfg);
    out(me, flags, (m) =>
      console.log(`${m.displayName} (${m.kind})  member=${m.memberId}  workspace=${m.workspaceId}`),
    );
  },

  async channels(_pos, flags, cfg) {
    const list = await api("GET", "/me/channels", cfg);
    out(list, flags, (cs) => {
      if (!cs.length) return console.log("(no accessible channels)");
      for (const c of cs) console.log(`${c.capability.padEnd(9)} ${c.id}  ${c.name ?? "(dm)"}`);
    });
  },

  async read(pos, flags, cfg) {
    const cid = pos[0] ?? die("usage: reload read <channelId> [--limit N]");
    const limit = Number(flags.limit ?? 20);
    const all = await api("GET", `/channels/${cid}/messages`, cfg);
    const tail = Array.isArray(all) ? all.slice(-limit) : all;
    out(tail, flags, (ms) => {
      for (const m of ms) console.log(`[${m.authorMemberId.slice(0, 8)}] ${m.body}`);
    });
  },

  async post(pos, flags, cfg) {
    const cid = pos[0] ?? die("usage: reload post <channelId> <text...>");
    const body = pos.slice(1).join(" ");
    if (!body) die("usage: reload post <channelId> <text...>");
    const msg = await api("POST", `/channels/${cid}/messages`, cfg, { body });
    out(msg, flags, (m) => console.log(`posted ${m.id}`));
  },

  async reply(pos, flags, cfg) {
    const cid = pos[0];
    const mid = pos[1];
    const body = pos.slice(2).join(" ");
    if (!cid || !mid || !body) die("usage: reload reply <channelId> <msgId> <text...>");
    const msg = await api("POST", `/channels/${cid}/messages/${mid}/replies`, cfg, { body });
    out(msg, flags, (m) => console.log(`replied ${m.id}`));
  },

  async mentions(_pos, flags, cfg) {
    if (flags.count) {
      const c = await api("GET", "/me/mentions/count", cfg);
      return out(c, flags, (x) => console.log(String(x.count)));
    }
    const list = await api("GET", "/me/mentions", cfg);
    out(list, flags, (ms) => {
      if (!ms.length) return console.log("(no mentions)");
      for (const m of ms) console.log(`[${m.channelId.slice(0, 8)}] ${m.body}`);
    });
  },

  async openapi(_pos, flags, cfg) {
    // The contract is public — fetch without requiring a token.
    const res = await fetch(`${cfg.base}/openapi.json`);
    if (!res.ok) die(`GET /openapi.json → ${res.status}`, 2);
    process.stdout.write(`${await res.text()}\n`);
  },

  async watch(_pos, flags, cfg) {
    if (!cfg.token) die("no token — set RELOAD_TOKEN or pass --token");
    if (typeof WebSocket === "undefined") return watchByPolling(flags, cfg);
    const wsBase = cfg.base.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/ws?access_token=${encodeURIComponent(cfg.token)}`);
    ws.addEventListener("open", () => {
      process.stderr.write("watching… (Ctrl-C to stop)\n");
      if (flags.channel) ws.send(JSON.stringify({ type: "subscribe", channelId: flags.channel }));
    });
    ws.addEventListener("message", (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (flags.json) return process.stdout.write(`${JSON.stringify(frame)}\n`);
      if (frame.type === "mention") console.log(`@mention [${frame.mention.channelId.slice(0, 8)}] ${frame.mention.body}`);
      else if (frame.type === "message") console.log(`msg [${frame.message.channelId.slice(0, 8)}] ${frame.message.body}`);
      else if (frame.type === "error") process.stderr.write(`error: ${frame.code} ${frame.detail ?? ""}\n`);
    });
    ws.addEventListener("close", () => die("connection closed", 3));
    ws.addEventListener("error", () => die("websocket error — is the server up?", 3));
  },

  // Validate the deployment's cloud + real-agent posture (#69). Prints a ✓/⚠/✗ report from
  // GET /preflight and exits non-zero when a check fails — so it can gate a setup script.
  async doctor(_pos, flags, cfg) {
    const report = await api("GET", "/preflight", cfg);
    if (flags.json) return out(report, flags);
    const icon = { pass: "✓", warn: "⚠", fail: "✗" };
    console.log(
      `\nPreflight — profile "${report.profile}" (runtime=${report.runtime}, harness=${report.harness})\n`,
    );
    for (const c of report.checks) {
      console.log(`  ${icon[c.status] ?? "?"} ${String(c.name).padEnd(14)} ${c.message}`);
      if (c.remedy && c.status !== "pass") console.log(`      ↳ ${c.remedy}`);
    }
    console.log(
      report.ok
        ? `\nOK — the "${report.profile}" posture is ready.\n`
        : `\nNOT READY — fix the ✗ checks above, then re-run "reload doctor".\n`,
    );
    if (!report.ok) process.exit(1);
  },

  // Guided "zero → first cloud agent" checklist (#69), then run the live doctor.
  async setup(pos, flags, cfg) {
    process.stdout.write(SETUP_GUIDE);
    if (!cfg.token) {
      return die(
        'set RELOAD_TOKEN (and RELOAD_API_URL) then re-run "reload doctor" to validate — see the guide above',
      );
    }
    process.stdout.write("Running the live posture check…\n");
    await cmds.doctor(pos, flags, cfg);
  },

  // Flip instant read-only maintenance mode (#99). `status` reads the flag; `on`/`off` toggle it
  // (an authenticated operator action). The control route is exempt from the write-gate, so `off`
  // works even while maintenance is on.
  async maintenance(pos, flags, cfg) {
    const sub = pos[0] ?? "status";
    const render = (s) =>
      console.log(
        s.enabled
          ? `maintenance: ON${s.since ? ` since ${s.since}` : ""}${s.reason ? ` — ${s.reason}` : ""}${
              s.by ? ` (by ${s.by})` : ""
            }${s.unavailable ? " [flag store UNAVAILABLE — gate fails open]" : ""}`
          : `maintenance: OFF${s.unavailable ? " [flag store UNAVAILABLE — gate fails open]" : ""}`,
      );
    if (sub === "status") {
      return out(await api("GET", "/maintenance", cfg), flags, render);
    }
    if (sub === "on" || sub === "off") {
      const reason = pos.slice(1).join(" ") || undefined;
      const body = { on: sub === "on", ...(reason ? { reason } : {}) };
      return out(await api("POST", "/maintenance", cfg, body), flags, render);
    }
    die("usage: reload maintenance <on|off|status> [reason...]");
  },

  help() {
    process.stdout.write(HELP);
  },
};

const SETUP_GUIDE = `
reload setup — enable cloud + a real agent (zero → first cloud agent)

  1. Pick the cloud posture:    export RELOAD_PROFILE=prod   (sandbox + claude-code)
  2. Authenticate Vercel:       VERCEL_OIDC_TOKEN  (vercel link && vercel env pull)
                                — or —  VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID
     Install the sandbox SDK:   pnpm --filter @reload/server add @vercel/sandbox
  3. Authenticate the agent:    claude login   — or —   export ANTHROPIC_API_KEY=...
                                (Bedrock/Vertex: set CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX)
  4. Validate before any run:   pnpm -C platform --filter @reload/server preflight
  5. Then verify the server:    reload doctor

Full guide: platform/docs/guides/cloud-setup.md

`;

// Fallback for runtimes without a global WebSocket: poll mentions and print new ones.
async function watchByPolling(flags, cfg) {
  process.stderr.write("watching via polling (no WebSocket)…\n");
  const seen = new Set();
  for (;;) {
    const list = await api("GET", "/me/mentions", cfg);
    for (const m of list.slice().reverse()) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (flags.json) process.stdout.write(`${JSON.stringify(m)}\n`);
      else console.log(`@mention [${m.channelId.slice(0, 8)}] ${m.body}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  const cfg = config(flags);
  const handler = cmds[command ?? "help"];
  if (!handler) die(`unknown command "${command}". Run "reload help".`);
  await handler(positionals, flags, cfg);
}

main().catch((e) => die(e?.message ?? String(e)));
