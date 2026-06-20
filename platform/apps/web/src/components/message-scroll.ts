/**
 * Channel auto-scroll decisions (#419) — the PURE layer that decides what the message feed should do when its
 * content grows, so a working agent's reply is never invisible at the bottom of the scroller.
 *
 * The bug it fixes: the realtime `message` event is already appended to store state (see store `applyEvent`),
 * but `.messagelist` is a top-aligned `overflow-y:auto` column with NO scroll management — so a newly-arrived
 * agent message lands below the fold and the channel never scrolls to it. The owner reads "no response."
 *
 * Two pieces, both pure and unit-tested without a DOM, a clock, or a socket (the #362 house style):
 *   · {@link isNearBottom} — is the viewport at/near the bottom right now? (drives "follow the conversation")
 *   · {@link decideOnNewMessages} — given how many messages just appeared, whether the user was near the bottom,
 *     and whether they authored the newest one, return "scroll" (jump to newest), "notify" (show the unread
 *     pill), or "none". A user's own send always follows; a passive reader who scrolled up is never yanked.
 *
 * #200: this module makes NO request and opens NO action path; it only decides scroll intent from numbers.
 * Message content stays DATA, rendered as React text by the feed — nothing here ever interprets a payload.
 */

/** Within this many px of the bottom counts as "at the bottom" — small enough to feel intentional, large
 * enough to forgive sub-pixel rounding and the in-flight row that nudges the scrollHeight as it lands. */
export const NEAR_BOTTOM_PX = 120;

/** The geometry of a scroll region — exactly the three numbers a DOM element exposes, passed in so this stays
 * pure (the caller reads them off the ref; this module never touches the DOM). */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Distance in px from the bottom of the scroll region (0 = pinned to the bottom). */
export function distanceFromBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

/**
 * True when the viewport is at/near the bottom, so newly-arrived messages should auto-follow. A region that
 * doesn't overflow (everything fits) is trivially "at the bottom". The threshold defaults to
 * {@link NEAR_BOTTOM_PX} and is overridable for tests.
 */
export function isNearBottom(m: ScrollMetrics, thresholdPx = NEAR_BOTTOM_PX): boolean {
  return distanceFromBottom(m) <= thresholdPx;
}

export interface NewMessagesInput {
  /** How many messages appeared since the previous render (added = now - before; never negative in practice). */
  readonly added: number;
  /** Whether the viewport was at/near the bottom BEFORE these messages landed. */
  readonly wasNearBottom: boolean;
  /** Whether the user authored the newest arrival — their own send always follows the conversation down. */
  readonly authoredBySelf: boolean;
}

/** What the feed should do when its message count grows. */
export type ScrollAction = "scroll" | "notify" | "none";

/**
 * Decide how to react to newly-appended messages:
 *   · nothing added                       → "none"
 *   · user sent it, or was near the bottom → "scroll" (follow to the newest message)
 *   · user had scrolled up to read history → "notify" (surface a "new messages" pill, don't yank them)
 *
 * Pure: no DOM, no clock, never throws.
 */
export function decideOnNewMessages(input: NewMessagesInput): ScrollAction {
  if (input.added <= 0) return "none";
  if (input.authoredBySelf || input.wasNearBottom) return "scroll";
  return "notify";
}
