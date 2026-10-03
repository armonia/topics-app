import { useState, useEffect, useRef, Suspense } from 'react';
import { SessionActivityBar } from '../Shared/SessionActivity';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, PanelTab, CompactionMarker } from '../../types';
import { sendFocusTopic } from '../../lib/focusMessaging';
import { ChatPane } from '../Chat/ChatPane';
import { TopicBrowserReopen } from '../Browser/TopicBrowserReopen';
import { TopicBrowserWindow, useTopicBrowserPresence, useTopicWindowDoor, hasTopicBrowserWindow, DEFAULT_EXPANDED_WIDTH, useTopicBrowserInset } from '../Browser/topicBrowserWindowLazy';
import type { SendMessageOptions } from '@/hooks/useChat';

/**
 * The body of a chat pane: the conversation, the topic's browser window, and
 * on the phone the activity strip. The header it used to draw (name, sidebar
 * toggle, settings, command menu, pop-out, close) is gone: every caller passed
 * `bodyOnly`, so none of it ever rendered. The tab strip and its menus own
 * those gestures.
 */
interface ChatPanelProps {
  topic: Topic; isFocused: boolean; onFocus: () => void;
  getSessionMessages: (sk: string) => ChatMessage[]; getCompactionMarkers?: (sk: string) => CompactionMarker[]; isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean; wasSessionStopped: (sk: string) => boolean; sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  /**
   * Abort the in-flight assistant turn for `sessionKey`. Returns true iff
   * the chat was a brand-new throwaway (one-user-message thread) — the
   * caller may then discard the topic. Threaded through to `ChatInput` so
   * the unified composer button can offer Stop without going through the
   * sidebar `TopicItem` route. See `composerAction.ts`.
   */
  stopSession: (sk: string) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>; chatError: Record<string, string | null>;
  sendWS: (msg: WSMessage) => void; onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  initialTab?: PanelTab;
  onInitialTabConsumed?: () => void;
}

export function ChatPanel({
  topic, isFocused, onFocus,
  getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, wasSessionStopped, stopSession, sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory,
  chatError, sendWS, onWSMessage, onUpdateTopic, initialTab, onInitialTabConsumed,
}: ChatPanelProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => { setIsMobile(window.innerWidth < 768); }; window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  // Consume initial tab override
  useEffect(() => {
    if (initialTab && initialTab !== 'browser') {
      onInitialTabConsumed?.();
    }
  }, [initialTab, onInitialTabConsumed]);
  const isDraft = topic.id.startsWith('draft:');

  // Solo il ping di focus: l'azzeramento locale e la POST di lettura li fa
  // `sendWS`, e solo quando c'è davvero qualcosa di non letto.
  useEffect(() => { if (isFocused && !isDraft) { sendFocusTopic(sendWS, topic.id); } }, [isFocused, isDraft, topic.id, sendWS]);

  // The topic's browser window. Under 768 px it does not exist at all: a phone
  // has no room to give, and a window that covers the chat is not a window.
  // Expanded, the chat CEDES its width instead of being covered; minimized it
  // cedes nothing, which is the difference the scenarios check.
  const chatAreaRef = useRef<HTMLDivElement>(null);
  // ONE expression, two consumers: how much room to cede, and whether the
  // openings of this conversation land in the window instead of the layout.
  // Two copies of this rule is how one of them ends up wrong.
  const browserWindowTopicId = isDraft || isMobile ? '' : topic.id;
  const browserWindow = useTopicBrowserPresence(browserWindowTopicId);
  useTopicWindowDoor(browserWindowTopicId);
  const requestedBrowserInset = browserWindow.mode === 'exp' ? (browserWindow.expandedWidth ?? DEFAULT_EXPANDED_WIDTH) : 0;
  // Measured, not stated in CSS: below a usable area the window falls back to
  // floating and this has to be zero, which a stylesheet cannot decide.
  const browserInset = useTopicBrowserInset(chatAreaRef, requestedBrowserInset);

  return (
    <>
      <div ref={chatAreaRef} data-testid="chat-panel" data-chat-topic-id={topic.id} role="region" aria-label={`${topic.name} panel`} style={browserInset ? { paddingRight: `${browserInset}px` } : undefined} className="relative flex flex-col flex-1 min-h-0 bg-surface chrome-passthrough-y transition-colors duration-instant" onClick={onFocus}>
        {hasTopicBrowserWindow(browserWindow) && (
          <Suspense fallback={null}>
            <TopicBrowserWindow topicId={topic.id} areaRef={chatAreaRef} projectPath={topic.projectPath ?? undefined} />
          </Suspense>
        )}
        {hasTopicBrowserWindow(browserWindow) && browserWindow.mode === 'hidden' && (
          <TopicBrowserReopen topicId={topic.id} />
        )}
        {/* Mobile "what is this session doing" strip — front-and-centre on the
            small screen (the sidebar list carries it on desktop). Self-hides when
            the session is idle. */}
        {isMobile && <SessionActivityBar subjectId={topic.id} />}

        {/* Main Content with optional Context Inspector slide-out */}
        {/* The three nested wrappers between the cell and the transcript keep
            the horizontal containment and let the vertical through
            (`chrome-passthrough-y`): the chat rises under the chrome bar by a
            negative margin, and a single `overflow-hidden` anywhere on this
            chain cuts those pixels off. See index.css. */}
        <div className="flex-1 flex min-h-0 chrome-passthrough-y relative">
          <div className="flex-1 flex flex-col min-w-0 chrome-passthrough-y">
            <div className="flex-1 min-h-0 chrome-passthrough-y flex flex-col">
              <ChatPane
                topic={topic}
                isFocused={isFocused}
                getSessionMessages={getSessionMessages}
                getCompactionMarkers={getCompactionMarkers}
                isSessionLoading={isSessionLoading}
                isSessionStreaming={isSessionStreaming}
                wasSessionStopped={wasSessionStopped}
                stopSession={stopSession}
                sendMessage={sendMessage}
                editMessage={editMessage}
                regenerateMessage={regenerateMessage}
                deleteMessage={deleteMessage}
                switchBranch={switchBranch}
                loadHistory={loadHistory}
                chatError={chatError}
                sendWS={sendWS}
                onWSMessage={onWSMessage}
                onUpdateTopic={onUpdateTopic}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
