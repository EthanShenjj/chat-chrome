function convert(packet: any) {
  for (const choice of packet.choices ?? []) {
    const message = choice.delta ?? choice.message;
    if (message && typeof message.reasoning_content === 'string') message.reasoning = message.reasoning_content;
  }
  return packet;
}

// The Agents SDK uses `reasoning`; these APIs return `reasoning_content`.
export async function compatibleReasoning(response: Response): Promise<Response> {
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  if (!headers.get('content-type')?.includes('text/event-stream')) {
    const text = await response.text();
    try { return new Response(JSON.stringify(convert(JSON.parse(text))), { status: response.status, headers }); }
    catch { return new Response(text, { status: response.status, headers }); }
  }
  const decoder = new TextDecoder(), encoder = new TextEncoder(); let pending = '';
  const line = (value: string) => {
    if (!value.startsWith('data:')) return value;
    const data = value.slice(5).trim(); if (!data || data === '[DONE]') return value;
    try { return `data: ${JSON.stringify(convert(JSON.parse(data)))}`; } catch { return value; }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true }); let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { controller.enqueue(encoder.encode(line(pending.slice(0, end).replace(/\r$/, '')) + '\n')); pending = pending.slice(end + 1); }
    },
    flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encoder.encode(line(pending))); }
  }));
  return new Response(body, { status: response.status, headers });
}
