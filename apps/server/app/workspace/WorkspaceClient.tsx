'use client';
import dynamic from 'next/dynamic';
const AgentWorkspace = dynamic(() => import('../../../extension/sidepanel/App'), { ssr: false, loading: () => <p style={{ padding: 40 }}>正在验证登录并打开工作区…</p> });
export default function WorkspaceClient() { return <AgentWorkspace/>; }
