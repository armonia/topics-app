/**
 * Every gate a completion banner has to pass before it interrupts anyone.
 *
 * @covers MUTE-01
 */
import { describe, expect, it } from 'bun:test';
import { decideMessageBanner, MESSAGE_BANNER_COOLDOWN_MS, type MessageBannerInput } from './messageBanner';

// Il caso che DEVE bannerizzare. Ogni test qui sotto ne cambia un campo solo:
// così ciò che il test misura è il gate, non la somma dei gate.
function passing(over: Partial<MessageBannerInput> = {}): MessageBannerInput {
  return {
    topicId: 't1',
    role: 'assistant',
    visibilityState: 'hidden',
    notificationsEnabled: true,
    isOwnStream: false,
    body: 'ha finito di rifattorizzare il parser',
    topicName: 'Parser',
    muted: false,
    agentWorking: false,
    lastFiredAt: undefined,
    now: 1_000_000,
    ...over,
  };
}

describe('decideMessageBanner — il caso buono', () => {
  it('bannerizza un messaggio dell assistente a finestra nascosta', () => {
    const d = decideMessageBanner(passing());
    expect(d).not.toBeNull();
    expect(d!.title).toBe('Parser');
    expect(d!.body).toBe('ha finito di rifattorizzare il parser');
  });

  it('il tag è per topic (due messaggi si sostituiscono, non si impilano)', () => {
    expect(decideMessageBanner(passing())!.tag).toBe('topic-t1');
  });

  it('la chiave di cooldown NON è il topicId nudo — quella è del percorso fasi', () => {
    // Condividerla mangerebbe il banner di review, che nella consegna di sistema
    // arriva DOPO la fine turno. Vedi lib/notify/dispatchedTopic.ts.
    const key = decideMessageBanner(passing())!.cooldownKey;
    expect(key).toBe('msg:t1');
    expect(key).not.toBe('t1');
  });
});

describe('decideMessageBanner — i gate che il vecchio percorso saltava', () => {
  it('tace con le notifiche spente (interruttore generale)', () => {
    expect(decideMessageBanner(passing({ notificationsEnabled: false }))).toBeNull();
  });

  it('tace su un topic silenziato (mute per topic o per progetto)', () => {
    expect(decideMessageBanner(passing({ muted: true }))).toBeNull();
  });
});

describe('decideMessageBanner — i gate che il vecchio percorso aveva IMPLICITI', () => {
  // Stavano nel `return` di un `if` precedente dello stesso handler WS, non in
  // una condizione del banner: un riordino li avrebbe persi in silenzio.
  it('tace se è questa finestra a streammare la sessione', () => {
    expect(decideMessageBanner(passing({ isOwnStream: true }))).toBeNull();
  });

  it('tace su un corpo vuoto', () => {
    expect(decideMessageBanner(passing({ body: '' }))).toBeNull();
  });
});

describe('decideMessageBanner — i gate che aveva già', () => {
  it('tace su un messaggio dell utente', () => {
    expect(decideMessageBanner(passing({ role: 'user' }))).toBeNull();
  });

  it('tace a finestra visibile', () => {
    expect(decideMessageBanner(passing({ visibilityState: 'visible' }))).toBeNull();
  });

  it('tace su un topic sconosciuto a questa finestra (niente titolo)', () => {
    expect(decideMessageBanner(passing({ topicName: undefined }))).toBeNull();
    expect(decideMessageBanner(passing({ topicName: null }))).toBeNull();
    expect(decideMessageBanner(passing({ topicName: '' }))).toBeNull();
  });

  it('tace mentre un agente di board lavora il topic', () => {
    expect(decideMessageBanner(passing({ agentWorking: true }))).toBeNull();
  });
});

describe('decideMessageBanner — cooldown', () => {
  it('tace dentro i 10s dall ultimo banner dello stesso topic', () => {
    const now = 1_000_000;
    expect(decideMessageBanner(passing({ now, lastFiredAt: now - 1 }))).toBeNull();
    expect(
      decideMessageBanner(passing({ now, lastFiredAt: now - (MESSAGE_BANNER_COOLDOWN_MS - 1) })),
    ).toBeNull();
  });

  it('torna a parlare al decimo secondo esatto', () => {
    const now = 1_000_000;
    expect(
      decideMessageBanner(passing({ now, lastFiredAt: now - MESSAGE_BANNER_COOLDOWN_MS })),
    ).not.toBeNull();
  });

  it('un topic mai bannerizzato non è in cooldown', () => {
    expect(decideMessageBanner(passing({ lastFiredAt: undefined }))).not.toBeNull();
  });
});
