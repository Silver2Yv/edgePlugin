// 服务商预设（H2、L2）：设置向导下一轮用（这里只给数据表）。基础地址、「获取 API Key」链接
// 核实自官方文档，出处见各条注释；地址与格式可能随厂商调整，变化自产品里的「自定义」兜底。
import type { InterfaceType } from './adapter';

export interface ProviderPreset {
  /** 对应 Connection.preset */
  id: string;
  name: string;
  baseUrl: string;
  interfaceType: InterfaceType;
  /** 「获取 API Key」跳转链接 */
  apiKeyUrl: string;
  /** 常用模型建议，供设置向导预填 */
  suggestedModels: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    // api-docs.deepseek.com/zh-cn（首次调用 API）；platform.deepseek.com/api_keys
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    interfaceType: 'chatCompletions',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    // help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope（华北2/北京地域）；
    // bailian.console.aliyun.com API Key 管理页
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    interfaceType: 'chatCompletions',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    suggestedModels: ['qwen-plus', 'qwen-flash', 'qwen-max'],
  },
  {
    // platform.openai.com/docs/api-reference；platform.openai.com/api-keys
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    interfaceType: 'chatCompletions',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    suggestedModels: ['gpt-4o', 'gpt-5'],
  },
  {
    // docs.anthropic.com/en/api/openai-sdk（OpenAI SDK compatibility）；console.anthropic.com/settings/keys
    id: 'claude',
    name: 'Claude（OpenAI 兼容层）',
    baseUrl: 'https://api.anthropic.com/v1',
    interfaceType: 'chatCompletions',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-5'],
  },
  {
    // ai.google.dev/gemini-api/docs/openai；aistudio.google.com/apikey
    id: 'gemini',
    name: 'Gemini（OpenAI 兼容层）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    interfaceType: 'chatCompletions',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'custom',
    name: '自定义 / OpenAI 兼容',
    baseUrl: '',
    interfaceType: 'chatCompletions',
    apiKeyUrl: '',
    suggestedModels: [],
  },
];
