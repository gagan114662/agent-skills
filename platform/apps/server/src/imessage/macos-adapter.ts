import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IMessageAdapter } from "./types.js";

const execFileAsync = promisify(execFile);

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
  constructor(private readonly osascriptBin = "osascript") {}

  async send(input: { recipient: string; text: string; serviceName?: string }): Promise<void> {
    await execFileAsync(this.osascriptBin, [
      "-e",
      SEND_IMESSAGE_APPLESCRIPT,
      input.recipient,
      input.text,
      input.serviceName ?? "",
    ]);
  }
}
