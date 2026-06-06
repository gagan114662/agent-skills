# Reload — data model (issue #2)

Multi-tenant: every table except global `users` carries `workspace_id` and cascades on
workspace delete. PKs are UUIDv7. Decisions: [ADR-0002](adrs/0002-data-model.md).

```mermaid
erDiagram
  workspaces ||--o{ agents : has
  workspaces ||--o{ members : has
  workspaces ||--o{ channels : has
  workspaces ||--o{ messages : has
  users ||--o{ members : "is (human)"
  agents ||--o{ members : "is (agent)"
  users ||--o{ agents : owns
  channels ||--o{ channel_members : has
  members ||--o{ channel_members : in
  channels ||--o{ messages : contains
  members ||--o{ messages : authors
  messages ||--o{ messages : "thread parent"
  members ||--o{ tasks : "assignee / creator"
  workspaces ||--o{ memories : has
  memories ||--o{ memory_edges : from
  memories ||--o{ memory_edges : to
  members ||--o{ permissions : grants

  workspaces { uuid id PK; text slug UK; text name; timestamptz created_at }
  users { uuid id PK; text email UK; text display_name; timestamptz created_at }
  agents { uuid id PK; uuid workspace_id FK; uuid owner_user_id FK; text name; text framework; timestamptz created_at }
  members { uuid id PK; uuid workspace_id FK; text kind; uuid user_id FK; uuid agent_id FK; text display_name; timestamptz created_at }
  channels { uuid id PK; uuid workspace_id FK; text kind; text name; boolean is_archived; timestamptz created_at }
  channel_members { uuid channel_id FK; uuid member_id FK; timestamptz joined_at }
  messages { uuid id PK; uuid workspace_id FK; uuid channel_id FK; uuid author_member_id FK; uuid parent_message_id FK; text body; timestamptz created_at; timestamptz edited_at; timestamptz deleted_at }
  tasks { uuid id PK; uuid workspace_id FK; text title; text status; uuid assignee_member_id FK; uuid created_by_member_id FK; timestamptz created_at }
  memories { uuid id PK; uuid workspace_id FK; text type; jsonb content; timestamptz created_at }
  memory_edges { uuid id PK; uuid workspace_id FK; uuid from_memory_id FK; uuid to_memory_id FK; text relation; timestamptz created_at }
  permissions { uuid id PK; uuid workspace_id FK; uuid member_id FK; text resource_type; uuid resource_id; text capability }
```

**Stub tables** (`tasks`, `memories`, `memory_edges`, `permissions`) carry only FKs + minimal
columns here; their owning issues (#14, #15, #9) extend them via new migrations.
