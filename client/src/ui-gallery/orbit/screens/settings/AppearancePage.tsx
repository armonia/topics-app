/**
 * Preferences · Appearance: theme, density, language and motion, the same choices and
 * words as the other edition. Everyone chooses their own, so no permission
 * is needed; the container applies density and motion from these keys.
 */
import type { Theme } from '../../../app/store/state';
import type { ScreenCtx } from '../../../app/kit';
import { Select, Toggle } from '../../../../ui/primitives/Field';
import { ChoiceCard, ChoiceGroup, DensityThumb, ThemeThumb } from '../../../../ui/settings/Appearance';
import { Block, SettingRow } from '../../../../ui/settings/Block';
import { SettingsFrame } from './frame';

type Mode = 'light' | 'dark' | 'system';
type Density = 'compact' | 'comfortable' | 'spacious';
type Language = 'it' | 'en';

const MODES: Mode[] = ['light', 'dark', 'system'];
const DENSITIES: Density[] = ['compact', 'comfortable', 'spacious'];

/** The theme the system asks for, read when the choice is made. */
function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppearancePage({ ctx }: { ctx: ScreenCtx }) {
  const a = ctx.copy.settings.appearance;
  const common = ctx.copy.orbitAdmin.settings.common;
  const language = ctx.copy.orbitAdmin.settings.language;
  /* The three choices carry the same words as the menu of the person. */
  const u = ctx.copy.orbitShell.user;
  const modeLabel: Record<Mode, string> = { light: u.themeLight, dark: u.themeDark, system: u.themeSystem };
  const [followSystem, setFollowSystem] = ctx.ui<boolean>('aspetto.system', false);
  const [density, setDensity] = ctx.ui<Density>('aspetto.density', 'comfortable');
  const [reduceMotion, setReduceMotion] = ctx.ui<boolean>('aspetto.motion', false);
  /* The container reads `language` of this slice to choose the words of the whole interface. */
  const [languageSlice, setLanguageSlice] = ctx.slice<{ language: Language }>('settings.general', { language: 'it' });
  const mode: Mode = followSystem ? 'system' : ctx.state.theme;

  const chooseMode = (next: Mode) => {
    setFollowSystem(next === 'system');
    ctx.dispatch({ type: 'theme', theme: next === 'system' ? systemTheme() : next });
    ctx.log(common.changedTo(a.theme.title, modeLabel[next]), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: a.changed(modeLabel[next]) });
  };

  const chooseDensity = (next: Density) => {
    setDensity(next);
    ctx.log(common.changedTo(a.density.title, a.density.options[next]), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: a.changed(a.density.options[next]) });
  };

  const toggleMotion = (on: boolean) => {
    setReduceMotion(on);
    const shown = on ? common.on : common.off;
    ctx.log(common.changedTo(a.motion.label, shown), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: a.changed(`${a.motion.label}: ${shown}`) });
  };

  const chooseLanguage = (next: Language) => {
    setLanguageSlice((prev) => ({ ...prev, language: next }));
    ctx.log(common.changedTo(language.label, language.options[next]), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: common.saved(language.label) });
  };

  return (
    <SettingsFrame ctx={ctx} section="aspetto">
      <div className="flex flex-col gap-4">
        <Block title={a.theme.title}>
          <ChoiceGroup ariaLabel={a.theme.title}>
            {MODES.map((m) => (
              <ChoiceCard key={m} label={modeLabel[m]} checked={mode === m} onSelect={() => chooseMode(m)}>
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
          <SettingRow
            label={language.label}
            description={language.note}
            control={
              <Select
                value={languageSlice.language ?? 'it'}
                options={[{ value: 'it', label: language.options.it }, { value: 'en', label: language.options.en }]}
                onChange={(v) => chooseLanguage(v as Language)}
                title={language.label}
                className="w-44"
              />
            }
          />
          <SettingRow label={a.motion.label} description={a.motion.description} control={<Toggle checked={reduceMotion} onChange={toggleMotion} title={a.motion.label} />} />
        </Block>
      </div>
    </SettingsFrame>
  );
}
