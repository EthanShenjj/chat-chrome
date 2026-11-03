import { defaultProvider, type ProviderConfig } from './index';
export const providerPresets: ProviderConfig[] = [
  defaultProvider,
  { ...defaultProvider, id: 'deepseek', name: 'DeepSeek', protocol: 'openai-chat-completions', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', credentialRef: 'deepseek' },
  { ...defaultProvider, id: 'kimi-cn', name: 'Kimi 国内', protocol: 'openai-chat-completions', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro', credentialRef: 'kimi-cn' },
  { ...defaultProvider, id: 'kimi-global', name: 'Kimi 国际', protocol: 'openai-chat-completions', baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k3.1-pro', credentialRef: 'kimi-global' }
];
export function usesVendorReasoning(provider: ProviderConfig) {
  return provider.protocol === 'openai-chat-completions' && ['api.deepseek.com', 'api.moonshot.cn', 'api.moonshot.ai'].includes(new URL(provider.baseURL).hostname);
}
