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

  // A payload that opens with an assignment: the quote in front of `FOO=1`
  // must not make it pass for the command's name.
  for (const [wrapper, wrap] of wrappers) {
    test(`behind ${wrapper}, a destructive form after assignments asks`, () => {
      for (const [form, kind] of destructive) {
        for (const command of [wrap(`FOO=1 ${form}`), wrap(`A=1 B=2 ${form}`)]) {
          expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: expect.arrayContaining([kind]) });
        }
      }
    });
  }

  // An assignment whose quoted value holds a space spans more than one word:
  // the word after `FOO="a` is still the value, not the command's name.
  for (const [wrapper, wrap] of wrappers) {
    const outer = wrap('X');
    if (outer.includes('"') && outer.includes("'")) continue; // no third quote to put inside both
    const q = outer.includes('"') ? "'" : '"';
    test(`behind ${wrapper}, a destructive form after a quoted assignment with spaces asks`, () => {
      for (const [form, kind] of destructive) {
        for (const command of [wrap(`FOO=${q}a b${q} ${form}`), wrap(`GIT_SSH_COMMAND=${q}ssh -i k${q} A=${q}1 2 3${q} ${form}`)]) {
          expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: expect.arrayContaining([kind]) });
        }
      }
    });
  }

  test('the quoted assignments the review found ask', () => {
    expect(kinds('GIT_SSH_COMMAND="ssh -i ~/.ssh/k" git push --force origin main')).toContain('git-push-force');
    expect(kinds('FOO="a b" rm -rf x')).toContain('rm');
    expect(kinds("FOO='a b' rm -rf x")).toContain('rm');
    expect(kinds('env VAR="a b" rm -rf x')).toContain('rm');
    expect(kinds('bash -c "FOO=\'a b\' rm -rf x"')).toContain('rm');
    // A quote that never closes: the next word is read as the command, not skipped with the rest.
    expect(kinds('FOO="a rm -rf x')).toContain('rm');
  });

  test('an everyday command after a quoted assignment with spaces asks nothing', () => {
    for (const c of [
      'GIT_SSH_COMMAND="ssh -i ~/.ssh/k" git push origin main', 'FOO="a b" ls -la', "MSG='hello world' bun run build",
      'env MSG="a b" bun run build', "bash -c \"MSG='hello world' echo ok\"", 'FOO="a" ls',
    ]) {
      expect({ c, confirm: commandRisk(c).confirm }).toEqual({ c, confirm: [] });
    }
  });

  // Read the way the shell reads them: ANSI-C quotes, quotes inside other
  // quotes, separators and expansions inside a quoted value, escaped spaces.
  const secondReview: Array<[string, RiskKind]> = [
    ["A=$'don\\'t' rm -rf 'my dir'", 'rm'],
    ["A=$'a\\'b' rm -rf 'a b'", 'rm'],
    ["env A=$'\\'' rm -rf 'a b'", 'rm'],
    ["A=$'\\'' rm -rf x\\'", 'rm'],
    ["A=$'it\\'s here' rm -rf x", 'rm'],
    ['bash -c "A=\\"x y\\" rm -rf x"', 'rm'],
    ['sh -c "GIT_SSH_COMMAND=\\"ssh -i k\\" git push --force"', 'git-push-force'],
    ['env -i "A=x y" rm -rf x', 'rm'],
    ['MSG="done (ok)" rm -rf x', 'rm'],
    ['A="a; b" rm -rf x', 'rm'],
    ['A="$(date) x" rm -rf x', 'rm'],
    ['A="`date` x" rm -rf x', 'rm'],
    ['A="{a b}" rm -rf x', 'rm'],
    ['A="one\ntwo" rm -rf x', 'rm'],
    ['A=a\\ b rm -rf x', 'rm'],
    ["$'\\x72m' -rf x", 'rm'],
    ['r\\\nm -rf x', 'rm'],
    ['> out.log rm -rf x', 'rm'],
    ['2>/dev/null git push --force', 'git-push-force'],
    ['echo "$(rm -rf x)"', 'rm'],
    ['diff <(rm -rf x) b', 'rm'],
    ['{ rm -rf x; }', 'rm'],
    ['ls `git reset --hard`', 'git-reset-hard'],
  ];
  for (const [command, kind] of secondReview) {
    test(`${JSON.stringify(command)} asks (${kind})`, () => {
      expect(kinds(command)).toContain(kind);
    });
  }

  test('a destructive word only as text asks nothing', () => {
    for (const c of [
      'FOO="a b" ls', 'git commit -m "rm -rf x"', 'echo "git push --force"', 'env A="rm -rf /" ls',
      'grep -e "rm -rf" file', `printf '%s' "a; rm -rf x"`, "echo $'rm -rf x'", 'echo hi # rm -rf x',
      'echo rm\\ -rf x', 'A="x; rm -rf y" ls', 'echo "a && rm -rf x"', "echo 'a | rm -rf x'",
    ]) {
      expect({ c, confirm: commandRisk(c).confirm }).toEqual({ c, confirm: [] });
    }
  });

  test('a quote that never closes: a destructive word anywhere on the line asks', () => {
    for (const c of ['A="a rm -rf x', "A='a rm -rf x", 'A="a b rm -rf "x" y', 'A="a b" rm -rf "x', "rm -rf x'", 'echo `rm -rf x']) {
      expect({ c, kinds: kinds(c) }).toEqual({ c, kinds: expect.arrayContaining(['rm']) });
    }
  });

  test('the three payloads the review found ask', () => {
    expect(kinds('bash -c "FOO=1 rm -rf x"')).toContain('rm');
    expect(kinds('ssh host "FOO=1 rm -rf x"')).toContain('rm');
    expect(kinds("sh -c 'A=1 B=2 git push --force'")).toContain('git-push-force');
  });

  test('an everyday payload after assignments asks nothing', () => {
    for (const c of [
      'bash -c "FOO=1 bun run build"', 'ssh host "NODE_ENV=production bun run build"', "sh -c 'A=1 B=2 git status'",
      "eval 'X=1 ls -la'", 'sudo -u deploy sh -c "PORT=3000 bun start"', 'echo "FOO=1 rm -rf x"',
    ]) {
      expect({ c, confirm: commandRisk(c).confirm.filter((r) => r.kind !== 'sudo') }).toEqual({ c, confirm: [] });
    }
  });

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

  // The fourth review: commands run by find's actions, by `su -c` and by
  // `watch`, which joins its words and hands them to `sh -c`.
  const fourthReview: Array<[string, RiskKind]> = [
    ["find . -exec sh -c 'rm -rf {}' \\;", 'rm'],
    ["find . -execdir bash -c 'rm -rf \"$1\"' _ {} \\;", 'rm'],
    ['find . -ok rm -rf {} \\;', 'rm'],
    ['find . -okdir rm {} \\;', 'find-delete'],
    ['find . -name x -exec echo {} \\; -exec rm {} +', 'find-delete'],
    ["find . -exec sudo git reset --hard \\;", 'git-reset-hard'],
    ['find . -delete', 'find-delete'],
    ['su -c "rm -rf x"', 'rm'],
    ["su root -c 'rm -rf x'", 'rm'],
    ["su - -c 'git push --force'", 'git-push-force'],
    ["su --command='rm -rf x' deploy", 'rm'],
    ['su -c "rm -rf x"', 'sudo'],
    ['watch rm -rf x', 'rm'],
    ["watch -n 1 'rm -rf x'", 'rm'],
    ['watch -x rm -rf x', 'rm'],
    ['watch --interval=5 kill -9 99999', 'kill'],
    ["xargs -I{} sh -c 'rm -rf {}'", 'rm'],
    ["ls | xargs -I{} sh -c 'rm -rf {}'", 'rm'],
  ];
  for (const [command, kind] of fourthReview) {
    test(`${JSON.stringify(command)} asks (${kind})`, () => {
      expect(kinds(command)).toContain(kind);
    });
  }

  test('everyday find, xargs and watch ask nothing', () => {
    for (const c of [
      "find . -name '*.ts' -exec grep -l foo {} +", 'find . -type f -exec wc -l {} \\;', "find . -exec sh -c 'echo {}' \\;",
      'find . -name node_modules -prune -o -print', "find . -name '*.log' -mtime +7 -print", 'find . -execdir git status \\;',
      'xargs -n1 echo', "git ls-files | xargs -I{} sh -c 'wc -l {}'", 'watch -n 2 git status', "watch 'ls -la'", 'watch -d df -h',
      'watch -x ls -la',
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

  // Read the way the shell reads them, third review: forms each of the shells
  // really ran with a probe in place of the verb, and Run asked nothing for.
  const thirdReview: Array<[string, RiskKind]> = [
    ['A+=1 rm -rf x', 'rm'],
    ['env A+=1 rm -rf x', 'rm'],
    ['GIT_SSH_COMMAND+=" -v" git push --force origin main', 'git-push-force'],
    ['function cleanup { rm -rf x; }; cleanup', 'rm'],
    ["cat > a.md <<EOF\nDon't edit\nEOF\nrm -rf build\ncat > b.md <<EOF\nIt's generated\nEOF", 'rm'],
    ["cat > a.md <<'EOF'\nRun `make\nEOF\nrm -rf build\ncat > b.md <<'EOF'\nthen` done\nEOF", 'rm'],
    ['cat <<EOF\n$(rm -rf x)\nEOF', 'rm'],
    ['echo ${X:-$(rm -rf x)}', 'rm'],
    [': "${OUT:=$(rm -rf x)}"', 'rm'],
    ["env -S 'rm -rf x'", 'rm'],
    ['env -P /usr/bin rm -rf x', 'rm'],
    ['exec -a name rm -rf x', 'rm'],
    ['builtin command rm -rf x', 'rm'],
    ['builtin exec rm -rf x', 'rm'],
    ["builtin eval 'rm -rf x'", 'rm'],
    ["sh -c -- 'rm -rf x'", 'rm'],
    ["bash -c -- 'rm -rf x'", 'rm'],
    ["zsh -c -- 'rm -rf x'", 'rm'],
    ["bash -c -e 'rm -rf x'", 'rm'],
    ["eval -- 'rm -rf x'", 'rm'],
    ['echo a | xargs -J % rm -rf %', 'rm'],
    ['echo a | xargs -R 1 -I % rm -rf %', 'rm'],
    ['ssh host -- rm -rf x', 'rm'],
    ['ssh host -t rm -rf x', 'rm'],
    ['ssh host -p 22 rm -rf x', 'rm'],
    ["echo 'rm -rf x' | sh", 'rm'],
    ["printf '%s\\n' 'git reset --hard' | bash", 'git-reset-hard'],
    ["sh <<< 'rm -rf x'", 'rm'],
    ["zsh -s <<< 'kill -9 99999'", 'kill'],
    ["bash <<'EOF'\nrm -rf x\nEOF", 'rm'],
    ["cat <<'EOF' | sh\nrm -rf x\nEOF", 'rm'],
    ['noglob rm -rf x', 'rm'],
    ['nocorrect rm -rf x', 'rm'],
    ['repeat 1 rm -rf x', 'rm'],
    ['coproc rm -rf x; wait', 'rm'],
    ['(- kill -9 99999)', 'kill'],
    ['if true { rm -rf x }', 'rm'],
    ['{rm,-rf,x}', 'rm'],
  ];
  for (const [command, kind] of thirdReview) {
    test(`${JSON.stringify(command)} asks (${kind})`, () => {
      expect(kinds(command)).toContain(kind);
    });
  }

  test('a heredoc body is text: a commit message or a file written with one asks nothing', () => {
    for (const c of [
      "git commit -m \"$(cat <<'EOF'\nDon't require sudo for the install step\n\nThe script no longer calls sudo.\nEOF\n)\"",
      "git commit -m \"$(cat <<'EOF'\nfix: don't kill -9 the worker\nEOF\n)\"",
      "git commit -m \"$(cat <<'EOF'\nWe don't need rm -rf here anymore.\nEOF\n)\"",
      "gh pr create --title x --body \"$(cat <<'EOF'\n## Summary\n- don't call sudo or pkill node\nEOF\n)\"",
      "cat > clean.sh <<'EOF'\n#!/bin/sh\nrm -rf dist\nEOF",
      "cat > README.md <<'EOF'\nIt's a tool. Run pkill node if it hangs.\nEOF",
      'cat <<-EOF\n\tdd if=/dev/zero of=x\n\tEOF',
    ]) {
      expect({ c, confirm: commandRisk(c).confirm }).toEqual({ c, confirm: [] });
    }
  });

  // commandRisk runs on every render of a runnable block: the time grows with
  // the text, not with how deep the quotes and wrappers nest. Each of these
  // took from 0.1 s to minutes before.
  test('nested quotes, expansions and wrappers stay fast up to 20 KB', () => {
    const fill = (unit: string, before = '', after = '') => before + unit.repeat(Math.floor((20480 - before.length - after.length) / unit.length)) + after;
    for (const command of [
      '"$('.repeat(26), fill('"$('), fill('$('), fill('${'), fill('"${'), fill('eval ', '', 'true'), 'eval '.repeat(400) + `"'"`,
      fill('eval ', '', `"'"`), fill('nohup ', "'"), fill('ssh h ', '', "'a b'"), fill('echo rm -rf x | sh | '), fill('cat <<A\n'),
      fill('if { '), fill('`a` '),
    ]) {
      const times = [0, 1, 2].map(() => { const t0 = performance.now(); commandRisk(command); return performance.now() - t0; }).sort((a, b) => a - b);
      expect({ command: command.slice(0, 40), ms: times[1]! < 100 }).toEqual({ command: command.slice(0, 40), ms: true });
    }
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
