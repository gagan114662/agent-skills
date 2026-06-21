/**
 * The outbound-channel vocabulary (issue #395). A pure, zero-dependency leaf module so BOTH the Drizzle
 * schema (`db/schema/outbound-channels.ts`) and the pure feature logic (which runs in the no-DB/no-network
 * unit job) share a single source of truth without dragging the ORM into the pure unit path.
 */

/** The outbound channels the fleet can connect. The lowest-risk first channel (#395 / #268) is Postmark. */
export const OUTBOUND_CHANNELS = ["email_postmark"] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

/**
 * Connection lifecycle. `pending` = the owner has not completed the connect-once step (no credential);
 * `connected` = a credential fingerprint + sending identity are recorded and the channel can send;
 * `revoked` = the owner disconnected — the channel can no longer send.
 */
export const OUTBOUND_CHANNEL_STATUSES = ["pending", "connected", "revoked"] as const;
export type OutboundChannelStatus = (typeof OUTBOUND_CHANNEL_STATUSES)[number];

/** The two production-grounded receipt sources (mirrors action-contract `RECEIPT_SOURCES`, #200 §3). */
export const OUTBOUND_RECEIPT_SOURCES = ["live_url", "production_readback"] as const;
export type OutboundReceiptSource = (typeof OUTBOUND_RECEIPT_SOURCES)[number];
