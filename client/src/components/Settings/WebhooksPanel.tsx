import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Pencil, Play, X, Check, Webhook } from 'lucide-react';

// -- Types ------------------------------------------------------------------

interface WebhookData {
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

interface TestResult {
  deliveryId: string;
  status: 'success' | 'failed';
  httpStatus: number | null;
  error?: string;
}

// -- API wrapper -------------------------------------------------------------

const webhooksApi = {
  async list(): Promise<WebhookData[]> {
    const res = await fetch('/api/webhooks');
    const data = await res.json();
    return data.webhooks ?? [];
  },
  async create(body: Partial<WebhookData>): Promise<WebhookData> {
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  async update(id: string, body: Partial<WebhookData>): Promise<WebhookData> {
    const res = await fetch(`/api/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  },
  async remove(id: string): Promise<void> {
    await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
  },
  async test(id: string): Promise<TestResult> {
    const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' });
    return res.json();
  },
};

// -- Constants ---------------------------------------------------------------

const EVENT_TYPES = [
  'task.*',
  'agent.*',
  'approval.*',
  'topic.*',
  'message.sent',
  'message.received',
];

// -- Component ---------------------------------------------------------------

export function WebhooksPanel({ compact }: { compact?: boolean } = {}) {
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  // Form state
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formSecret, setFormSecret] = useState('');
  const [formEvents, setFormEvents] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await webhooksApi.list();
      setWebhooks(list);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setFormName('');
    setFormUrl('');
    setFormSecret('');
    setFormEvents([]);
    setEditingId(null);
    setShowForm(false);
  }

  function startEdit(wh: WebhookData) {
    setFormName(wh.name);
    setFormUrl(wh.url);
    setFormSecret(wh.secret);
    setFormEvents(wh.events);
    setEditingId(wh.id);
    setShowForm(true);
  }

  async function handleSubmit() {
    if (!formName.trim() || !formUrl.trim()) return;

    const body = {
      name: formName.trim(),
      url: formUrl.trim(),
      secret: formSecret.trim() || undefined,
      events: formEvents,
    };

    if (editingId) {
      await webhooksApi.update(editingId, body);
    } else {
      await webhooksApi.create(body);
    }

    resetForm();
    load();
  }

  async function handleDelete(id: string) {
    await webhooksApi.remove(id);
    load();
  }

  async function handleToggleActive(wh: WebhookData) {
    await webhooksApi.update(wh.id, { active: !wh.active });
    load();
  }

  async function handleTest(id: string) {
    try {
      const result = await webhooksApi.test(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [id]: { deliveryId: '', status: 'failed', httpStatus: null, error: 'Network error' },
      }));
    }
    // Clear result after 4s
    setTimeout(() => setTestResults((prev) => { const next = { ...prev }; delete next[id]; return next; }), 4000);
  }

  function toggleEvent(evt: string) {
    setFormEvents((prev) =>
      prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt],
    );
  }

  return (
    <div className="flex flex-col text-[11px]">
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-app-border">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-app-text">
            <Webhook size={13} />
            Webhooks
          </div>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <Plus size={11} /> Add
          </button>
        </div>
      )}
      {compact && (
        <div className="flex justify-end px-3 py-1.5">
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <Plus size={11} /> Add
          </button>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <div className="px-3 py-2.5 border-b border-app-border bg-surface space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-app-text">
              {editingId ? 'Edit Webhook' : 'New Webhook'}
            </span>
            <button onClick={resetForm} className="text-app-text-muted hover:text-app-text">
              <X size={12} />
            </button>
          </div>

          <input
            type="text"
            placeholder="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-black/5 dark:bg-white/5 border border-app-border text-app-text placeholder:text-app-text-muted text-[11px] outline-none focus:border-primary/50"
          />
          <input
            type="url"
            placeholder="https://example.com/webhook"
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-black/5 dark:bg-white/5 border border-app-border text-app-text placeholder:text-app-text-muted text-[11px] outline-none focus:border-primary/50"
          />
          <input
            type="text"
            placeholder="Secret (auto-generated if empty)"
            value={formSecret}
            onChange={(e) => setFormSecret(e.target.value)}
            className="w-full px-2 py-1.5 rounded bg-black/5 dark:bg-white/5 border border-app-border text-app-text placeholder:text-app-text-muted text-[11px] outline-none focus:border-primary/50"
          />

          {/* Events multi-select */}
          <div>
            <span className="text-[10px] text-app-text-muted mb-1 block">Events</span>
            <div className="flex flex-wrap gap-1">
              {EVENT_TYPES.map((evt) => (
                <button
                  key={evt}
                  onClick={() => toggleEvent(evt)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    formEvents.includes(evt)
                      ? 'bg-primary/15 border-primary/30 text-primary'
                      : 'bg-black/5 dark:bg-white/5 border-app-border text-app-text-muted hover:text-app-text-secondary'
                  }`}
                >
                  {evt}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-1.5 pt-1">
            <button
              onClick={resetForm}
              className="px-2.5 py-1 rounded text-[10px] font-medium text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!formName.trim() || !formUrl.trim()}
              className="px-2.5 py-1 rounded text-[10px] font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {editingId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-6 text-center text-app-text-muted text-[11px]">Loading...</div>
        ) : webhooks.length === 0 ? (
          <div className="px-3 py-6 text-center text-app-text-muted text-[11px]">No webhooks configured</div>
        ) : (
          <div className="divide-y divide-app-border">
            {webhooks.map((wh) => (
              <div key={wh.id} className="px-3 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  {/* Active indicator */}
                  <button
                    onClick={() => handleToggleActive(wh)}
                    title={wh.active ? 'Active - click to deactivate' : 'Inactive - click to activate'}
                    className="flex-shrink-0"
                  >
                    <div className={`w-2 h-2 rounded-full transition-colors ${wh.active ? 'bg-green-500' : 'bg-neutral-400'}`} />
                  </button>

                  <span className="font-medium text-app-text truncate">{wh.name}</span>

                  <div className="ml-auto flex items-center gap-1">
                    {/* Test result badge */}
                    {testResults[wh.id] && (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                        testResults[wh.id].status === 'success'
                          ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                          : 'bg-red-500/15 text-red-600 dark:text-red-400'
                      }`}>
                        {testResults[wh.id].status === 'success' ? (
                          <span className="flex items-center gap-0.5"><Check size={9} /> OK</span>
                        ) : (
                          testResults[wh.id].error || `HTTP ${testResults[wh.id].httpStatus}`
                        )}
                      </span>
                    )}

                    <button
                      onClick={() => handleTest(wh.id)}
                      title="Send test delivery"
                      className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted hover:text-app-text-secondary transition-colors"
                    >
                      <Play size={11} />
                    </button>
                    <button
                      onClick={() => startEdit(wh)}
                      title="Edit"
                      className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-muted hover:text-app-text-secondary transition-colors"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      onClick={() => handleDelete(wh.id)}
                      title="Delete"
                      className="p-1 rounded hover:bg-red-500/10 text-app-text-muted hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>

                <div className="text-[10px] text-app-text-muted truncate pl-4">{wh.url}</div>

                {wh.events.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 pl-4">
                    {wh.events.map((evt) => (
                      <span
                        key={evt}
                        className="px-1 py-px rounded bg-black/5 dark:bg-white/5 text-[9px] text-app-text-muted"
                      >
                        {evt}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
