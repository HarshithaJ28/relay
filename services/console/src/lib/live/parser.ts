/**
 * Incremental parser for server-sent events (the subset GET /api/v1/stream uses).
 *
 * Bytes arrive in arbitrary chunks, so a line, a field or even a CRLF pair can be split
 * between two pushes; the parser keeps the unfinished tail and only acts on whole lines.
 * Lines end with LF, CRLF or CR. A line starting with ":" is a comment (": ping",
 * ": connected") and is ignored. "event:" sets the type, "data:" lines are joined with
 * newlines, and a blank line dispatches the event. Other fields (id, retry) are ignored:
 * the server does not send them and missed events are never replayed.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private tail = "";
  private type = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    let text = this.tail + chunk;
    // A CR at the very end may be the first half of a CRLF: wait for the next chunk.
    let held = "";
    if (text.endsWith("\r")) {
      held = "\r";
      text = text.slice(0, -1);
    }
    const lines = text.split(/\r\n|\r|\n/);
    this.tail = (lines.pop() ?? "") + held;
    for (const line of lines) this.line(line, out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) out.push({ event: this.type || "message", data: this.data.join("\n") });
      this.type = "";
      this.data = [];
      return;
    }
    // A comment line (": ping") has an empty field name, so the checks below ignore it.
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.type = value;
    else if (field === "data") this.data.push(value);
  }
}
