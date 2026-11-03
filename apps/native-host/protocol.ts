import { MAX_FRAME } from '../../packages/contracts/index';
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]); const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME || length === 0) throw new Error('Native Messaging frame 大小无效');
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'))); this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
export function frame(value: unknown): Buffer { const body = Buffer.from(JSON.stringify(value)); if (body.length > MAX_FRAME) throw new Error('Native 消息过大'); const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]); }
