/**
 * client/src/lib/i18n-chat-en.ts - the CHAT SURFACE strings, in English.
 *
 * The mirror of `i18n-chat-it.ts`, which explains why the pair exists at all.
 * It stays a leaf like `i18n-en.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels in the lazily loaded English chunk instead
 * of being pulled back into the eager bundle.
 */
import type { Dict } from './i18n-types';

const CHAT_EN: Dict = {
  'chat.empty.systemPrompt': 'Custom system prompt active',
  'chat.empty.start': 'Start a conversation',
  'chat.empty.starter.describe': 'Describe this project',
  'chat.empty.starter.describeMsg': 'Give me a brief overview of this project: what it does, the tech stack, and the main files.',
  'chat.empty.starter.changes': 'Recent changes',
  'chat.empty.starter.changesMsg': 'Show me the recent git changes in this project and summarize what was modified.',
  'chat.empty.starter.issues': 'Find issues',
  'chat.empty.starter.issuesMsg': 'Review this project for potential bugs, code smells, or improvements.',
  'chat.empty.starter.brainstorm': 'Brainstorm ideas',
  'chat.empty.starter.brainstormMsg': 'Help me brainstorm some ideas.',
  'chat.empty.starter.write': 'Write something',
  'chat.empty.starter.writeMsg': 'Help me write ',
  'chat.empty.starter.research': 'Research a topic',
  'chat.empty.starter.researchMsg': 'Research ',
  'chat.empty.hint.commands': 'commands',
  'chat.empty.hint.slash': 'slash commands',
  'chat.empty.hint.mention': 'mention file',
  'chat.empty.hint.shortcuts': 'all shortcuts',

  'chat.composer.addMenu': 'Attach, tools and commands',
  'chat.composer.addMenuAria': 'Tools & commands',
  'chat.composer.attachFile': 'Attach file',
  'chat.composer.export': 'Export conversation',
  'chat.composer.inputAria': 'Message input for {name}',
  'chat.composer.placeholder': 'Message...',
  'chat.composer.placeholderProject': 'Message... (@ to mention files)',
  'chat.composer.placeholderReply': 'Reply...',
  'chat.composer.hint': 'Press Enter to send, Shift+Enter for new line. Type / for commands.',

  'chat.call.start': 'Voice call',
  'chat.call.end': 'End call',
  'chat.call.active': 'Voice call active',
  'chat.call.listening': 'Listening... speak now',
  'chat.call.processing': 'Processing your message...',
  'chat.call.speaking': 'Speaking response...',
  'chat.call.endButton': 'End call',

  'chat.tts.stop': 'Stop speaking',
  'chat.tts.autoOn': 'Auto-TTS (ON)',
  'chat.tts.auto': 'Auto-TTS',

  'chat.recording.label': 'Recording',
  'chat.recording.stop': 'Stop',
  'chat.recording.startVoice': 'Record voice',
  'chat.recording.stopVoice': 'Stop recording',

  'chat.attachment.pastedImage': 'Pasted image',
  'chat.attachment.tooLarge': 'Attachment too large to keep across a reload: send it now, or it will be lost if you refresh.',

  'chat.edit.editing': 'Editing message',
  'chat.edit.cancel': 'Cancel edit',
  'chat.reply.toYourself': 'Replying to yourself',
  'chat.reply.toAssistant': 'Replying to assistant',

  'chat.send.stopStreaming': 'Stop streaming',
  'chat.send.queueTitle': 'Queue message (Enter)',
  'chat.send.sendTitle': 'Send (Enter)',
  'chat.send.queue': 'Queue message',
  'chat.send.send': 'Send message',
  'chat.fastMode.toggle': 'Toggle fast mode',
  'chat.contextInspector.toggle': 'Toggle context inspector',

  'chat.message.edit': 'Edit',
  'chat.message.editAria': 'Edit message',
  'chat.message.reply': 'Reply',
  'chat.message.copy': 'Copy',
  'chat.message.copyAria': 'Copy message',
  'chat.message.pin': 'Pin',
  'chat.message.pinAria': 'Pin message',
  'chat.message.remember': 'Remember this',
  'chat.message.rememberAria': 'Save to memory',
  'chat.message.regenerate': 'Regenerate',
  'chat.message.regenerateAria': 'Regenerate response',
  'chat.message.delete': 'Delete',
  'chat.message.deleteArmed': 'Click again to delete',
  'chat.message.deleteAria': 'Delete message',
  'chat.message.deleteConfirmAria': 'Confirm delete',
  'chat.message.deleteQuestion': 'Delete?',
  'chat.branch.previous': 'Previous branch',
  'chat.branch.next': 'Next branch',

  'chat.picker.title': 'Provider & model',
  'chat.picker.search': 'Search provider or model',
  'chat.picker.clearSearch': 'Clear search',
  'chat.picker.refresh': 'Refresh provider status',
  'chat.picker.loadFailed': "Couldn't load providers.",
  'chat.picker.retry': 'Retry',
  'chat.picker.noneReady': 'No providers ready.',
  'chat.picker.openSettings': 'Open Settings',
  'chat.picker.noMatches': 'No matches.',
  'chat.picker.resetDefault': 'Reset to default',
  'chat.picker.defaultIs': 'Default: {name}',
  'chat.picker.noneConfigured': 'No provider configured',

  'chat.mention.header': 'Files',
  'chat.mention.loading': 'Loading files...',
  'chat.mention.empty': 'No files found',

  'chat.command.readingFile': 'Reading the file…',
  'chat.command.openingBrowser': 'Opening browser → {url}',
  'chat.compaction.title': 'Compacted context',
  'chat.config.reasoningEffort': 'Reasoning effort',

  'chat.tool.subAgentStarting': 'Sub-agent starting…',
  'chat.tool.noActivity': 'No activity captured.',
  'chat.tool.activityOne': 'Activity · 1 step',
  'chat.tool.activityMany': 'Activity · {n} steps',
  'chat.tool.finalResult': 'Final result',
  'chat.tool.skillInstructions': 'Loaded instructions',
  'chat.tool.noSessionContext': 'The agent is asking for input but this view has no session context. Reload to answer.',
};

export default CHAT_EN;
