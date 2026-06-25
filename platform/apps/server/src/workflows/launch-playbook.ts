import type { WorkflowAction, WorkflowCondition, WorkflowTrigger } from "./types.js";

export type LaunchChannel = "product_hunt" | "hacker_news" | "communities" | "linkedin" | "x";
export type LaunchPhase = "pre_launch" | "launch" | "monitoring";
export type LaunchOwner = "quill" | "echo" | "lens" | "mark" | "owner";

export interface BuildLaunchPlaybookInput {
  name: string;
  launchAt: Date;
  channelId: string;
  channels?: LaunchChannel[];
  ownerMessage?: string;
}

export interface LaunchChecklistItem {
  phase: LaunchPhase;
  owner: LaunchOwner;
  title: string;
  dueAt: string;
  target?: string;
}

export interface LaunchPlaybookWorkflowDraft {
  name: string;
  trigger: WorkflowTrigger;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
}

export interface LaunchPlaybook {
  checklist: LaunchChecklistItem[];
  workflow: LaunchPlaybookWorkflowDraft;
}

export const LAUNCH_CHANNELS: readonly LaunchChannel[] = ["product_hunt", "hacker_news", "communities", "linkedin", "x"];
const DEFAULT_CHANNELS: LaunchChannel[] = ["product_hunt", "hacker_news", "communities"];
const CHANNEL_TARGETS: Record<LaunchChannel, string> = {
  product_hunt: "Product Hunt",
  hacker_news: "Hacker News / Show HN",
  communities: "founder and AI-operator communities",
  linkedin: "LinkedIn",
  x: "X",
};

export function isLaunchChannel(value: unknown): value is LaunchChannel {
  return typeof value === "string" && LAUNCH_CHANNELS.includes(value as LaunchChannel);
}

function dueAt(launchAt: Date, offsetMinutes: number): string {
  return new Date(launchAt.getTime() + offsetMinutes * 60_000).toISOString();
}

function taskFor(title: string, detail: string): string {
  return [
    title,
    "",
    detail,
    "",
    "Produce a concrete artifact or monitoring note in this channel. Do not publish or send externally; queue any outbound copy for owner approval.",
  ].join("\n");
}

export function buildLaunchPlaybook(input: BuildLaunchPlaybookInput): LaunchPlaybook {
  const name = input.name.trim() || "Launch";
  const channels = input.channels && input.channels.length > 0 ? input.channels : DEFAULT_CHANNELS;
  const checklist: LaunchChecklistItem[] = [
    {
      phase: "pre_launch",
      owner: "quill",
      title: "Prepare launch assets",
      dueAt: dueAt(input.launchAt, -48 * 60),
    },
    {
      phase: "pre_launch",
      owner: "mark",
      title: "QA launch positioning and proof",
      dueAt: dueAt(input.launchAt, -24 * 60),
    },
    ...channels.map((channel) => ({
      phase: "launch" as const,
      owner: "echo" as const,
      title: "Queue launch post",
      dueAt: dueAt(input.launchAt, -30),
      target: CHANNEL_TARGETS[channel],
    })),
    {
      phase: "monitoring",
      owner: "lens",
      title: "Monitor launch replies and traffic",
      dueAt: dueAt(input.launchAt, 30),
    },
    {
      phase: "monitoring",
      owner: "echo",
      title: "Draft rapid-response replies",
      dueAt: dueAt(input.launchAt, 60),
    },
    {
      phase: "monitoring",
      owner: "lens",
      title: "Summarize launch window",
      dueAt: dueAt(input.launchAt, 4 * 60),
    },
  ];

  const launchTasks: WorkflowAction[] = [
    {
      kind: "agent_task",
      channelId: input.channelId,
      agentHandle: "quill",
      task: taskFor(
        "Prepare launch assets",
        "Prepare launch-day assets for " + name + ": concise value prop, launch page bullets, FAQ answers, proof points, and reply snippets.",
      ),
    },
    {
      kind: "agent_task",
      channelId: input.channelId,
      agentHandle: "mark",
      task: taskFor(
        "QA launch positioning and proof",
        "Review " + name + " launch materials for brand voice, concrete proof, screenshots, and obvious missing claims before launch.",
      ),
    },
    ...channels.map<WorkflowAction>((channel) => ({
      kind: "draft_send",
      sendKind: "social.post",
      summary: "Queue " + name + " launch post for " + CHANNEL_TARGETS[channel],
      target: CHANNEL_TARGETS[channel],
    })),
    {
      kind: "agent_task",
      channelId: input.channelId,
      agentHandle: "lens",
      task: taskFor(
        "Monitor launch replies and traffic",
        "Monitor " + name + " during the launch window. Track questions, objections, traffic hints, signups, and anything the owner should answer quickly.",
      ),
    },
    {
      kind: "agent_task",
      channelId: input.channelId,
      agentHandle: "echo",
      task: taskFor(
        "Draft rapid-response replies",
        "Draft short replies for the highest-signal questions and objections from " + name + ". Keep every reply as a draft for owner review.",
      ),
    },
    {
      kind: "notify_owner",
      message: input.ownerMessage?.trim() || name + " launch playbook is running; you are the launch commander.",
    },
  ];

  return {
    checklist,
    workflow: {
      name: "Launch-day coordination: " + name,
      trigger: { kind: "webhook" },
      conditions: [],
      actions: launchTasks,
      enabled: true,
    },
  };
}
