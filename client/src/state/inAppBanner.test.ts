/**
 * Il banner in pagina: quello che si impila e quello che si sostituisce.
 *
 * L'id è il `tag` della push. Due fine-turno dello stesso topic sono UNA cosa da
 * guardare — la stessa regola che il `tag` impone alle notifiche di sistema — e
 * senza questa sostituzione una chat lunga lascerebbe in pagina una colonna di
 * cartelli identici.
  * @covers PRESENCE-11
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { useInAppBannerStore } from './inAppBanner';

beforeEach(() => {
  useInAppBannerStore.setState({ banners: [] });
});

describe('showInAppBanner', () => {
  test('due segnali diversi restano due banner', () => {
    const { showInAppBanner } = useInAppBannerStore.getState();
    showInAppBanner({ id: 'chat-end-a', title: 'A', body: '' });
    showInAppBanner({ id: 'task-review-b', title: 'B', body: '' });
    expect(useInAppBannerStore.getState().banners.map((b) => b.id)).toEqual(['chat-end-a', 'task-review-b']);
  });

  test('lo stesso tag SOSTITUISCE, e va in fondo: è il segnale più recente', () => {
    const { showInAppBanner } = useInAppBannerStore.getState();
    showInAppBanner({ id: 'chat-end-a', title: 'primo', body: '' });
    showInAppBanner({ id: 'task-review-b', title: 'altro', body: '' });
    showInAppBanner({ id: 'chat-end-a', title: 'secondo', body: '' });
    const banners = useInAppBannerStore.getState().banners;
    expect(banners).toHaveLength(2);
    expect(banners[banners.length - 1]).toMatchObject({ id: 'chat-end-a', title: 'secondo' });
  });

  test('senza tag ogni segnale è suo: due push anonime non si mangiano a vicenda', () => {
    const { showInAppBanner } = useInAppBannerStore.getState();
    showInAppBanner({ title: 'uno', body: '' });
    showInAppBanner({ title: 'due', body: '' });
    expect(useInAppBannerStore.getState().banners).toHaveLength(2);
  });

  test('dismiss toglie solo il suo', () => {
    const { showInAppBanner, dismissInAppBanner } = useInAppBannerStore.getState();
    showInAppBanner({ id: 'a', title: 'A', body: '' });
    showInAppBanner({ id: 'b', title: 'B', body: '' });
    dismissInAppBanner('a');
    expect(useInAppBannerStore.getState().banners.map((b) => b.id)).toEqual(['b']);
  });
});
