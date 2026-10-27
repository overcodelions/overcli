import net from 'node:net';

const [address, conversationId, tool] = process.argv.slice(2);
const token = process.env.OVERCLI_TOOL_RELAY_TOKEN;
if (!address || !conversationId || !tool || !token) {
  process.stderr.write('overcli tool relay: missing launch data\n');
  process.exit(1);
}
const MAX_BUFFER = Number(process.env.OVERCLI_TOOL_RELAY_MAX_FRAME) || 8 * 1024 * 1024;
let done = false;
let ready = false;
let socket: net.Socket | null = null;
let pending: Buffer[] = [];
let pendingBytes = 0;
process.stdin.on('data', (chunk: Buffer) => {
  if (ready) { socket!.write(chunk); return; }
  pendingBytes += chunk.length;
  if (pendingBytes > MAX_BUFFER) process.exit(1);
  pending.push(chunk);
});
process.stdin.on('end', () => {
  done = true;
  if (ready) socket?.end();
});

function connect(left = 50): void {
  const sock = net.createConnection(address, () => {
    sock.write(JSON.stringify({ type: 'hello', token, conversationId, tool }) + '\n');
  });
  socket = sock;
  let retrying = false;
  let buffer = '';
  // Counted per chunk, and the newline search starts where the last one
  // ended: a large reply costs its length once, not once per chunk. The
  // relay never sends a frame over the cap (it fails that call instead), so
  // this trips only on a broken peer.
  let bufferedBytes = 0;
  let scanned = 0;
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    bufferedBytes += Buffer.byteLength(chunk);
    if (bufferedBytes > MAX_BUFFER) process.exit(1);
    const before = buffer.length;
    buffer += chunk;
    if (chunk.indexOf('\n') < 0) {
      if (scanned === before) scanned = buffer.length;
      return;
    }
    let at: number;
    while ((at = buffer.indexOf('\n', scanned)) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      scanned = 0;
      bufferedBytes = Buffer.byteLength(buffer);
      if (!ready) {
        if (line !== '{"type":"ready"}') process.exit(1);
        ready = true;
        for (const message of pending) sock.write(message);
        pending = [];
        pendingBytes = 0;
        if (done) sock.end();
      } else process.stdout.write(line + '\n');
    }
    scanned = buffer.length;
  });
  sock.on('error', () => {
    if (!ready && left) {
      retrying = true;
      setTimeout(() => connect(left - 1), 100);
    } else process.exit(1);
  });
  sock.on('close', () => {
    if (!retrying) process.exit(done ? 0 : 1);
  });
}
connect();
