export const runtime = 'nodejs';
export function GET() { return Response.json({ ok: true, service: 'ae-chat-agent', version: '0.2.0', execution: 'server' }, { headers: { 'Cache-Control': 'no-store' } }); }
