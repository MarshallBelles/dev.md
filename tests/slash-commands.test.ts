import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  COMMANDS,
  SlashMenu,
  isSlashContext,
  matchCommands,
  resolveCommand,
  scoreCommand,
  splitKeys,
} from '../dist/ui/commands.js';

const names = (q: string) => matchCommands(q).map(m => m.command.name);

describe('Slash command palette', () => {
  describe('fuzzy matching', () => {
    it('ranks an exact name first', () => {
      assert.equal(names('exit')[0], 'exit');
      assert.equal(names('config')[0], 'config');
    });

    it('matches on a prefix', () => {
      assert.equal(names('co')[0], 'config');
      assert.equal(names('se')[0], 'sessions');
    });

    it('matches a non-contiguous subsequence, fzf style', () => {
      // "ssn" -> se-s-sio-n-s
      assert.ok(names('ssn').includes('sessions'));
      // "cfg" -> c-on-f-i-g
      assert.ok(names('cfg').includes('config'));
    });

    it('finds a command by what it does, not just its name', () => {
      assert.ok(names('quit').includes('exit'), '"quit" should surface /exit');
      assert.ok(names('settings').includes('config'), '"settings" should surface /config');
      assert.ok(names('reset').includes('new'), '"reset" should surface /new');
    });

    it('tolerates a transposed typo', () => {
      assert.ok(names('exti').includes('exit'), '"exti" should still find /exit');
    });

    it('returns everything for an empty query', () => {
      assert.equal(matchCommands('', 99).length, COMMANDS.length);
    });

    it('returns nothing for a query that matches nothing', () => {
      assert.equal(names('zzzzqqq').length, 0);
    });

    it('prefers the command name over a keyword hit', () => {
      // /new has keyword "clear"; nothing is named "clear", so /new wins - but a
      // name match must always outrank a keyword match when both are possible.
      const helpScore = scoreCommand('help', COMMANDS.find(c => c.name === 'help')!)!;
      const viaKeyword = scoreCommand('help', COMMANDS.find(c => c.name === 'config')!);
      assert.ok(viaKeyword === null || helpScore > viaKeyword);
    });

    it('respects the result limit', () => {
      assert.ok(matchCommands('e', 3).length <= 3);
    });
  });

  describe('slash context detection', () => {
    it('opens on a leading slash', () => {
      assert.equal(isSlashContext('/'), true);
      assert.equal(isSlashContext('/co'), true);
    });

    it('does not treat ordinary prose as a command', () => {
      assert.equal(isSlashContext('fix the bug'), false);
      assert.equal(isSlashContext('what is 2/3'), false);
    });

    it('closes once the line becomes an argument-bearing path', () => {
      // A unix path typed as a prompt should not hijack the input.
      assert.equal(isSlashContext('/usr/local/bin thing'), false);
    });
  });

  describe('menu state', () => {
    it('opens as soon as a slash is typed and lists everything', () => {
      const menu = new SlashMenu();
      menu.update('/');
      assert.equal(menu.isOpen(), true);
      assert.ok(menu.getMatches().length > 0);
    });

    it('narrows as more characters arrive', () => {
      const menu = new SlashMenu();
      menu.update('/');
      const all = menu.getMatches().length;
      menu.update('/co');
      assert.ok(menu.getMatches().length < all);
      assert.equal(menu.getSelected()!.name, 'config');
    });

    it('closes when the slash is deleted', () => {
      const menu = new SlashMenu();
      menu.update('/ex');
      assert.equal(menu.isOpen(), true);
      menu.update('');
      assert.equal(menu.isOpen(), false);
    });

    it('closes when nothing matches', () => {
      const menu = new SlashMenu();
      menu.update('/zzzzqqq');
      assert.equal(menu.isOpen(), false);
    });

    it('wraps the highlight in both directions', () => {
      const menu = new SlashMenu();
      menu.update('/');
      const n = menu.getMatches().length;

      assert.equal(menu.getSelectedIndex(), 0);
      menu.moveUp();
      assert.equal(menu.getSelectedIndex(), n - 1, 'up from the top wraps to the bottom');
      menu.moveDown();
      assert.equal(menu.getSelectedIndex(), 0, 'down from the bottom wraps to the top');
    });

    it('resets the highlight when the query changes', () => {
      const menu = new SlashMenu();
      menu.update('/');
      menu.moveDown();
      menu.moveDown();
      assert.notEqual(menu.getSelectedIndex(), 0);
      menu.update('/s');
      assert.equal(menu.getSelectedIndex(), 0, 'stale highlight must not survive a new query');
    });

    it('accept returns the completed slash form', () => {
      const menu = new SlashMenu();
      menu.update('/cfg');
      assert.equal(menu.accept(), '/config');
    });

    it('accept returns null when closed', () => {
      const menu = new SlashMenu();
      assert.equal(menu.accept(), null);
    });
  });

  describe('input chunk splitting', () => {
    // Regression: the input handler only accepted chunks of length 1, so a
    // pasted string arrived as one multi-character read and was dropped
    // entirely. Anything pasted into interactive mode simply vanished.
    it('splits a pasted run of characters into individual keys', () => {
      assert.deepEqual(splitKeys('/stat'), ['/', 's', 't', 'a', 't']);
    });

    it('keeps arrow-key escape sequences intact', () => {
      assert.deepEqual(splitKeys('\x1b[A'), ['\x1b[A']);
      assert.deepEqual(splitKeys('\x1b[B'), ['\x1b[B']);
    });

    it('handles a paste that mixes text, arrows and Enter', () => {
      assert.deepEqual(
        splitKeys('ab\x1b[Ac\r'),
        ['a', 'b', '\x1b[A', 'c', '\r']
      );
    });

    it('treats a lone escape as its own key', () => {
      assert.deepEqual(splitKeys('\x1b'), ['\x1b']);
    });

    it('returns nothing for an empty chunk', () => {
      assert.deepEqual(splitKeys(''), []);
    });
  });

  describe('resolving a submitted line', () => {
    it('resolves the slash form', () => {
      assert.equal(resolveCommand('/exit')!.name, 'exit');
    });

    it('still accepts the legacy bare words', () => {
      assert.equal(resolveCommand('exit')!.name, 'exit');
      assert.equal(resolveCommand('quit')!.name, 'exit');
      assert.equal(resolveCommand('new')!.name, 'new');
      assert.equal(resolveCommand('help')!.name, 'help');
      assert.equal(resolveCommand('?')!.name, 'help');
    });

    it('is case insensitive', () => {
      assert.equal(resolveCommand('/EXIT')!.name, 'exit');
    });

    it('does NOT hijack an ordinary prompt that happens to fuzzy-match', () => {
      // This is the important one: "config the database connection" is a task,
      // not a request to open the config file.
      assert.equal(resolveCommand('fix the exit code handling'), undefined);
      assert.equal(resolveCommand('add a new feature'), undefined);
    });

    it('resolves a misspelled slash command to the closest match', () => {
      assert.equal(resolveCommand('/exti')!.name, 'exit');
    });

    it('returns undefined for empty input', () => {
      assert.equal(resolveCommand(''), undefined);
      assert.equal(resolveCommand('   '), undefined);
    });
  });
});
