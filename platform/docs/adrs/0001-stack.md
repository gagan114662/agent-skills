# ADR-0001: Reload platform technology stack

- **Status:** Proposed (awaiting approval — issue #1)
- **Date:** 2026-06-06
- **Context issue:** [#1](https://github.com/gagan114662/agent-skills/issues/1)
- **Supersedes:** —

## Context

Reload is a Slack-for-AI-agents platform (reload.chat-style): realtime chat where humans and AI agents are first-class members, multi-protocol agent integration (MCP/ACP/A2A/REST/CLI), a Linear-style task system, and an auto-captured typed memory graph — multi-tenant. We are building greenfield in `platform/` and need a coherent stack chosen once, up front, because issues #2–#19 all depend on it. Constraints that drive the choice:

- **Realtime-first** (channels, presence, live delivery) → needs first-class WebSocket + pub/sub.
- **Agent-first** → MCP has an official **TypeScript** SDK; a TS-everywhere stack lets server, agent tooling, and shared contracts share types.
- **Relational, queryable data** (channels, threads, tasks, permissions, memory graph) → SQL with a typed ORM.
- **One language across server, web, shared contracts, CLI** to minimize context-switching and duplicate types.

## Decision

| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript (strict)** on **Node 22 LTS** | One language end-to-end; official MCP SDK is TS; strong typing for shared contracts. |
| Monorepo | **pnpm workspaces** | Fast, disk-efficient, first-class workspace support; clean `apps/*` + `packages/*` split. |
| HTTP | **Fastify 5** | High throughput, schema-based validation, mature plugin ecosystem, good TS support. |
| Realtime | **`ws`** mounted on the Fastify server | Standard, lightweight; we control the protocol. (Revisit socket.io in #5 if reconnection/rooms sugar proves worth the weight.) |
| Database | **PostgreSQL 16 + Drizzle ORM** | Postgres gives FTS (#7), JSONB for the memory graph, strong consistency for multi-tenant; Drizzle is typed, migration-friendly, lightweight. |
| Cache / pub-sub / presence | **Redis 7 (`ioredis`)** | Pub/sub fan-out across server instances (#5), presence, ephemeral state. |
| Web | **React 19 + Vite 5** | Ubiquitous, fast dev loop; suits the Slack-style UI (#18). |
| Agent protocol | **`@modelcontextprotocol/sdk`** (added in #10) | Official MCP SDK; primary agent on-ramp ("no custom integration"). |
| Tests | **Vitest** | Fast, ESM-native, unified across workspaces. |
| Lint/format | **ESLint + Prettier** | Standard; Prettier ends formatting debates. |
| Local infra | **Docker Compose** | One command to get Postgres+Redis; mirrors CI service containers. |

## Alternatives considered

- **Go services** (as in the prior `agent-chat-platform`): great perf, but splits the language boundary with the TS MCP SDK and web client, duplicating contract types. Rejected for a TS-everywhere coherence win on a greenfield build.
- **Prisma** instead of Drizzle: heavier runtime/codegen; Drizzle's lighter, SQL-first model fits the typed-contract goal. 
- **NestJS** instead of Fastify-direct: more structure but more ceremony than the skeleton needs; Fastify keeps it lean and we add structure as features land.
- **socket.io** instead of raw `ws`: nicer reconnection/rooms, heavier and opinionated; deferred decision to #5.

## Consequences

- **Positive:** shared types across server/web/CLI/agent tooling; single toolchain; realtime + relational + pub-sub all first-class; MCP integration is low-friction.
- **Negative / risks:** Node single-threaded CPU limits (mitigate by scaling instances behind Redis, #5/#19); Drizzle is younger than Prisma (mitigate: migrations checked in, #2); raw `ws` means we hand-roll reconnection (revisit in #5).
- **Locked for:** #2–#19 build on these choices. Any change requires updating this ADR first (per spec boundaries).
