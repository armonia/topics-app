import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { CreateTopicRequest, TopicTemplate } from '../../types';

const TEMPLATES: TopicTemplate[] = [
  {
    name: 'Code Review',
    icon: '🔍',
    color: '#7c3aed',
    systemPrompt: 'You are an expert code reviewer. Focus on code quality, best practices, potential bugs, performance issues, and security concerns. Provide specific, actionable feedback.',
    description: 'Get expert code review feedback',
  },
  {
    name: 'Brainstorming',
    icon: '💡',
    color: '#eab308',
    systemPrompt: 'You are a creative brainstorming partner. Help generate ideas, explore possibilities, and think outside the box. Build on ideas and suggest creative combinations.',
    description: 'Generate and explore ideas',
  },
  {
    name: 'Debug Helper',
    icon: '🐛',
    color: '#dc2626',
    systemPrompt: 'You are a debugging expert. Help identify root causes, suggest debugging strategies, and provide solutions. Ask clarifying questions when needed to narrow down the issue.',
    description: 'Diagnose and fix issues',
  },
  {
    name: 'Writing',
    icon: '✍️',
    color: '#059669',
    systemPrompt: 'You are a writing assistant. Help with drafting, editing, and improving text. Focus on clarity, tone, and structure. Suggest improvements while maintaining the author\'s voice.',
    description: 'Draft and improve text',
  },
];

interface NewTopicModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: CreateTopicRequest) => Promise<any>;
}

export function NewTopicModal({ isOpen, onClose, onCreate }: NewTopicModalProps) {
  const [name, setName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<TopicTemplate | null>(null);
  const [showTemplates, setShowTemplates] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelectedTemplate(null);
      setShowTemplates(true);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleCreate = async () => {
    const finalName = name.trim() || selectedTemplate?.name || 'New Chat';
    const data: CreateTopicRequest = {
      name: finalName,
      icon: selectedTemplate?.icon || '💬',
      color: selectedTemplate?.color || '#5865f2',
      systemPrompt: selectedTemplate?.systemPrompt,
    };
    const topic = await onCreate(data);
    if (topic) onClose();
  };

  const handleSelectTemplate = (template: TopicTemplate) => {
    setSelectedTemplate(template);
    if (!name.trim()) setName(template.name);
    setShowTemplates(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        className="relative w-full max-w-md mx-4 bg-white dark:bg-[#1e1e1e] rounded-xl shadow-2xl border border-[#e0e0e0] dark:border-[#333] overflow-hidden max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8e8e8] dark:border-[#2a2a2a]">
          <h2 className="text-[15px] font-semibold text-[#1a1a1a] dark:text-[#e5e5e5]">New Topic</h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Topic name */}
          <div>
            <label className="block text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-1.5">
              Topic Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') onClose();
              }}
              placeholder="Enter topic name..."
              className="w-full px-3 py-2 border border-[#e0e0e0] dark:border-[#333] rounded-lg text-[13px] bg-white dark:bg-[#222] text-[#1a1a1a] dark:text-[#e5e5e5] placeholder-[#aaa] dark:placeholder-[#666] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] transition-colors"
            />
          </div>

          {/* Templates */}
          {showTemplates && (
            <div>
              <label className="block text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
                Or start from a template
              </label>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.map(template => (
                  <button
                    key={template.name}
                    onClick={() => handleSelectTemplate(template)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      selectedTemplate?.name === template.name
                        ? 'border-[var(--primary)]/50 bg-[var(--primary)]/10'
                        : 'border-[#e0e0e0] dark:border-[#333] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a]'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">{template.icon}</span>
                      <span className="text-[13px] font-medium text-[#1a1a1a] dark:text-[#e5e5e5]">{template.name}</span>
                    </div>
                    <p className="text-[11px] text-[#888] dark:text-[#666]">{template.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected template info */}
          {selectedTemplate && !showTemplates && (
            <div className="bg-[#f5f5f5] dark:bg-[#222] rounded-lg p-3 border border-[#e0e0e0] dark:border-[#333]">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span>{selectedTemplate.icon}</span>
                  <span className="text-[13px] font-medium text-[#333] dark:text-[#ccc]">
                    {selectedTemplate.name} Template
                  </span>
                </div>
                <button
                  onClick={() => { setSelectedTemplate(null); setShowTemplates(true); }}
                  className="text-[12px] text-[var(--primary)] hover:text-[#0055dd]"
                >
                  Change
                </button>
              </div>
              <p className="text-[11px] text-[#888] dark:text-[#666]">{selectedTemplate.description}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-[#e8e8e8] dark:border-[#2a2a2a]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] text-[#666] dark:text-[#999] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() && !selectedTemplate}
            className="px-4 py-2 text-[13px] bg-[var(--primary)] text-white rounded-lg hover:bg-[#0055dd] disabled:bg-[#ccc] dark:disabled:bg-[#444] disabled:text-[#888] transition-colors"
          >
            Create Topic
          </button>
        </div>
      </div>
    </div>
  );
}
