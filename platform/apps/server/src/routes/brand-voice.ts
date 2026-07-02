import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { createDefaultAssetService } from "../assets/default.js";
import { distillBrandVoiceEdit } from "../marketing/brand-voice-profile.js";

const MAX_OWNER_EDIT_CHARS = 4_000;

function cleanRequiredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const withoutControls = [...value]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
  const cleaned = withoutControls.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, MAX_OWNER_EDIT_CHARS) : null;
}

function sourceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
}

/**
 * Brand voice learning loop (#1543): owner edits are distilled into a proposed workspace voice profile.
 * The route never applies the update unless the owner explicitly confirms it, and it only mutates the
 * existing brand-kit voice string. No send/post/spend capability is introduced here.
 */
export async function brandVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/me/brand-voice/learn", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const body = (req.body ?? {}) as {
      originalDraft?: unknown;
      editedDraft?: unknown;
      sourceUrls?: unknown;
      confirm?: unknown;
    };
    const originalDraft = cleanRequiredText(body.originalDraft);
    const editedDraft = cleanRequiredText(body.editedDraft);
    if (!originalDraft || !editedDraft) {
      return reply.code(400).send({ error: "provide originalDraft and editedDraft" });
    }

    const svc = createDefaultAssetService(identity.workspaceId);
    const active = await svc.activeBrandKit(identity.workspaceId);
    const suggestion = distillBrandVoiceEdit({
      currentVoice: active?.kit.voice ?? null,
      originalDraft,
      editedDraft,
      sourceUrls: sourceUrls(body.sourceUrls),
    });
    const confirm = body.confirm === true;
    if (!confirm) {
      return {
        applied: false,
        activeBrandKit: !!active,
        suggestion,
      };
    }
    if (!active) {
      return reply.code(409).send({
        error: "set a brand kit before applying a learned brand voice",
        applied: false,
        activeBrandKit: false,
        suggestion,
      });
    }
    const result = await svc.setBrandKit(identity.workspaceId, {
      ...active.kit,
      voice: suggestion.nextVoice,
    });
    if (!result.ok) return reply.code(400).send({ error: result.errors.join("; "), errors: result.errors });
    return {
      applied: true,
      activeBrandKit: true,
      suggestion,
      brandKit: { id: result.record.id, ...result.record.kit },
    };
  });
}
