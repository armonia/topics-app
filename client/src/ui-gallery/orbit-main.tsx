/**
 * The ORBIT edition of the preview (`orbit.html`): the same app as `app.html`,
 * with ORBIT as the only organization. `?theme=dark` and `?lang=en` work as
 * there; the state is kept apart from the multi-organization preview.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './use-orbit-world';
import '../index.css';
import './app/app.css';
import { UI_COPY_IT } from '../ui/copy/i18n-ui-it';
import { UI_COPY_EN } from '../ui/copy/i18n-ui-en';
import { App } from './app/App';
import { ORBIT_EDITION } from './orbit-edition';

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const copy = params.get('lang') === 'en' ? UI_COPY_EN : UI_COPY_IT;
const copies = params.has('lang') ? undefined : { it: UI_COPY_IT, en: UI_COPY_EN };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App copy={copy} copies={copies} edition={ORBIT_EDITION} />
  </StrictMode>,
);
