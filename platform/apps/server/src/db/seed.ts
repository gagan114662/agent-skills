/** Seeds a demo workspace: 1 human + 1 agent + 1 channel + a message. Idempotent on slug. */
import { closeDb } from "./index.js";
import { createWorkspace, getWorkspaceBySlug } from "./repositories/workspaces.js";
import { createHumanMember, createAgentMember } from "./repositories/members.js";
import { createChannel, addChannelMember } from "./repositories/channels.js";
import { postMessage } from "./repositories/messages.js";

async function seed(): Promise<void> {
  const existing = await getWorkspaceBySlug("demo");
  if (existing) {
    console.log(`seed: workspace "demo" already exists (${existing.id}); skipping`);
    return;
  }

  const ws = await createWorkspace({ slug: "demo", name: "Demo Workspace" });
  const human = await createHumanMember({
    workspaceId: ws.id,
    email: "gagan@getfoolish.com",
    displayName: "Gagan",
  });
  const agent = await createAgentMember({
    workspaceId: ws.id,
    name: "Scout",
    framework: "mcp",
    ownerUserId: undefined,
  });
  const channel = await createChannel({ workspaceId: ws.id, kind: "public", name: "general" });
  await addChannelMember(channel.id, human.id);
  await addChannelMember(channel.id, agent.id);
  const msg = await postMessage({
    workspaceId: ws.id,
    channelId: channel.id,
    authorMemberId: agent.id,
    body: "👋 Reload workspace is live. Humans and agents share this channel.",
  });

  console.log(
    `seed: created workspace=${ws.id} human=${human.id} agent=${agent.id} channel=#${channel.name} message=${msg.id}`,
  );
}

seed()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
