import { useState } from "react";
import { VOICE } from "../brand.js";

type CopyState = "idle" | "done" | "failed";

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command rejected");
  } finally {
    textarea.remove();
  }
}

export function CopyButton({
  text,
  label = VOICE.copy.label,
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  async function copy(): Promise<void> {
    try {
      await copyTextToClipboard(text);
      setState("done");
    } catch {
      setState("failed");
    }
  }

  const message = state === "done" ? VOICE.copy.done : state === "failed" ? VOICE.copy.failed : null;

  return (
    <span className={`copyctl${className ? ` ${className}` : ""}`}>
      <button className="copyctl__button" type="button" onClick={() => void copy()}>
        {label}
      </button>
      {message && (
        <span className={`copyctl__status copyctl__status--${state}`} role={state === "failed" ? "alert" : "status"}>
          {message}
        </span>
      )}
    </span>
  );
}
