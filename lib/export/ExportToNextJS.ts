import { WorkflowEdge } from '../execution/ExecutionEngine';
import { WorkflowNode } from '../execution/NodeExecutors';

export type CanvasState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

const toVar = (id: string): string => `node_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

function topologicalSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue = nodes.filter((n) => inDegree.get(n.id) === 0);
  const result: WorkflowNode[] = [];

  while (queue.length) {
    const node = queue.shift()!;
    result.push(node);
    for (const target of adjacency.get(node.id) ?? []) {
      const next = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, next);
      if (next === 0) {
        const found = nodes.find((n) => n.id === target);
        if (found) queue.push(found);
      }
    }
  }

  if (result.length !== nodes.length) {
    throw new Error('Cannot export workflow with cycles.');
  }

  return result;
}

export function exportToNextJS(state: CanvasState): { path: string; code: string } {
  const ordered = topologicalSort(state.nodes, state.edges);

  const lines: string[] = [];
  lines.push(`import { NextRequest } from 'next/server';`);
  lines.push(`import { streamText } from 'ai';`);
  lines.push(`import { openai } from '@ai-sdk/openai';`);
  lines.push(`import { anthropic } from '@ai-sdk/anthropic';`);
  lines.push(`import { google } from '@ai-sdk/google';`);
  lines.push('');
  lines.push(`type AnyJson = Record<string, unknown> | unknown[] | string | number | boolean | null;`);
  lines.push('');
  lines.push(`export async function POST(req: NextRequest): Promise<Response> {`);
  lines.push(`  const startedAt = Date.now();`);
  lines.push(`  const body = (await req.json().catch(() => ({}))) as AnyJson;`);
  lines.push(`  const nodeResults = new Map<string, unknown>();`);
  lines.push(`  const errors: Array<{ nodeId: string; message: string }> = [];`);
  lines.push('');
  lines.push(`  const readInput = (nodeId: string): unknown => {`);
  lines.push(`    const incoming = ${JSON.stringify(state.edges)}.filter((e) => e.target === nodeId).map((e) => nodeResults.get(e.source));`);
  lines.push(`    return incoming.length <= 1 ? incoming[0] : incoming;`);
  lines.push(`  };`);
  lines.push('');

  for (const node of ordered) {
    lines.push(`  try {`);
    lines.push(`    const input = readInput('${node.id}');`);

    if (node.type === 'trigger') {
      lines.push(`    const ${toVar(node.id)} = { source: 'trigger', payload: body, nodeId: '${node.id}' };`);
      lines.push(`    nodeResults.set('${node.id}', ${toVar(node.id)});`);
    } else if (node.type === 'llm') {
      const config = node.config as { provider?: string; model?: string; promptTemplate?: string };
      const provider = config.provider ?? 'openai';
      const model = config.model ?? 'gpt-4o-mini';
      const prompt = (config.promptTemplate ?? '{{input}}').replace(/`/g, '\\`');

      lines.push(`    const prompt = \`${prompt}\`.replace(/\{\{\s*input\s*\}\}/g, JSON.stringify(input));`);
      lines.push(`    const llm = ${provider === 'anthropic' ? `anthropic('${model}')` : provider === 'google' ? `google('${model}')` : `openai('${model}')`};`);
      lines.push(`    const completion = await streamText({ model: llm, prompt });`);
      lines.push(`    const ${toVar(node.id)} = await completion.text;`);
      lines.push(`    nodeResults.set('${node.id}', { text: ${toVar(node.id)}, provider: '${provider}', model: '${model}' });`);
    } else if (node.type === 'transform') {
      lines.push(`    const ${toVar(node.id)} = typeof input === 'string' ? input : JSON.stringify(input);`);
      lines.push(`    nodeResults.set('${node.id}', ${toVar(node.id)});`);
    } else {
      lines.push(`    const ${toVar(node.id)} = { nodeId: '${node.id}', output: input };`);
      lines.push(`    nodeResults.set('${node.id}', ${toVar(node.id)});`);
    }

    lines.push(`  } catch (error) {`);
    lines.push(`    errors.push({ nodeId: '${node.id}', message: error instanceof Error ? error.message : String(error) });`);
    lines.push(`  }`);
    lines.push('');
  }

  lines.push(`  const outputNodes = ${JSON.stringify(state.nodes.filter((n) => n.type === 'output').map((n) => n.id))};`);
  lines.push(`  const outputs = outputNodes.map((id) => ({ id, result: nodeResults.get(id) }));`);
  lines.push(`  const status = errors.length > 0 ? 207 : 200;`);
  lines.push(`  return Response.json({ outputs, errors, durationMs: Date.now() - startedAt }, { status });`);
  lines.push(`}`);

  return {
    path: 'app/api/workflow/route.ts',
    code: lines.join('\n'),
  };
}
