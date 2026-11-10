/** Settings · Appearance (`d02`): theme, density and motion. Everyone chooses their own, so no permission is needed. */
import type { ScreenCtx } from '../../kit';
import type { Theme } from '../../store/state';
import { settingsFrame } from '../settings-frame';
import { Block, SettingRow } from '../../../../ui/settings/Block';
import { ChoiceCard, ChoiceGroup, DensityThumb, ThemeThumb } from '../../../../ui/settings/Appearance';
import { Toggle } from '../../../../ui/primitives/Field';

type Mode = 'light' | 'dark' | 'system';
type Density = 'compact' | 'comfortable' | 'spacious';

const MODES: Mode[] = ['light', 'dark', 'system'];
const DENSITIES: Density[] = ['compact', 'comfortable', 'spacious'];

/** The theme the system asks for, read when a choice is made (this layer has no effect hooks to follow it live). */
function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppearancePage({ ctx }: { ctx: ScreenCtx }) {
  const a = ctx.copy.settings.appearance;
  const [followSystem, setFollowSystem] = ctx.ui<boolean>('aspetto.system', false);
  const [density, setDensity] = ctx.ui<Density>('aspetto.density', 'comfortable');
  const [reduceMotion, setReduceMotion] = ctx.ui<boolean>('aspetto.motion', false);

  const mode: Mode = followSystem ? 'system' : ctx.state.theme;

  const chooseMode = (next: Mode) => {
    setFollowSystem(next === 'system');
    ctx.dispatch({ type: 'theme', theme: next === 'system' ? systemTheme() : next });
    ctx.toast({ tone: 'ok', title: a.changed(a.theme.options[next].label) });
  };

  const chooseDensity = (next: Density) => {
    setDensity(next);
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-density', next);
    ctx.toast({ tone: 'ok', title: a.changed(a.density.options[next]) });
  };

  const toggleMotion = (on: boolean) => {
    setReduceMotion(on);
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('reduce-motion', on);
    ctx.toast({ tone: 'ok', title: a.changed(`${a.motion.label}: ${on ? ctx.copy.settings.common.on : ctx.copy.settings.common.off}`) });
  };

  return settingsFrame(ctx, 'aspetto', {
    children: (
      <div className="flex flex-col gap-4">
        <p className="text-prose leading-5 text-app-text-secondary">{a.intro}</p>
        <Block title={a.theme.title}>
          <ChoiceGroup ariaLabel={a.theme.title}>
            {MODES.map((m) => (
              <ChoiceCard key={m} label={a.theme.options[m].label} hint={a.theme.options[m].hint} checked={mode === m} onSelect={() => chooseMode(m)}>
                <ThemeThumb mode={m} />
              </ChoiceCard>
            ))}
          </ChoiceGroup>
        </Block>
        <Block title={a.density.title} description={a.density.hint}>
          <ChoiceGroup ariaLabel={a.density.title}>
            {DENSITIES.map((d) => (
              <ChoiceCard key={d} label={a.density.options[d]} checked={density === d} onSelect={() => chooseDensity(d)}>
                <DensityThumb rows={a.preview.rows} density={d} />
              </ChoiceCard>
            ))}
          </ChoiceGroup>
        </Block>
        <Block>
          <SettingRow label={a.motion.label} description={a.motion.description} control={<Toggle checked={reduceMotion} onChange={toggleMotion} title={a.motion.label} />} />
        </Block>
      </div>
    ),
  });
}
