import { useState, useEffect, useCallback } from 'react';
import { Pencil, Trash2, Zap, Pause, RefreshCw, Copy, Check, Plus, X } from 'lucide-react';

interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  retryCount: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

interface WebhooksPanelProps {
  enabled?: boolean;
}

const KNOWN_EVENTS = [
  'topic.created', 'topic.updated', 'topic.deleted',
  'chat.message', 'agent.status', 'cron.executed', 'webhook.test',
];

export function WebhooksPanel({ enabled = true }: WebhooksPanelProps) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const loadWebhooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/webhooks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setWebhooks(data.webhooks || []);
    } catch (err) {
      console.error('[Webhooks] Failed to load:', err);
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    loadWebhooks();
    const interval = setInterval(loadWebhooks, 30000);
    return () => clearInterval(interval);
  }, [enabled, loadWebhooks]);

  const createWebhook = useCallback(async (data: { name: string; url: string; events: string[] }) => {
    try {
      const res = await fetch('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const webhook = await res.json();
      setWebhooks(prev => [webhook, ...prev]);
      setShowCreateForm(false);
    } catch (err) {
      console.error('[Webhooks] Create failed:', err);
      setError('Failed to create');
    }
  }, []);

  const updateWebhook = useCallback(async (id: string, data: Partial<Webhook>) => {
    try {
      const res = await fetch('/api/webhooks/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      setWebhooks(prev => prev.map(w => w.id === id ? updated : w));
      setEditingWebhook(null);
    } catch (err) {
      console.error('[Webhooks] Update failed:', err);
      setError('Failed to update');
    }
  }, []);

  const deleteWebhook = useCallback(async (id: string) => {
    if (!confirm('Delete this webhook?')) return;
    try {
      const res = await fetch('/api/webhooks/' + id, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWebhooks(prev => prev.filter(w => w.id !== id));
    } catch (err) {
      console.error('[Webhooks] Delete failed:', err);
      setError('Failed to delete');
    }
  }, []);

  const toggleActive = useCallback(async (id: string, active: boolean) => {
    try {
      const res = await fetch('/api/webhooks/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setWebhooks(prev => prev.map(w => w.id === id ? { ...w, active } : w));
    } catch (err) {
      console.error('[Webhooks] Toggle failed:', err);
    }
  }, []);

  if (showCreateForm || editingWebhook) {
    return (
      <div data-testid="webhooks-panel" className="pb-2 px-2">
        <WebhookForm
          webhook={editingWebhook}
          onSave={(data) => {
            if (editingWebhook) {
              updateWebhook(editingWebhook.id, data);
            } else {
              createWebhook(data as { name: string; url: string; events: string[] });
            }
          }}
          onCancel={() => { setShowCreateForm(false); setEditingWebhook(null); }}
        />
      </div>
    );
  }

  return (
    <div data-testid="webhooks-panel" className="pb-2 px-2">
      {error && (
        <div className="px-2 py-1 text-[11px] text-red-500">{error}</div>
      )}

      {webhooks.length > 0 ? (
        <div className="space-y-0.5">
          {webhooks.map(webhook => (
            <WebhookRow
              key={webhook.id}
              webhook={webhook}
              onToggle={toggleActive}
              onEdit={setEditingWebhook}
              onDelete={deleteWebhook}
            />
          ))}
        </div>
      ) : !loading ? (
        <div className="px-2 py-3 text-center text-[11px] text-app-text-muted">
          No webhooks
        </div>
      ) : null}

      <div className="flex items-center gap-1 mt-1">
        <button
          onClick={() => setShowCreateForm(true)}
          data-testid="webhook-create-btn"
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
        >
          <Plus size={12} />
          Add webhook
        </button>
        <button
          onClick={loadWebhooks}
          disabled={loading}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  );
}

interface WebhookRowProps {
  webhook: Webhook;
  onToggle: (id: string, active: boolean) => void;
  onEdit: (webhook: Webhook) => void;
  onDelete: (id: string) => void;
}

function WebhookRow({ webhook, onToggle, onEdit, onDelete }: WebhookRowProps) {
  const [showActions, setShowActions] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string } | null>(null);

  const testWebhook = useCallback(async () => {
    try {
      const res = await fetch('/api/webhooks/' + webhook.id + '/test', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTestResult(data);
      setTimeout(() => setTestResult(null), 3000);
    } catch {
      setTestResult({ status: 'failed' });
      setTimeout(() => setTestResult(null), 3000);
    }
  }, [webhook.id]);

  return (
    <div
      data-testid="webhook-row"
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded group cursor-pointer ${
        webhook.active ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-app-hover'
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(webhook.id, !webhook.active); }}
        className={`w-4 h-4 flex items-center justify-center rounded transition-colors ${
          webhook.active ? 'text-primary' : 'text-app-text-muted'
        }`}
        title={webhook.active ? 'Disable' : 'Enable'}
      >
        {webhook.active ? <Zap size={12} /> : <Pause size={12} />}
      </button>

      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-app-text truncate">{webhook.name}</div>
        <div className="flex items-center gap-2 text-[11px] text-app-text-muted">
          <span className="truncate max-w-[120px]">{webhook.url}</span>
          {webhook.events.length > 0 && (
            <span className="bg-app-hover rounded px-1">{webhook.events.length} events</span>
          )}
        </div>
        {testResult && (
          <div className={`text-[11px] mt-0.5 ${testResult.status === 'success' ? 'text-green-500' : 'text-red-500'}`}>
            Test: {testResult.status}
          </div>
        )}
      </div>

      {showActions && !testResult && (
        <div className="flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(webhook); }}
            className="p-1 text-app-text-muted hover:text-primary transition-colors"
            title="Edit"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); testWebhook(); }}
            className="p-1 text-app-text-muted hover:text-primary transition-colors"
            title="Test delivery"
          >
            <Zap size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(webhook.id); }}
            className="p-1 text-app-text-muted hover:text-red-500 transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

interface WebhookFormProps {
  webhook: Webhook | null;
  onSave: (data: Partial<Webhook>) => void;
  onCancel: () => void;
}

function WebhookForm({ webhook, onSave, onCancel }: WebhookFormProps) {
  const [name, setName] = useState(webhook?.name || '');
  const [url, setUrl] = useState(webhook?.url || '');
  const [events, setEvents] = useState<string[]>(webhook?.events || []);
  const [active, setActive] = useState(webhook?.active ?? true);
  const [secretCopied, setSecretCopied] = useState(false);
  const [secret, setSecret] = useState(webhook?.secret || '');

  const toggleEvent = (event: string) => {
    setEvents(prev => prev.includes(event) ? prev.filter(e => e !== event) : [...prev, event]);
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  };

  const regenerateSecret = () => {
    setSecret(crypto.randomUUID());
  };

  return (
    <div data-testid="webhook-form" className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-app-text">{webhook ? 'Edit' : 'New'} Webhook</span>
        <button onClick={onCancel} className="p-1 text-app-text-muted hover:text-app-text">
          <X size={14} />
        </button>
      </div>

      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={e => setName(e.target.value)}
        className="w-full px-2 py-1.5 text-[11px] bg-app-hover border border-app-border rounded text-app-text placeholder:text-app-text-muted"
      />

      <input
        type="url"
        placeholder="https://example.com/webhook"
        value={url}
        onChange={e => setUrl(e.target.value)}
        className="w-full px-2 py-1.5 text-[11px] bg-app-hover border border-app-border rounded text-app-text placeholder:text-app-text-muted"
      />

      {webhook && (
        <div>
          <div className="text-[11px] text-app-text-muted mb-1">Secret</div>
          <div className="flex items-center gap-1">
            <div className="flex-1 px-2 py-1 text-[11px] bg-app-hover border border-app-border rounded text-app-text-muted font-mono truncate">
              {'•'.repeat(12)}
            </div>
            <button onClick={copySecret} className="p-1 text-app-text-muted hover:text-app-text" title="Copy secret">
              {secretCopied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            </button>
            <button onClick={regenerateSecret} className="p-1 text-app-text-muted hover:text-app-text" title="Regenerate">
              <RefreshCw size={12} />
            </button>
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] text-app-text-muted mb-1">Events</div>
        <div className="grid grid-cols-2 gap-1">
          {KNOWN_EVENTS.map(event => (
            <label key={event} className="flex items-center gap-1.5 text-[11px] text-app-text cursor-pointer">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={() => toggleEvent(event)}
                className="w-3 h-3 rounded border-app-border"
              />
              {event}
            </label>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-1.5 text-[11px] text-app-text cursor-pointer">
        <input
          type="checkbox"
          checked={active}
          onChange={e => setActive(e.target.checked)}
          className="w-3 h-3 rounded border-app-border"
        />
        Active
      </label>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => onSave({ name, url, events, active, ...(secret !== webhook?.secret ? { secret } : {}) })}
          disabled={!name.trim() || !url.trim()}
          className="flex-1 px-3 py-1.5 text-[11px] text-white bg-primary hover:bg-primary/90 rounded transition-colors disabled:opacity-50"
        >
          {webhook ? 'Save' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-[11px] text-app-text-muted hover:text-app-text hover:bg-app-hover rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
