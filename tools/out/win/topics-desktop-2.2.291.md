# Topics 2.2.291 on Windows: the gate is red, and not where the card looked

`./tools/win-desktop-check.sh <host> tauri-v2.2.291` exits **1**. The bar of the
card (5/5, exit 0) is not met on 2.2.291 either. What follows says which checks
answered what, and which of them measured the app rather than the desktop it was
running on.

Release `tauri-v2.2.291` (published 01:31 UTC, the first one carrying 71466b7ee),
asset `Topics_2.2.291_x64-setup.exe`, digest
`sha256:8065576991d987c4aad28778515f4146ec63d82c1bdc7938b954e1b5bae7fd45`
matching the release, `NotSigned`. Installed over 2.2.290, four arms, same
machine as the 2.2.281 and 2.2.287 reports.

| check | verdict | reading |
|---|---|---|
| a | boot | **PASS** | client bundle served at 18.8-19.7s, window painted at 4.7-5.1s with ink 100%, budget 45s. Same shape as 2.2.287 (18.9-19.6s / 4.6-4.8s). |
| b | chrome | **FAIL** | 4 command cells (want 3) inside 0..69 CSS px (want 12..66), wordmark ink at 60 CSS px (want 80 +/-4), baseline offset 6.5 CSS px (want <=4). On 2.2.287 this was green with 3 cells and ink at 80. |
| c | shortcuts | NOT MEASURED | the gate stops at the first FAIL and (b) is before (c). |
| d | minimise and restore | PASS by falsification | the `-NoRemedy` arm brings the defect straight back (0/3 repainted), so the remedy that ships is still doing work. The green arm never got there: it stops at (b). |
| e | browser pane | NOT MEASURABLE | "browser pane did not open: 0% of the window changed". Two reasons, neither of them the pane: see below. |

## (b) is the window commands, and the gate is measuring the old ones

The strip now has **four** command cells where the check wants three, and the
wordmark starts 20 CSS px earlier. That is the shape of the window-commands
change that landed just before this release, not a regression that appeared on
its own: the expectation written into `win-desktop-check.ps1` (`6 + 66 + 8` and
three cells) describes the strip as it was on 2.2.287. Until that expectation is
rewritten against the current design, the gate stops here and every check after
it stays unmeasured. It is not this card's fix, and it is what keeps 5/5 out of
reach.

## (e) did not measure the pane, twice

**First run: another window held the keyboard.** The gate printed
`keyboard after the closes: Windows.UI.Core.CoreWindow of SearchHost`, and the
probe that followed printed `!! the window refused the foreground`. The Windows
Search flyout was open on the desktop at `1291,502 858x890`, on top of the app
window and holding the foreground: every key the gate sent went into the search
box, and the click the probe aimed at the pane landed on the flyout. Everything
that run wrote down is a reading of Windows Search, not of Topics. Closing the
flyout (`Stop-Process -Name SearchHost`, it comes back by itself) is what made
the machine measurable again.

**Second run: there was no topic to open a pane in.** With the foreground back,
the app sits on `Welcome to Topics / Select a topic to start`: the gate's own
`Ctrl+W x3` had closed the last topic, and from an empty workspace the frozen
mnemonic `Ctrl+N` then `b` has nothing to open. The check reads 0% and calls it a
pane that did not open, which is true and says nothing about the pane.

On top of that, the mnemonic is a CLIENT shortcut, and client shortcuts do not
reach the web content on this build (card cd040754). So (e) cannot answer, by
construction, while that card is open.

## What the pane actually does on 2.2.291

Driven the way a person drives it (mouse to open the pane, keyboard to type the
address), the pane **works**: an address typed the instant the pane appears
loads, and an HTTP witness on a port the app does not use logs the request with
`UA=... Edg/152.0.0.0`, which is the native WebView2 of the pane and nothing
else. The detail, the three arms and the captures are in
`browser-pane-2.2.291.md`. The fix 71466b7ee does on the product what it claimed
on the commit; the gate is red for two reasons that are not it.

## Second pass, same release, after the readings were rewritten

The two stale readings above were fixed (`a3f9dd94d`) and the whole battery run
again against the same installer, same machine, 10:03 local.

| arm | expected | got | reading |
|---|---|---|---|
| full (a b c d) | 0 | **0** | b: 3 cells inside 16..69 (want 12..74), wordmark at 88 (want 88), baseline 2. c1: Ctrl+K opens 52%, back to 0% on one Escape. c2: Ctrl+N menu 91.8%. d: 3/3 repainted. |
| wrongkey (falsification) | 1 | 1 | an unbound combination opens 0%, as it must. |
| noremedy (falsification) | 1 | 1 | without the rebuild remedy, 0/3 repainted, ink 1.3%. The remedy that ships is doing the work. |
| browser (e) | 0 | **1** | the pane opens and takes the keyboard: Ctrl+K read 53.4% WITH the pane focused. The typed address does not arrive: navigation moved 1.9% (want >5%). |

So (b), (c) and (d) are green on 2.2.291, and the strip was never wrong: the
commands took 4 px of air on purpose and the check had yesterday's numbers.

(e) is the one real defect left, and it is the Ctrl+L of the report next door,
now with a mechanism: a native pane holds the OS keyboard, and asking for the
address bar only opened the tab's inline editor without asking for the keyboard
back. The tab strip did ask, on pointer-down, which is why the mouse worked.
Fixed in `b56b22e7f` by moving the ask into `focusAddress`, the one door both
gestures pass through; the reading that closes it has to come from the release
that carries it, not from this one.

## Files

`01-first-launch.png`, `02-chrome-strip-four-cells.png` (the four cells of (b)),
`05-pane-never-opened.png` (what (e) captured), `run-gate.txt` (the whole run,
four arms).
