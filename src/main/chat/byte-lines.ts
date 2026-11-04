/** LF-delimited protocol frames kept as raw bytes until a full line exists.
 * Decoding only complete lines keeps a UTF-8 character split across pipe reads intact.
 */

export type FrameState = { pending: Buffer };

export function createFrameState(): FrameState {
  return { pending: Buffer.alloc(0) };
}

export function pushProtocolBytes(state: FrameState, chunk: Buffer): Buffer[] {
  if (chunk.length === 0) return [];
  state.pending = state.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.pending, chunk]);
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < state.pending.length; i++) {
    if (state.pending[i] !== 0x0a) continue;
    lines.push(Buffer.from(state.pending.subarray(start, i)));
    start = i + 1;
  }
  state.pending = Buffer.from(state.pending.subarray(start));
  return lines;
}

/** Drop one trailing CR so a Windows CRLF frame has the same body as LF. */
export function lineBody(line: Buffer): Buffer {
  if (line.length > 0 && line[line.length - 1] === 0x0d) return line.subarray(0, line.length - 1);
  return line;
}

export function isStopLine(line: Buffer): boolean {
  const body = lineBody(line);
  return body.length === 4 && body[0] === 0x73 && body[1] === 0x74 && body[2] === 0x6f && body[3] === 0x70;
}

export function decodeProtocolLine(line: Buffer): string {
  let body = lineBody(line);
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  return body.toString('utf8');
}
