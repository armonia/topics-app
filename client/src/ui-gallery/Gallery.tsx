/**
 * The gallery page: the screen named by the hash inside a 1440x900 frame, or
 * the list of screens when the hash names none.
 */
import { useEffect, useState } from 'react';
import type { UiCopy } from '../ui/copy/types';
import { SCREENS } from './screens';
import { App } from './app/App';
import { PlacesOfEdition } from './app/Container';
import { NOCERA_EDITION } from './app/edition';

/** Every place of the multi-organization preview. */
const PLACES = PlacesOfEdition(NOCERA_EDITION);

const currentId = () => decodeURIComponent(location.hash.replace(/^#/, ''));

export function Gallery({ copy }: { copy: UiCopy }) {
  const [id, setId] = useState(currentId);
  useEffect(() => {
    const onHash = () => setId(currentId());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* `ui.html#/…` is the connected app too, for links written that way. */
  if (id.startsWith('/')) return <div className="h-screen"><App copy={copy} edition={NOCERA_EDITION} /></div>;
  const screen = SCREENS.find((s) => s.id === id);
  /* A mockup id drawn by a place of the app: the app itself, on that place, fresh. */
  const place = screen ? undefined : PLACES.find((p) => p.id === id);
  if (place) {
    return (
      <div data-gallery={place.id} style={{ width: 1440, height: 900 }} className="overflow-hidden">
        <App copy={copy} embedPath={place.samples[0]} edition={NOCERA_EDITION} />
      </div>
    );
  }
  if (screen) {
    return (
      <div data-screen={screen.id} style={{ width: 1440, height: 900 }} className="overflow-hidden">
        {screen.render(copy)}
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-app-bg p-8 font-sans text-app-text">
      <h1 className="mb-4 text-headline font-semibold">{copy.shell.appName}</h1>
      <a className="mb-4 inline-flex rounded-lg bg-primary px-3 py-2 font-medium text-white hover:bg-primary-hover" href={`app.html${location.search}#/panoramica`}>
        app.html
      </a>
      <ul className="grid max-w-3xl grid-cols-2 gap-2">
        {[...SCREENS, ...PLACES.filter((p) => !SCREENS.some((s) => s.id === p.id)).map((p) => ({ id: p.id, title: p.samples[0] }))].map((s) => (
          <li key={s.id}>
            <a className="flex gap-3 rounded-lg bg-surface px-3 py-2 hover:bg-app-hover" href={`#${s.id}`}>
              <span className="font-mono text-app-text-tertiary">{s.id}</span>
              <span>{s.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

