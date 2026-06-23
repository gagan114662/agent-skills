import { useEffect, useMemo, useState } from "react";

export type ShortFormPlatform = "tiktok" | "instagram" | "youtube" | "linkedin";

export interface ShortFormDraft {
  readonly id: string;
  readonly title: string;
  readonly platform: ShortFormPlatform;
  readonly hook: string;
  readonly owner: string;
  readonly durationSec: number;
  readonly createdAt: string;
  readonly approvalRequestId: string;
}

export interface ShortFormCalendarPost {
  readonly id: string;
  readonly title: string;
  readonly platform: ShortFormPlatform;
  readonly status: "scheduled" | "published";
  readonly scheduledAt: string;
  readonly publishedAt?: string | null;
}

export interface ShortFormPublishingSeam {
  readonly listDrafts: (workspaceId: string) => Promise<readonly ShortFormDraft[]>;
  readonly listCalendar: (workspaceId: string) => Promise<readonly ShortFormCalendarPost[]>;
  readonly approveDraft: (workspaceId: string, draftId: string) => Promise<ShortFormCalendarPost>;
  readonly skipDraft: (workspaceId: string, draftId: string) => Promise<void>;
}

export interface ShortFormBlitzSurfaceProps {
  readonly workspaceId: string;
  readonly seam?: ShortFormPublishingSeam;
  readonly enabled?: boolean;
}

const emptySeam: ShortFormPublishingSeam = {
  listDrafts: async () => [],
  listCalendar: async () => [],
  approveDraft: async (_workspaceId, draftId) => ({
    id: `scheduled-${draftId}`,
    title: "Approved video draft",
    platform: "tiktok",
    status: "scheduled",
    scheduledAt: new Date(0).toISOString(),
  }),
  skipDraft: async () => undefined,
};

function formatPlatform(platform: ShortFormPlatform): string {
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  if (platform === "linkedin") return "LinkedIn";
  return "Instagram";
}

function formatDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
}

function byCalendarTime(a: ShortFormCalendarPost, b: ShortFormCalendarPost): number {
  return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
}

export function ShortFormBlitzSurface({
  workspaceId,
  seam = emptySeam,
  enabled = true,
}: ShortFormBlitzSurfaceProps): React.JSX.Element | null {
  const [drafts, setDrafts] = useState<readonly ShortFormDraft[]>([]);
  const [posts, setPosts] = useState<readonly ShortFormCalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setError(null);
    void Promise.all([seam.listDrafts(workspaceId), seam.listCalendar(workspaceId)])
      .then(([nextDrafts, nextPosts]) => {
        if (!live) return;
        setDrafts(nextDrafts);
        setPosts(nextPosts);
      })
      .catch(() => {
        if (live) setError("Could not load the short-form queue.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, seam, workspaceId]);

  const orderedPosts = useMemo(() => [...posts].sort(byCalendarTime), [posts]);
  const activeDraft = drafts[0] ?? null;

  if (!enabled) return null;

  async function approveActive(): Promise<void> {
    if (!activeDraft) return;
    setBusyId(activeDraft.id);
    setError(null);
    try {
      const scheduled = await seam.approveDraft(workspaceId, activeDraft.id);
      setDrafts((current) => current.filter((draft) => draft.id !== activeDraft.id));
      setPosts((current) => [...current, scheduled].sort(byCalendarTime));
    } catch {
      setError("Approval did not schedule. Try again from the queue.");
    } finally {
      setBusyId(null);
    }
  }

  async function skipActive(): Promise<void> {
    if (!activeDraft) return;
    setBusyId(activeDraft.id);
    setError(null);
    try {
      await seam.skipDraft(workspaceId, activeDraft.id);
      setDrafts((current) => current.filter((draft) => draft.id !== activeDraft.id));
    } catch {
      setError("Could not skip that draft.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="shortform" aria-label="Short-form Blitz">
      <div className="shortform__head">
        <div>
          <p className="shortform__eyebrow">Short-form</p>
          <h2 className="shortform__title">Blitz queue</h2>
        </div>
        <span className="shortform__count" aria-label={`${drafts.length} pending drafts`}>
          {drafts.length} pending
        </span>
      </div>

      {error && (
        <p className="shortform__error" role="alert">
          {error}
        </p>
      )}

      <div className="shortform__grid">
        <div className="shortform__queue">
          {loading ? (
            <p className="shortform__empty" role="status">
              Loading draft queue...
            </p>
          ) : activeDraft ? (
            <article className="shortform-card" aria-label={activeDraft.title}>
              <div className="shortform-card__top">
                <span className="shortform-card__platform">{formatPlatform(activeDraft.platform)}</span>
                <span className="shortform-card__duration">{activeDraft.durationSec}s</span>
              </div>
              <h3 className="shortform-card__title">{activeDraft.title}</h3>
              <p className="shortform-card__hook">{activeDraft.hook}</p>
              <dl className="shortform-card__meta">
                <div>
                  <dt>Owner</dt>
                  <dd>{activeDraft.owner}</dd>
                </div>
                <div>
                  <dt>Gate</dt>
                  <dd>{activeDraft.approvalRequestId}</dd>
                </div>
              </dl>
              <div className="shortform-card__actions">
                <button
                  className="btn btn--ghost btn--small"
                  type="button"
                  disabled={busyId === activeDraft.id}
                  onClick={() => void skipActive()}
                >
                  Skip
                </button>
                <button
                  className="btn btn--small"
                  type="button"
                  disabled={busyId === activeDraft.id}
                  onClick={() => void approveActive()}
                >
                  Approve
                </button>
              </div>
            </article>
          ) : (
            <p className="shortform__empty" role="status">
              No video drafts are waiting. Approved posts stay visible on the calendar.
            </p>
          )}
        </div>

        <div className="shortform-calendar" aria-label="Content calendar">
          <div className="shortform-calendar__head">
            <h3>Calendar</h3>
            <span>{orderedPosts.length} posts</span>
          </div>
          {orderedPosts.length === 0 ? (
            <p className="shortform-calendar__empty">No scheduled or published posts yet.</p>
          ) : (
            <ol className="shortform-calendar__list">
              {orderedPosts.map((post) => (
                <li key={post.id} className="shortform-calendar__post">
                  <time dateTime={post.scheduledAt}>
                    <span>{formatDay(post.scheduledAt)}</span>
                    <small>{formatTime(post.scheduledAt)}</small>
                  </time>
                  <div>
                    <strong>{post.title}</strong>
                    <span>{formatPlatform(post.platform)}</span>
                  </div>
                  <em className={`shortform-calendar__status shortform-calendar__status--${post.status}`}>
                    {post.status}
                  </em>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
