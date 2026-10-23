// MCP の標準入出力（1行1メッセージの JSON）。
export function stdioTransport(input = process.stdin, output = process.stdout) {
  let buffer = '';
  const t = {
    onmessage: null,
    onclose: null,
    async start() {
      input.setEncoding('utf8');
      input.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          t.onmessage?.(msg);
        }
      });
      input.on('end', () => t.onclose?.());
    },
    async send(msg) {
      output.write(JSON.stringify(msg) + '\n');
    },
    async close() {},
  };
  return t;
}
