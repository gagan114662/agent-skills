import { newId } from "../db/id.js";

export type ReferralIncentiveKind = "referrer_credit" | "referred_credit";
export type ReferralIncentiveStatus = "fulfilled";

export interface ReferralCodeRecord {
  id: string;
  workspaceId: string;
  ownerMemberId: string;
  code: string;
  createdAt: Date;
}

export interface ReferralSignupRecord {
  id: string;
  referralCodeId: string;
  referrerWorkspaceId: string;
  referredWorkspaceId: string;
  referredMemberId: string;
  trackingRef: string | null;
  occurredAt: Date;
}

export interface ReferralIncentiveRecord {
  id: string;
  referralSignupId: string;
  workspaceId: string;
  kind: ReferralIncentiveKind;
  status: ReferralIncentiveStatus;
  amountCents: number;
  reason: string;
  createdAt: Date;
  fulfilledAt: Date;
}

export interface ReferralAudit {
  signup: ReferralSignupRecord;
  incentives: ReferralIncentiveRecord[];
}

export interface ReferralStore {
  getActiveCodeForWorkspace(workspaceId: string): Promise<ReferralCodeRecord | null>;
  getCode(code: string): Promise<ReferralCodeRecord | null>;
  createCode(input: { workspaceId: string; ownerMemberId: string; code: string }): Promise<ReferralCodeRecord>;
  recordSignup(input: {
    referralCode: ReferralCodeRecord;
    referredWorkspaceId: string;
    referredMemberId: string;
    trackingRef: string | null;
  }): Promise<ReferralSignupRecord>;
  fulfillIncentive(input: {
    referralSignupId: string;
    workspaceId: string;
    kind: ReferralIncentiveKind;
    amountCents: number;
    reason: string;
  }): Promise<ReferralIncentiveRecord>;
  listAudit(workspaceId: string): Promise<ReferralAudit[]>;
}

export interface ReferralServiceOptions {
  referrerCreditCents?: number;
  referredCreditCents?: number;
}

export interface AttributeReferralSignupInput {
  referralCode: string | null;
  referredWorkspaceId: string;
  referredMemberId: string;
  trackingRef: string | null;
}

export class ReferralService {
  private readonly referrerCreditCents: number;
  private readonly referredCreditCents: number;

  constructor(private readonly store: ReferralStore, opts: ReferralServiceOptions = {}) {
    this.referrerCreditCents = opts.referrerCreditCents ?? 2_500;
    this.referredCreditCents = opts.referredCreditCents ?? 2_500;
  }

  async ensureWorkspaceReferralCode(workspaceId: string, ownerMemberId: string): Promise<ReferralCodeRecord> {
    const existing = await this.store.getActiveCodeForWorkspace(workspaceId);
    if (existing) return existing;
    return this.store.createCode({ workspaceId, ownerMemberId, code: mintReferralCode() });
  }

  async attributeSignup(input: AttributeReferralSignupInput): Promise<ReferralAudit | null> {
    const rawCode = input.referralCode?.trim();
    if (!rawCode) return null;
    const referralCode = await this.store.getCode(rawCode);
    if (!referralCode || referralCode.workspaceId === input.referredWorkspaceId) return null;
    const signup = await this.store.recordSignup({
      referralCode,
      referredWorkspaceId: input.referredWorkspaceId,
      referredMemberId: input.referredMemberId,
      trackingRef: input.trackingRef,
    });
    const incentives = await Promise.all([
      this.store.fulfillIncentive({
        referralSignupId: signup.id,
        workspaceId: referralCode.workspaceId,
        kind: "referrer_credit",
        amountCents: this.referrerCreditCents,
        reason: "Referral signup credit",
      }),
      this.store.fulfillIncentive({
        referralSignupId: signup.id,
        workspaceId: input.referredWorkspaceId,
        kind: "referred_credit",
        amountCents: this.referredCreditCents,
        reason: "Referred signup welcome credit",
      }),
    ]);
    return { signup, incentives };
  }

  listAudit(workspaceId: string): Promise<ReferralAudit[]> {
    return this.store.listAudit(workspaceId);
  }
}

export class InMemoryReferralStore implements ReferralStore {
  private readonly codes = new Map<string, ReferralCodeRecord>();
  private readonly signupsByWorkspace = new Map<string, ReferralSignupRecord>();
  private readonly incentives = new Map<string, ReferralIncentiveRecord>();

  async getActiveCodeForWorkspace(workspaceId: string): Promise<ReferralCodeRecord | null> {
    return [...this.codes.values()].find((code) => code.workspaceId === workspaceId) ?? null;
  }

  async getCode(code: string): Promise<ReferralCodeRecord | null> {
    return this.codes.get(code) ?? null;
  }

  async createCode(input: { workspaceId: string; ownerMemberId: string; code: string }): Promise<ReferralCodeRecord> {
    const record = { id: newId(), workspaceId: input.workspaceId, ownerMemberId: input.ownerMemberId, code: input.code, createdAt: new Date() };
    this.codes.set(record.code, record);
    return record;
  }

  async recordSignup(input: {
    referralCode: ReferralCodeRecord;
    referredWorkspaceId: string;
    referredMemberId: string;
    trackingRef: string | null;
  }): Promise<ReferralSignupRecord> {
    const existing = this.signupsByWorkspace.get(input.referredWorkspaceId);
    if (existing) return existing;
    const record: ReferralSignupRecord = {
      id: newId(),
      referralCodeId: input.referralCode.id,
      referrerWorkspaceId: input.referralCode.workspaceId,
      referredWorkspaceId: input.referredWorkspaceId,
      referredMemberId: input.referredMemberId,
      trackingRef: input.trackingRef,
      occurredAt: new Date(),
    };
    this.signupsByWorkspace.set(input.referredWorkspaceId, record);
    return record;
  }

  async fulfillIncentive(input: {
    referralSignupId: string;
    workspaceId: string;
    kind: ReferralIncentiveKind;
    amountCents: number;
    reason: string;
  }): Promise<ReferralIncentiveRecord> {
    const key = `${input.referralSignupId}:${input.workspaceId}:${input.kind}`;
    const existing = this.incentives.get(key);
    if (existing) return existing;
    const now = new Date();
    const record: ReferralIncentiveRecord = { id: newId(), ...input, status: "fulfilled", createdAt: now, fulfilledAt: now };
    this.incentives.set(key, record);
    return record;
  }

  async listAudit(workspaceId: string): Promise<ReferralAudit[]> {
    return [...this.signupsByWorkspace.values()]
      .filter((signup) => signup.referrerWorkspaceId === workspaceId || signup.referredWorkspaceId === workspaceId)
      .map((signup) => ({
        signup,
        incentives: [...this.incentives.values()].filter((incentive) => incentive.referralSignupId === signup.id),
      }));
  }
}

export function mintReferralCode(): string {
  return `ref_${newId().replace(/-/g, "").slice(0, 16)}`;
}
