import { useEffect, useState } from 'react';
import { Folder, FolderPlus, Music, Globe, Briefcase, Code2, Cpu, Leaf } from 'lucide-react';
import { useT } from '../../hooks/useT';

/**
 * PROGETTI DELL'ORGANIZZAZIONE: cosa c'e' gia' e cosa potrebbe esserci.
 *
 * Mostra i progetti gia' associati all'org di questa installazione, poi
 * propone una lista curata di spazi di lavoro utili per un'org come Armonia.
 * Non crea niente da sola: la proposta e' una guida, non un wizard.
 */

interface Project {
  id: string;
  name: string;
  path: string;
  incognito?: boolean;
}

/**
 * Una proposta porta la CHIAVE della sua descrizione, non la descrizione.
 * Il testo lo sceglie `useT()` al momento del disegno: scritto qui sarebbe
 * italiano fisso, e la riga che spiega a cosa serve uno spazio e' l'unica cosa
 * che di una proposta si legge davvero.
 */
interface Proposta {
  nome: string;
  blurbKey: string;
  icon: typeof Folder;
  suggerito?: boolean;
}

const PROPOSTE: Proposta[] = [
  {
    nome: 'danceroom',
    blurbKey: 'settings.org.projects.blurb.danceroom',
    icon: Music,
    suggerito: true,
  },
  {
    nome: 'topics-app',
    blurbKey: 'settings.org.projects.blurb.topicsApp',
    icon: Cpu,
    suggerito: true,
  },
  {
    nome: 'finance',
    blurbKey: 'settings.org.projects.blurb.finance',
    icon: Briefcase,
  },
  {
    nome: 'marketing',
    blurbKey: 'settings.org.projects.blurb.marketing',
    icon: Globe,
  },
  {
    nome: 'dev',
    blurbKey: 'settings.org.projects.blurb.dev',
    icon: Code2,
  },
  {
    nome: 'ops',
    blurbKey: 'settings.org.projects.blurb.ops',
    icon: Leaf,
  },
];

export function OrgProjectsSection() {
  const t = useT();
  const [progetti, setProgetti] = useState<Project[]>([]);
  const [caricamento, setCaricamento] = useState(true);

  useEffect(() => {
    let vivo = true;
    fetch('/api/projects', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { projects?: Project[] } | null) => {
        if (vivo && b?.projects) setProgetti(b.projects.filter((p) => !p.incognito));
      })
      .catch(() => {})
      .finally(() => { if (vivo) setCaricamento(false); });
    return () => { vivo = false; };
  }, []);

  const namesProjects = new Set(progetti.map((p) => p.name.toLowerCase()));

  return (
    <div>
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        {t('settings.org.projects.title')}
      </h3>

      {/* Progetti gia' presenti */}
      {!caricamento && progetti.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-lg border border-app-border">
          {progetti.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 px-3 py-2 text-[12px] ${i < progetti.length - 1 ? 'border-b border-app-border' : ''}`}
            >
              <Folder size={13} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-app-text">{p.name}</span>
              <span className="flex-shrink-0 text-[10px] text-app-text-muted truncate max-w-[120px]" title={p.path}>
                {p.path.split('/').slice(-2).join('/')}
              </span>
            </div>
          ))}
        </div>
      )}
      {!caricamento && progetti.length === 0 && (
        <p className="mb-4 text-[12px] text-app-text-muted">
          {t('settings.org.projects.empty')}
        </p>
      )}

      {/* Proposte */}
      <h4 className="mb-2 text-[11px] font-medium text-app-text-muted">
        {t('settings.org.projects.suggestedTitle')}
      </h4>
      <div className="overflow-hidden rounded-lg border border-app-border">
        {PROPOSTE.map((proposta, i) => {
          const Icon = proposta.icon;
          const presente = namesProjects.has(proposta.nome.toLowerCase());
          return (
            <div
              key={proposta.nome}
              className={`flex items-center gap-2.5 px-3 py-2 ${i < PROPOSTE.length - 1 ? 'border-b border-app-border' : ''} ${presente ? 'opacity-50' : ''}`}
            >
              <Icon size={13} className={`flex-shrink-0 ${proposta.suggerito ? 'text-indigo-400' : 'text-app-text-tertiary'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-app-text">{proposta.nome}</span>
                  {proposta.suggerito && !presente && (
                    <span className="rounded bg-indigo-500/15 px-1 py-0.5 text-[9px] font-medium text-indigo-400">
                      {t('settings.org.projects.suggestedBadge')}
                    </span>
                  )}
                  {presente && (
                    <span className="text-[10px] text-app-text-muted">{t('settings.org.projects.alreadyThere')}</span>
                  )}
                </div>
                <p className="text-[11px] text-app-text-muted">{t(proposta.blurbKey)}</p>
              </div>
              {!presente && (
                <FolderPlus size={12} className="flex-shrink-0 text-app-text-tertiary opacity-50" />
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-app-text-muted">
        {t('settings.org.projects.hint')}
      </p>
    </div>
  );
}
