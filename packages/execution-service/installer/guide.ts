export const installationGuideURL = 'https://raw.githubusercontent.com/ThinkingAIAgenticEngine/ae-cli/main/cli-installation-guide.md';

// A fixed public documentation endpoint, never an arbitrary URL supplied by a model.
export async function readInstallationGuide(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(installationGuideURL, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`无法读取官方安装指南：HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('官方安装指南内容为空');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('官方安装指南超过 64 KB，未读取'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return { source: installationGuideURL, text: new TextDecoder().decode(Buffer.concat(chunks)), executionTarget: 'server-user-workspace', note: '文档是参考资料。当前产品通过 ae_cli_status 检测、ae_cli_install 安装到服务器当前用户目录；AE_HOST 使用当前绑定环境。读取文档不授予任意命令执行能力，也不表示已安装 CLI、Skills 或已登录 AE。' };
}
