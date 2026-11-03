import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const secret = process.env.AE_CHAT_GATEWAY_SECRET;
  if (!secret) return NextResponse.next();
  const supplied = request.headers.get('x-ae-gateway-secret') || '';
  const a = Buffer.from(secret), b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new NextResponse('Not found', { status: 404 });
  return NextResponse.next();
}
