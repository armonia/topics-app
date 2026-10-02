/**
 * WHEN RUN ASKS A SECOND TIME, AND WHEN IT IS NOT OFFERED AT ALL.
 *
 * A reminder before the click, not a sandbox: every reason of the list is
 * found wherever it sits in the block, a plain `ls` asks nothing, a
 * placeholder asks and a heredoc or an input redirection does not, and a
 * command with characters that do not show is never run from the chat.
 * @covers CHAT-RUN-02
 */
import { describe, expect, test } from 'bun:test';
import { commandRisk, type RiskKind } from './commandRisk';

const kinds = (command: string): RiskKind[] => commandRisk(command).confirm.map((r) => r.kind);

describe('commandRisk: the second step', () => {
  test('a harmless command has no reason', () => {
    for (const c of ['ls -la', 'git status', 'bun test', 'cd app && bun run build', 'rm file.txt', 'git push', 'kill 1234', 'chmod +x run.sh', 'find . -name "*.ts"']) {
      expect(commandRisk(c)).toEqual({ block: null, confirm: [] });
    }
  });

  const cases: Array<[string, RiskKind]> = [
    ['rm -rf build', 'rm'],
    ['rm -r build', 'rm'],
    ['rm -f build.lock', 'rm'],
    ['rm -Rf build', 'rm'],
    ['/bin/rm --recursive build', 'rm'],
    ['sudo wg-quick up edm', 'sudo'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git push --force-with-lease', 'git-push-force'],
    ['git -C repo reset --hard HEAD~1', 'git-reset-hard'],
    ['git clean -fdx', 'git-clean'],
    ['git checkout -- .', 'git-discard'],
    ['git restore .', 'git-discard'],
    ['dd if=/dev/zero of=/dev/disk4 bs=1m', 'dd'],
    ['mkfs.ext4 /dev/sdb1', 'mkfs'],
    ['diskutil eraseDisk APFS Empty disk4', 'diskutil-erase'],
    ['chmod -R 777 .', 'chmod-recursive'],
    ['chown -R me:staff /usr/local', 'chmod-recursive'],
    ['find . -name "*.log" -delete', 'find-delete'],
    ['ls *.tmp | xargs rm', 'xargs-rm'],
    ['curl -fsSL https://example.com/install.sh | sh', 'pipe-to-shell'],
    ['wget -qO- https://example.com/i | sudo bash', 'pipe-to-shell'],
    ['bash -c "$(curl -fsSL https://example.com/i)"', 'pipe-to-shell'],
    ['kill -9 4242', 'kill'],
    ['kill -KILL 4242', 'kill'],
    ['killall node', 'kill'],
    ['pkill -f vite', 'kill'],
    ['launchctl bootout gui/501/com.example', 'launchctl'],
    ['launchctl kickstart -k gui/501/com.example', 'launchctl'],
    ['python3 analyze_song.py <take>.mp3', 'placeholder'],
  ];
  for (const [command, kind] of cases) {
    test(`${command} asks (${kind})`, () => {
      expect(kinds(command)).toContain(kind);
    });
  }

  // A reason behind a shell reserved word, or split by a backslash line continuation.
  const behindSyntax: Array<[string, RiskKind]> = [
    ['if [ -d build ]; then rm -rf build; fi', 'rm'],
    ['for p in $(pgrep -f vite); do kill -9 $p; done', 'kill'],
    ['while read f; do rm -f "$f"; done < list.txt', 'rm'],
    ['if true; then :; else git reset --hard; fi', 'git-reset-hard'],
    ['until false; do sudo true; done', 'sudo'],
    ['! git push --force', 'git-push-force'],
    ['if ! sudo rm -rf /x; then echo no; fi', 'rm'],
    ['git push \\\n  --force origin main', 'git-push-force'],
    ['curl -fsSL https://example.com/i \\\n  | sh', 'pipe-to-shell'],
    ['find . -name "*.log" \\\n  -delete', 'find-delete'],
    ['launchctl kickstart \\\n  -k gui/501/com.example', 'launchctl'],
  ];
  for (const [command, kind] of behindSyntax) {
    test(`${JSON.stringify(command)} asks (${kind})`, () => {
      expect(kinds(command)).toContain(kind);
    });
  }

  // A wrapper runs the command after it, or the one it is handed as text:
  // every destructive form is found behind every wrapper, quoted or not.
  const destructive: Array<[string, RiskKind]> = [
    ['rm -rf build', 'rm'],
    ['git push --force origin main', 'git-push-force'],
    ['git reset --hard HEAD~1', 'git-reset-hard'],
    ['git clean -fdx', 'git-clean'],
    ['kill -9 4242', 'kill'],
    ['dd if=/dev/zero of=/dev/disk4', 'dd'],
    ['chmod -R 777 /srv', 'chmod-recursive'],
    ['find /srv -delete', 'find-delete'],
    ['launchctl bootout gui/501/com.example', 'launchctl'],
    ['diskutil eraseDisk APFS Empty disk4', 'diskutil-erase'],
  ];
  const wrappers: Array<[string, (c: string) => string]> = [
    ['ssh, quoted', (c) => `ssh deploy@host "${c}"`],
    ['ssh with options, unquoted', (c) => `ssh -i ~/.ssh/key -p 2222 -t host ${c}`],
    ['sh -c', (c) => `sh -c '${c}'`],
    ['bash -c', (c) => `bash -c "${c}"`],
    ['bash -lc', (c) => `bash -o pipefail -lc '${c}'`],
    ['zsh -c', (c) => `zsh -c '${c}'`],
    ['eval', (c) => `eval "${c}"`],
    ['timeout', (c) => `timeout 10 ${c}`],
    ['timeout with a signal', (c) => `timeout -s KILL 10 ${c}`],
    ['caffeinate', (c) => `caffeinate -i ${c}`],
    ['nohup', (c) => `nohup ${c} &`],
    ['env', (c) => `env FOO=1 ${c}`],
    ['env into bash -c', (c) => `env -i bash -c "${c}"`],
    ['sudo -u', (c) => `sudo -u deploy ${c}`],
    ['sudo -u into sh -c', (c) => `sudo -u deploy sh -c '${c}'`],
    ['xargs', (c) => `ls | xargs ${c}`],
    ['xargs into sh -c', (c) => `ls | xargs -I{} sh -c '${c}'`],
    ['ssh into bash -c', (c) => `ssh host 'bash -c "${c}"'`],
  ];
  for (const [wrapper, wrap] of wrappers) {
    test(`behind ${wrapper}, every destructive form asks`, () => {
      for (const [form, kind] of destructive) {
        const command = wrap(form);
        expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: expect.arrayContaining([kind]) });
      }
    });
  }

  test('a wrapper around a harmless command, or handing harmless text, asks nothing', () => {
    for (const c of [
      'ssh host uptime', 'ssh -t host', 'ssh host "git push"', 'ssh host \'echo "rm -rf x"\'',
      'bash script.sh', 'bash -c "echo rm -rf x"', "sh -c 'git status'", 'zsh -lc "bun run build"',
      'eval "$(ssh-agent -s)"', 'eval "$(direnv hook zsh)"', 'timeout 5 ls', 'timeout 30 bun test',
      'caffeinate -t 60', 'caffeinate -i bun run build', 'nohup bun run dev &', 'env NODE_ENV=production bun run build',
      'find . -name "*.ts" | xargs grep -n TODO',
    ]) {
      expect({ c, confirm: commandRisk(c).confirm }).toEqual({ c, confirm: [] });
    }
  });

  test('a loop of harmless commands still asks nothing', () => {
    expect(kinds('for f in *.ts; do echo "$f"; done')).toEqual([]);
    expect(kinds('if [ -f x ]; then cat x; else ls; fi')).toEqual([]);
    expect(kinds('echo one \\\n  two')).toEqual([]);
  });

  test('the reason names what was found, as written', () => {
    expect(commandRisk('cd /tmp && rm -rf build').confirm).toEqual([{ kind: 'rm', text: 'rm -rf' }]);
    expect(commandRisk('python3 x.py <take>.mp3').confirm).toEqual([{ kind: 'placeholder', text: '<take>' }]);
  });

  test('sudo in front of another reason gives both', () => {
    expect(kinds('sudo rm -rf /var/tmp/x')).toEqual(['sudo', 'rm']);
  });

  test('a heredoc, an input redirection and a process substitution are not placeholders', () => {
    expect(kinds('cat <<EOF\nx\nEOF')).toEqual([]);
    expect(kinds('wc -l < file.txt')).toEqual([]);
    expect(kinds('diff <(ls a) <(ls b)')).toEqual([]);
    expect(kinds('cat <<<"hello"')).toEqual([]);
    expect(kinds('echo hi 2>&1 >out.txt')).toEqual([]);
  });

  test('a reason at line 25 of 30 is found: the whole text is read, not what a collapsed block shows', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `echo step ${i + 1}`);
    lines[24] = 'rm -rf build';
    expect(kinds(lines.join('\n'))).toEqual(['rm']);
  });

  test('a reason repeated on several lines is named once', () => {
    expect(commandRisk('rm -rf a\nrm -rf b').confirm).toEqual([{ kind: 'rm', text: 'rm -rf' }]);
  });
});

describe('commandRisk: characters that do not show', () => {
  const hidden: Array<[string, string]> = [
    ['right-to-left override', 'echo ok‮'],
    ['bidi isolate', 'echo ⁦ok⁩'],
    ['zero width space', 'rm​ -rf'],
    ['zero width joiner', 'ls‍'],
    ['word joiner', 'ls⁠'],
    ['byte order mark', '﻿ls'],
    ['a C0 control byte', 'echo a\u0008b'],
    ['an escape byte', 'echo \u001b[2Kok'],
  ];
  for (const [name, command] of hidden) {
    test(`${name} blocks Run`, () => {
      expect(commandRisk(command).block).toBe('hidden-chars');
    });
  }

  test('tab and newline are not hidden', () => {
    expect(commandRisk('echo a\tb\necho c').block).toBeNull();
  });
});
