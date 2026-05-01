import { KeyVault, AIProvider } from '../keys/KeyVault';

export type NodeType = 'trigger' | 'llm' | 'transform' | 'output';

export type WorkflowNode<TConfig = Record<string, unknown>> = {
  id: string;
  type: NodeType;
  name: string;
  config: TConfig;
};

export type ExecutionContext = {
  signal?: AbortSignal;
  onStreamChunk?: (nodeId: string, chunk: string) => void;
};

export type ExecutorInput = {
  node: WorkflowNode;
  input: unknown;
  context: ExecutionContext;
};

export type NodeExecutor = (input: ExecutorInput) => Promise<unknown>;

const readPath = (value: unknown, path: string): unknown => {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
};

export const TriggerExecutor: NodeExecutor = async ({ node }) => {
  const config = node.config as { mode?: 'manual' | 'webhook' | 'cron'; payload?: unknown; cron?: string };

  if (config.mode === 'webhook') {
    return {
      source: 'webhook',
      body: config.payload ?? {},
      receivedAt: new Date().toISOString(),
    };
  }

  if (config.mode === 'cron') {
    return {
      source: 'cron',
      expression: config.cron ?? '* * * * *',
      triggeredAt: new Date().toISOString(),
    };
  }

  return {
    source: 'manual',
    payload: config.payload ?? {},
    triggeredAt: new Date().toISOString(),
  };
};

const callOpenAICompat = async (provider: AIProvider, apiKey: string, model: string, prompt: string, signal?: AbortSignal) => {
  const endpointByProvider: Record<AIProvider, string> = {
    [AIProvider.OpenAI]: 'https://api.openai.com/v1/chat/completions',
    [AIProvider.Anthropic]: 'https://api.anthropic.com/v1/messages',
    [AIProvider.Google]: 'https://generativelanguage.googleapis.com/v1beta/models',
  };

  if (provider === AIProvider.OpenAI) {
    const response = await fetch(endpointByProvider[provider], {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal,
    });
    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? '';
  }

  if (provider === AIProvider.Anthropic) {
    const response = await fetch(endpointByProvider[provider], {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });
    const json = await response.json();
    return json.content?.[0]?.text ?? '';
  }

  const response = await fetch(`${endpointByProvider[provider]}/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal,
  });
  const json = await response.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
};

export const LLMExecutor: NodeExecutor = async ({ node, input, context }) => {
  const config = node.config as {
    provider: AIProvider;
    model: string;
    promptTemplate: string;
    stream?: boolean;
  };

  const key = await KeyVault.getKey(config.provider);
  if (!key) throw new Error(`No API key configured for ${config.provider}.`);

  const prompt = config.promptTemplate.replace(/\{\{\s*input\s*\}\}/g, JSON.stringify(input));
  const completion = await callOpenAICompat(config.provider, key, config.model, prompt, context.signal);

  if (config.stream && context.onStreamChunk) {
    for (const token of completion.split(/(\s+)/).filter(Boolean)) {
      context.onStreamChunk(node.id, token);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return {
    text: completion,
    provider: config.provider,
    model: config.model,
  };
};

export const TransformExecutor: NodeExecutor = async ({ node, input }) => {
  const config = node.config as {
    mode: 'parse_json' | 'template' | 'filter';
    template?: string;
    path?: string;
    equals?: string | number | boolean;
  };

  if (config.mode === 'parse_json') {
    if (typeof input !== 'string') return input;
    return JSON.parse(input);
  }

  if (config.mode === 'template') {
    const template = config.template ?? '{{input}}';
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path: string) => {
      if (path === 'input') return JSON.stringify(input);
      const resolved = readPath(input, path);
      return resolved == null ? '' : String(resolved);
    });
  }

  if (!Array.isArray(input)) return input;
  return input.filter((item) => {
    const value = readPath(item, config.path ?? '');
    return value === config.equals;
  });
};

export const OutputExecutor: NodeExecutor = async ({ node, input }) => {
  const config = node.config as { format?: 'json' | 'text'; label?: string };
  const label = config.label ?? node.name;
  if (config.format === 'text') {
    return `${label}: ${typeof input === 'string' ? input : JSON.stringify(input, null, 2)}`;
  }

  return {
    label,
    output: input,
    generatedAt: new Date().toISOString(),
  };
};

export const executors: Record<NodeType, NodeExecutor> = {
  trigger: TriggerExecutor,
  llm: LLMExecutor,
  transform: TransformExecutor,
  output: OutputExecutor,
};
