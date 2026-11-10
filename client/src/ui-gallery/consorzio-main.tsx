/**
 * The Consorzio edition of the preview (`consorzio.html`): the same app as
 * `sarim.html`, with the Consorzio di Bonifica Integrale Comprensorio Sarno as
 * the only organization. `?theme=dark` and `?lang=en` work as there; the state
 * is kept apart from the other previews.
 *
 * The world is chosen first and the app, the copy and the edition are imported
 * after it: they compute constants from the world while they load, so a static
 * import would read the wrong one.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import './app/app.css';
import { NOCERA_WORLD } from '../ui/fixtures/nocera-org/world';
import { setWorld } from './sarim/world';

setWorld(NOCERA_WORLD);

async function start() {
  const [{ UI_COPY_IT }, { UI_COPY_EN }, { App }, { CONSORZIO_EDITION }] = await Promise.all([
    import('../ui/copy/i18n-ui-it'),
    import('../ui/copy/i18n-ui-en'),
    import('./app/App'),
    import('./consorzio-edition'),
  ]);

  const params = new URLSearchParams(location.search);
  document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
  const copy = params.get('lang') === 'en' ? UI_COPY_EN : UI_COPY_IT;
  const copies = params.has('lang') ? undefined : { it: UI_COPY_IT, en: UI_COPY_EN };

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App copy={copy} copies={copies} edition={CONSORZIO_EDITION} />
    </StrictMode>,
  );
}

void start();
