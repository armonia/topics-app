/**
 * THE DIVERGENCE HAS TO BE VISIBLE WITHOUT OPENING ANYTHING.
 *
 * The state measured on the machine that builds Topics: installed shell
 * 2.2.179, repo (served by `/api/version`) 2.2.214. The chip showed 2.2.214 and
 * nothing else, so the updater toast announcing a new version read as a bug in
 * the toast. The toast was right. The number was the incomplete fact.
 *
 * These tests MOUNT the chip, because "the chip stopped saying it" is a
 * one-line change and a source-reading assertion would not catch a badge
 * rendered under a condition that is never true. `SidebarStatusBar` itself does
 * not mount here (perf metrics, system status, shell bridge, a dozen stores),
 * which is exactly why the chip is its own component.
 *
 * (jsdom/happy-dom are not dependencies of this project, as `ThreadRuns.test.tsx`
 * says: the mounting is `renderToStaticMarkup`.)
 *
 * @covers STATUSLINE-03c
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionChip } from './VersionChip';

const noop = () => {};

describe('the version chip on a development machine', () => {
  const html = renderToStaticMarkup(
    <VersionChip
      appVersion="2.2.214"
      shellVersion="2.2.179"
      devInstall
      desktop
      onOpen={noop}
    />,
  );

  test('it keeps showing the client number, which is the "deploy landed" signal', () => {
    expect(html).toContain('v2.2.214');
  });

  test('and it names the shell version, which is what the updater replaces', () => {
    expect(html).toContain('2.2.179');
  });

  test('the two facts are readable without opening the popover', () => {
    // The badge is a sibling of the button, not a child of the panel: nothing
    // has to be clicked or hovered for the second number to exist on screen.
    expect(html).toContain('data-testid="version-install-badge"');
    expect(html).toContain('dev');
  });
});

describe('the chip stays one number wide when there is nothing to say', () => {
  test('an installed app in agreement carries no badge', () => {
    const html = renderToStaticMarkup(
      <VersionChip appVersion="2.2.214" shellVersion="2.2.214" desktop onOpen={noop} />,
    );
    expect(html).toContain('v2.2.214');
    expect(html).not.toContain('version-install-badge');
  });

  test('in the browser there is no shell, so no divergence is invented', () => {
    const html = renderToStaticMarkup(
      <VersionChip appVersion="2.2.214" shellVersion="2.2.179" desktop={false} onOpen={noop} />,
    );
    expect(html).not.toContain('version-install-badge');
  });

  test('an unreachable shell version is a missing fact, not a divergence', () => {
    const html = renderToStaticMarkup(
      <VersionChip appVersion="2.2.214" shellVersion="" desktop onOpen={noop} />,
    );
    expect(html).not.toContain('version-install-badge');
  });
});

describe('whoever hosts the chip really feeds it both facts', () => {
  // Source level, and on purpose: the host does not mount here, and a chip that
  // can say it while nobody hands it the shell version is a chip that says
  // nothing. This is the wire, checked where the wire is.
  //
  // THE HOST IS THE MENU NOW. It used to be the strip at the foot of the
  // column; the strip is gone and the version is a row of the «Topics» menu, on
  // every screen. Reading the old file would have left two assertions that
  // cannot fail, on a file with no chip in it.
  const HOST = readFileSync(join(import.meta.dir, 'SidebarSystemMenu.tsx'), 'utf8');

  test('the shell version read through the bridge reaches the chip', () => {
    expect(HOST).toContain('shellVersion={versioneGuscio}');
    expect(HOST).toContain('getVersion()');
  });

  test('the development state comes from the server, not from import.meta.env alone', () => {
    // `import.meta.env.DEV` is false in the desktop app, which runs the built
    // bundle: on the machine that builds Topics only `devReload` is true.
    expect(HOST).toContain('devInstall={devInstall}');
    expect(HOST).toContain('devReload');
  });
});

describe('the stale bundle mark is still there', () => {
  test('a bundle older than the repo keeps its dot', () => {
    const html = renderToStaticMarkup(
      <VersionChip
        appVersion="2.2.214"
        drift={{ bundle: '2.2.211', repo: '2.2.214' }}
        desktop
        onOpen={noop}
      />,
    );
    expect(html).toContain('data-testid="version-drift-dot"');
  });
});
