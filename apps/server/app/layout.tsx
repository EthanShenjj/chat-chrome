import type { Metadata } from 'next';
import './server.css';
export const metadata: Metadata = { title: 'AE Chat Agent · 线上工作区', description: '一个 Chrome 扩展，连接模型、AE CLI 与团队工具。' };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
