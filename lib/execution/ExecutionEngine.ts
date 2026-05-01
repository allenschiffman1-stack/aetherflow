import { executors, NodeType, WorkflowNode } from './NodeExecutors';

export type WorkflowEdge = { id: string; source: string; target: string };
export type EngineState = 'idle' | 'running' | 'paused' | 'error' | 'complete';
export type NodeState = 'pending' | 'running' | 'complete' | 'error' | 'skipped';

export type NodeMetrics = {
  status: NodeState;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export class ExecutionEngine {
  private state: EngineState = 'idle';
  private paused = false;
  private readonly nodeMetrics = new Map<string, NodeMetrics>();
  private readonly nodeResults = new Map<string, unknown>();

  get executionState(): EngineState {
    return this.state;
  }

  get metrics(): Record<string, NodeMetrics> {
    return Object.fromEntries(this.nodeMetrics.entries());
  }

  get results(): Record<string, unknown> {
    return Object.fromEntries(this.nodeResults.entries());
  }

  pause(): void {
    if (this.state === 'running') {
      this.paused = true;
      this.state = 'paused';
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.paused = false;
      this.state = 'running';
    }
  }

  private topoSort(graph: WorkflowGraph): WorkflowNode[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of graph.nodes) {
      inDegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of graph.edges) {
      adjacency.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }

    const queue = graph.nodes.filter((n) => inDegree.get(n.id) === 0);
    const order: WorkflowNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const nextId of adjacency.get(current.id) ?? []) {
        const nextIn = (inDegree.get(nextId) ?? 0) - 1;
        inDegree.set(nextId, nextIn);
        if (nextIn === 0) {
          const nextNode = graph.nodes.find((n) => n.id === nextId);
          if (nextNode) queue.push(nextNode);
        }
      }
    }

    if (order.length !== graph.nodes.length) {
      throw new Error('Workflow graph contains a cycle.');
    }

    return order;
  }

  async execute(
    graph: WorkflowGraph,
    options?: {
      signal?: AbortSignal;
      onNodeUpdate?: (nodeId: string, status: NodeMetrics) => void;
      onStreamChunk?: (nodeId: string, chunk: string) => void;
    },
  ): Promise<Record<string, unknown>> {
    this.state = 'running';
    this.paused = false;
    this.nodeMetrics.clear();
    this.nodeResults.clear();

    const order = this.topoSort(graph);
    const inputEdgesByNode = new Map<string, WorkflowEdge[]>();

    for (const node of graph.nodes) {
      inputEdgesByNode.set(node.id, graph.edges.filter((edge) => edge.target === node.id));
      this.nodeMetrics.set(node.id, { status: 'pending' });
    }

    for (const node of order) {
      while (this.paused) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (options?.signal?.aborted) {
        this.state = 'error';
        throw new DOMException('Execution aborted.', 'AbortError');
      }

      const start = performance.now();
      this.nodeMetrics.set(node.id, { status: 'running', startedAt: start });
      options?.onNodeUpdate?.(node.id, this.nodeMetrics.get(node.id)!);

      try {
        const incomingEdges = inputEdgesByNode.get(node.id) ?? [];
        const inputs = incomingEdges.map((edge) => this.nodeResults.get(edge.source));
        const input = inputs.length <= 1 ? inputs[0] : inputs;

        const executor = executors[node.type as NodeType];
        if (!executor) throw new Error(`No executor registered for node type: ${node.type}`);

        const result = await executor({
          node,
          input,
          context: {
            signal: options?.signal,
            onStreamChunk: options?.onStreamChunk,
          },
        });

        const finish = performance.now();
        this.nodeResults.set(node.id, result);
        this.nodeMetrics.set(node.id, {
          status: 'complete',
          startedAt: start,
          finishedAt: finish,
          durationMs: finish - start,
        });
      } catch (error) {
        const finish = performance.now();
        this.nodeMetrics.set(node.id, {
          status: 'error',
          startedAt: start,
          finishedAt: finish,
          durationMs: finish - start,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      options?.onNodeUpdate?.(node.id, this.nodeMetrics.get(node.id)!);
    }

    const hasErrors = Array.from(this.nodeMetrics.values()).some((metric) => metric.status === 'error');
    this.state = hasErrors ? 'error' : 'complete';
    return this.results;
  }
}
