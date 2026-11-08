import type { Topic } from '@/types';

/**
 * QUALE sessione riceve una missione.
 *
 * La regola che conta è quella che NON si vede: la missione va a una chat
 * normale di questo progetto — «c'è il progetto che già lo fa fare» — e mai a
 * una sessione d'agente. Un agente di task sta lavorando una card dentro il suo
 * worktree: scrivergli «lavoriamo il backlog» in mezzo al turno vorrebbe dire
 * dirottargli il lavoro e sporcare la consegna di quella card. Perciò le
 * sessioni dispacciate dalla board (`mcpPolicy: 'bridge-only'`) e quelle
 * scollegate (`standalone`, i workspace per-task) sono escluse per costruzione,
 * non per attenzione di chi clicca.
 *
 * L'ordine di preferenza segue lo sguardo: prima la chat che l'umano sta
 * guardando in questa finestra, poi una qualsiasi già aperta accanto alla
 * board, e solo alla fine una chat del progetto che è chiusa (che verrà
 * riaperta accanto alla board). Nessuna delle tre → nessun bersaglio, e chi
 * chiama lo dice invece di inventarsi una sessione.
 */
export interface MissionTargetInput {
  projectPath: string;
  topics: Record<string, Topic>;
  /** Le pane di questa finestra di progetto. */
  panes: { id: string; type: string; topicId?: string }[];
  groups: { id: string; paneIds: string[]; activePaneId?: string }[];
  focusedGroupId: string | null;
}

/** Una chat a cui si può dare una missione: del progetto, viva, non d'agente. */
function eligible(topic: Topic | undefined, projectPath: string): topic is Topic {
  if (!topic) return false;
  if (topic.archived) return false;
  if (topic.projectPath !== projectPath) return false;
  if (topic.standalone) return false;
  if (topic.mcpPolicy === 'bridge-only') return false;
  return true;
}

export function pickMissionSession(input: MissionTargetInput): string | null {
  const { projectPath, topics, panes, groups, focusedGroupId } = input;
  const chatTopicOf = (paneId: string | undefined): string | null => {
    if (!paneId) return null;
    const pane = panes.find((p) => p.id === paneId);
    if (!pane || pane.type !== 'chat' || !pane.topicId) return null;
    return eligible(topics[pane.topicId], projectPath) ? pane.topicId : null;
  };

  // 1) La chat a fuoco: è quella che l'umano ha davanti mentre sceglie.
  const focused = groups.find((g) => g.id === focusedGroupId);
  const fromFocus = chatTopicOf(focused?.activePaneId);
  if (fromFocus) return fromFocus;

  // 2) Una chat già aperta in questa finestra — la sessione è già laterale, la
  //    missione non deve spostare niente sullo schermo.
  for (const g of groups) {
    for (const paneId of g.paneIds) {
      const t = chatTopicOf(paneId);
      if (t) return t;
    }
  }

  // 3) Nessuna aperta: la chat del progetto toccata più di recente. Verrà
  //    riaperta accanto alla board, che è il gesto che «attiva» la sessione
  //    laterale.
  const closed = Object.values(topics)
    .filter((t) => eligible(t, projectPath))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return closed[0]?.id ?? null;
}
