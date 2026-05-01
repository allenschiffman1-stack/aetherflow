'use client';

import { useMemo, useState } from 'react';
import { exportToNextJS } from '../../../lib/export/ExportToNextJS';
import { WorkflowEdge } from '../../../lib/execution/ExecutionEngine';
import { WorkflowNode } from '../../../lib/execution/NodeExecutors';

type Props = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export function ExportPanel({ nodes, edges }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const artifact = useMemo(() => exportToNextJS({ nodes, edges }), [nodes, edges]);

  const copy = async () => {
    await navigator.clipboard.writeText(artifact.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const download = () => {
    const blob = new Blob([artifact.code], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'route.ts';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-2xl border border-white/20 bg-white/10 p-4 backdrop-blur-xl shadow-xl text-white">
      <h3 className="text-lg font-semibold">Export to Next.js</h3>
      <p className="text-xs text-white/70 mt-1">Generates {artifact.path} from the current workflow.</p>

      <div className="mt-4 flex gap-2">
        <button className="rounded-lg bg-cyan-500/80 px-3 py-2 text-sm font-medium" onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium" onClick={download}>
          Download
        </button>
      </div>

      <pre className="mt-4 max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/40 p-3 text-xs leading-relaxed">
        <code>{artifact.code}</code>
      </pre>
    </section>
  );
}
