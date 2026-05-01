'use client';

import { useEffect, useMemo, useState } from 'react';
import { AIProvider, KeyVault } from '../../../lib/keys/KeyVault';

const providerLabels: Record<AIProvider, string> = {
  [AIProvider.OpenAI]: 'OpenAI',
  [AIProvider.Anthropic]: 'Anthropic',
  [AIProvider.Google]: 'Google',
};

export function KeyVaultPanel(): JSX.Element {
  const [provider, setProvider] = useState<AIProvider>(AIProvider.OpenAI);
  const [input, setInput] = useState('');
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string>('');

  const providers = useMemo(() => Object.values(AIProvider), []);

  const refresh = () => {
    const active = KeyVault.listProvidersWithKeys();
    const index = Object.fromEntries(providers.map((p) => [p, active.includes(p)]));
    setHasKey(index);
  };

  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!input.trim()) return;
    await KeyVault.setKey(provider, input.trim());
    setInput('');
    setStatus(`${providerLabels[provider]} key saved.`);
    refresh();
  };

  const remove = (target: AIProvider) => {
    KeyVault.deleteKey(target);
    setStatus(`${providerLabels[target]} key deleted.`);
    refresh();
  };

  const testConnection = async (target: AIProvider) => {
    try {
      const key = await KeyVault.getKey(target);
      if (!key) {
        setStatus(`No ${providerLabels[target]} key configured.`);
        return;
      }
      setStatus(`${providerLabels[target]} key is available in local vault.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to read key vault.');
    }
  };

  return (
    <section className="rounded-2xl border border-white/20 bg-white/10 p-4 backdrop-blur-xl shadow-xl text-white">
      <h3 className="text-lg font-semibold">Key Vault (BYOK)</h3>
      <p className="text-xs text-white/70 mt-1">Keys are encrypted in localStorage via AES-GCM.</p>

      <div className="mt-4 space-y-2">
        <label className="text-xs uppercase tracking-wider text-white/70">Provider</label>
        <select
          className="w-full rounded-lg bg-black/30 border border-white/20 p-2"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AIProvider)}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerLabels[p]}
            </option>
          ))}
        </select>

        <input
          className="w-full rounded-lg bg-black/30 border border-white/20 p-2"
          placeholder="Paste API key"
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="w-full rounded-lg bg-cyan-500/80 p-2 font-medium" onClick={save}>
          Save Key
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {providers.map((p) => (
          <div key={p} className="rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{providerLabels[p]}</span>
              <span className="text-xs text-white/70">{hasKey[p] ? '••••••••••••' : 'Not set'}</span>
            </div>
            <div className="mt-2 flex gap-2">
              <button className="flex-1 rounded-md bg-white/10 p-1.5 text-sm" onClick={() => testConnection(p)}>
                Test
              </button>
              <button className="flex-1 rounded-md bg-red-500/70 p-1.5 text-sm" onClick={() => remove(p)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {status && <p className="mt-3 text-xs text-cyan-200">{status}</p>}
    </section>
  );
}
