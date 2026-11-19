import { SseParser } from "@/lib/live/parser";

const STREAM =
  ": connected\n\n" +
  'event: delivery\ndata: {"type":"delivery","status":"succeeded"}\n\n' +
  ": ping\n\n" +
  'event: breaker\ndata: {"type":"breaker","state":"open"}\n\n';

const EXPECTED = [
  { event: "delivery", data: '{"type":"delivery","status":"succeeded"}' },
  { event: "breaker", data: '{"type":"breaker","state":"open"}' },
];

function feed(chunks: string[]) {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
}

describe("SseParser", () => {
  it("parses whole events and ignores comment lines", () => {
    expect(feed([STREAM])).toEqual(EXPECTED);
  });

  it("gives the same events however the stream is split, down to single characters", () => {
    for (let size = 1; size <= STREAM.length; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < STREAM.length; i += size) chunks.push(STREAM.slice(i, i + size));
      expect(feed(chunks)).toEqual(EXPECTED);
    }
  });

  it("handles CRLF and lone CR line endings, including a CRLF split across chunks", () => {
    const crlf = STREAM.replaceAll("\n", "\r\n");
    expect(feed([crlf])).toEqual(EXPECTED);
    const cut = crlf.indexOf("\r\n") + 1; // between the CR and the LF
    expect(feed([crlf.slice(0, cut), crlf.slice(cut)])).toEqual(EXPECTED);
    // A CR ending a chunk may be half of a CRLF, so it waits for the next chunk (here the
    // server's next ping) before the line counts as ended.
    const cr = STREAM.replaceAll("\n", "\r");
    expect(feed([cr])).toEqual(EXPECTED.slice(0, 1));
    expect(feed([cr, ": ping\r"])).toEqual(EXPECTED);
  });

  it("does not dispatch an event until its blank line arrives", () => {
    const p = new SseParser();
    expect(p.push('event: delivery\ndata: {"a":1}\n')).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "delivery", data: '{"a":1}' }]);
  });

  it("joins multi-line data, defaults the type to message, and strips one leading space only", () => {
    expect(feed(["data: a\ndata:  b\ndata\n\n"])).toEqual([{ event: "message", data: "a\n b\n" }]);
  });

  it("does not carry an event type over to the next event", () => {
    expect(feed(["event: breaker\ndata: 1\n\ndata: 2\n\n"])).toEqual([
      { event: "breaker", data: "1" },
      { event: "message", data: "2" },
    ]);
  });

  it("ignores a block with no data and fields it does not use", () => {
    expect(feed(["event: delivery\n\nid: 7\nretry: 10\n: ping\n\n"])).toEqual([]);
  });
});
