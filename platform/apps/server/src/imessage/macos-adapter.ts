import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IMessageAdapter } from "./types.js";

const execFileAsync = promisify(execFile);
const SQLITE_SEPARATOR = "\t";

const SEND_IMESSAGE_APPLESCRIPT = [
  "on run argv",
  "  set targetAddress to item 1 of argv",
  "  set messageText to item 2 of argv",
  "  set serviceName to item 3 of argv",
  "  tell application \"Messages\"",
  "    if serviceName is \"\" then",
  "      set targetService to first service whose service type = iMessage",
  "    else",
  "      set targetService to service serviceName",
  "    end if",
  "    set targetBuddy to buddy targetAddress of targetService",
  "    send messageText to targetBuddy",
  "  end tell",
  "end run",
].join("\n");

export class MacOsMessagesAdapter implements IMessageAdapter {
  constructor(
    private readonly osascriptBin = "osascript",
    private readonly sqliteBin = "sqlite3",
  ) {}

  async send(input: { recipient: string; text: string; serviceName?: string }): Promise<void> {
    await execFileAsync(this.osascriptBin, [
      "-e",
      SEND_IMESSAGE_APPLESCRIPT,
      input.recipient,
      input.text,
      input.serviceName ?? "",
    ]);
  }

  async latestMessageRowId(input: { dbPath: string }): Promise<number> {
    const { stdout } = await execFileAsync(this.sqliteBin, [
      "-readonly",
      input.dbPath,
      "SELECT COALESCE(MAX(ROWID), 0) FROM message;",
    ]);
    const parsed = Number(String(stdout ?? "").trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  async inboundMessagesAfter(input: {
    dbPath: string;
    recipients: string[];
    afterRowId: number;
    limit: number;
  }): Promise<Array<{ rowId: number; sender: string; text: string }>> {
    const recipients = Array.from(new Set(input.recipients.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean)));
    if (recipients.length === 0) return [];
    const inList = recipients.map(sqlString).join(", ");
    const query = [
      "SELECT message.ROWID, handle.id,",
      "replace(replace(replace(COALESCE(message.text, ''), char(9), ' '), char(10), '\\n'), char(13), '\\r')",
      "FROM message",
      "JOIN handle ON handle.ROWID = message.handle_id",
      "WHERE message.is_from_me = 0",
      "AND message.text IS NOT NULL",
      "AND message.ROWID > " + Math.max(0, Math.floor(input.afterRowId)),
      "AND lower(handle.id) IN (" + inList + ")",
      "ORDER BY message.ROWID ASC",
      "LIMIT " + Math.max(1, Math.min(100, Math.floor(input.limit))) + ";",
    ].join(" ");
    const { stdout } = await execFileAsync(this.sqliteBin, ["-readonly", "-separator", SQLITE_SEPARATOR, input.dbPath, query]);
    return String(stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [rowIdRaw, sender = "", ...textParts] = line.split(SQLITE_SEPARATOR);
        const rowId = Number(rowIdRaw);
        return {
          rowId: Number.isFinite(rowId) ? rowId : 0,
          sender,
          text: textParts.join(SQLITE_SEPARATOR).replace(/\\n/g, "\n").replace(/\\r/g, "\r").trim(),
        };
      })
      .filter((row) => row.rowId > input.afterRowId && row.sender.trim() && row.text.trim());
  }
}

function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
