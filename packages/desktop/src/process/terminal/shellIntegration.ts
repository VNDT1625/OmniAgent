/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell integration — the mechanism behind VS Code-style "command decorations"
 * (a success/error dot next to each command, exit codes, current-directory
 * tracking, rerun). It works by having the shell emit well-known **OSC 633**
 * escape sequences around each prompt/command:
 *
 *  - `OSC 633 ; A ST`            prompt start
 *  - `OSC 633 ; B ST`            prompt end (command input begins)
 *  - `OSC 633 ; C ST`            command pre-execution (output begins)
 *  - `OSC 633 ; D ; <exit> ST`   command finished, with its exit code
 *  - `OSC 633 ; E ; <cmdline> ST` the command line that was run
 *  - `OSC 633 ; P ; Cwd=<dir> ST` the current working directory
 *
 * These are invisible control sequences; the renderer ({@link parseShellIntegration})
 * strips them from the visible output and turns them into structured command
 * markers the UI decorates.
 *
 * This module produces the per-shell snippet that emits those sequences, and a
 * launcher ({@link buildIntegratedLaunch}) that wires the snippet into the
 * shell's startup the way VS Code does — via a temp rc file + launch args/env,
 * NOT via stdin (which would echo the script into the visible output). Injection
 * is best-effort: if a shell is unknown we return the launch unchanged and the
 * terminal still works without decorations.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marker kinds emitted by the OSC 633 protocol. */
export type ShellIntegrationMarker =
  | { kind: 'prompt-start' }
  | { kind: 'prompt-end' }
  | { kind: 'command-start' }
  | { kind: 'command-end'; exitCode: number }
  | { kind: 'command-line'; commandLine: string }
  | { kind: 'cwd'; cwd: string };

/**
 * Detect the shell family from an executable path so we can pick the right
 * integration snippet.
 */
export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'unknown';

/** Classify a shell executable path into a {@link ShellFamily}. */
export const classifyShell = (shellPath: string): ShellFamily => {
  const base = shellPath.toLowerCase();
  if (base.includes('powershell') || base.includes('pwsh')) return 'powershell';
  if (base.includes('cmd.exe') || base.endsWith('\\cmd') || base === 'cmd') return 'cmd';
  if (base.includes('bash')) return 'bash';
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('fish')) return 'fish';
  return 'unknown';
};

/**
 * The PowerShell shell-integration snippet. Emits OSC 633 around the prompt by
 * wrapping the user's prompt function. Kept defensive: wrapped in try/catch so a
 * restricted execution policy never breaks the prompt.
 */
const POWERSHELL_SNIPPET = `
try {
  if (-not $global:__aionui_si) {
    $global:__aionui_si = $true
    $global:__aionui_origPrompt = $function:prompt
    function global:prompt {
      $code = $LASTEXITCODE; if ($null -eq $code) { $code = 0 }
      $out = [char]0x1b + "]633;D;" + $code + [char]0x07
      $out += [char]0x1b + "]633;A" + [char]0x07
      $loc = (Get-Location).Path
      $out += [char]0x1b + "]633;P;Cwd=" + $loc + [char]0x07
      $userPrompt = & $global:__aionui_origPrompt
      $out += $userPrompt
      $out += [char]0x1b + "]633;B" + [char]0x07
      return $out
    }
  }
} catch {}
`;

/**
 * The bash shell-integration snippet. Uses PROMPT_COMMAND + PS0/PS1 to emit the
 * OSC 633 sequences. PS0 fires right before command execution (command-start),
 * PROMPT_COMMAND fires before drawing the prompt (command-end + cwd).
 */
const BASH_SNIPPET = `
if [ -z "$__aionui_si" ]; then
  __aionui_si=1
  __aionui_prompt_end() {
    local code=$?
    printf '\\033]633;D;%s\\007' "$code"
    printf '\\033]633;A\\007'
    printf '\\033]633;P;Cwd=%s\\007' "$PWD"
  }
  PS0=$'\\033]633;C\\007'"$PS0"
  case "$PROMPT_COMMAND" in
    *__aionui_prompt_end*) ;;
    *) PROMPT_COMMAND="__aionui_prompt_end;$PROMPT_COMMAND" ;;
  esac
  PS1=$'\\033]633;A\\007'"$PS1"$'\\033]633;B\\007'
fi
`;

/**
 * The zsh shell-integration snippet, using precmd/preexec hooks (zsh's native
 * prompt hooks) to emit the OSC 633 sequences.
 */
const ZSH_SNIPPET = `
if [[ -z "$__aionui_si" ]]; then
  __aionui_si=1
  __aionui_precmd() {
    local code=$?
    printf '\\033]633;D;%s\\007' "$code"
    printf '\\033]633;A\\007'
    printf '\\033]633;P;Cwd=%s\\007' "$PWD"
  }
  __aionui_preexec() {
    printf '\\033]633;C\\007'
  }
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook precmd __aionui_precmd 2>/dev/null
  add-zsh-hook preexec __aionui_preexec 2>/dev/null
fi
`;

/**
 * Return the shell-integration init snippet for a shell family, or null when the
 * shell is unsupported (the terminal then runs without command decorations).
 * The snippet is written to the pty's stdin right after the session starts.
 */
export const getShellIntegrationSnippet = (family: ShellFamily): string | null => {
  switch (family) {
    case 'powershell':
      return POWERSHELL_SNIPPET.trim();
    case 'bash':
      return BASH_SNIPPET.trim();
    case 'zsh':
      return ZSH_SNIPPET.trim();
    // cmd.exe has no scriptable prompt hook for OSC injection; fish/unknown skipped.
    default:
      return null;
  }
};

/** The shell launch parameters after (maybe) wiring shell integration. */
export type IntegratedLaunch = {
  /** Shell executable (unchanged). */
  shell: string;
  /** Argv to start the shell with the integration loaded, or undefined to use the backend default. */
  args?: string[];
  /** Extra env vars to merge (e.g. ZDOTDIR for zsh). */
  env?: Record<string, string>;
  /** Temp files created for this launch; the manager deletes them on exit. */
  tempFiles: string[];
};

/** Write a temp init file and return its path (best-effort; throws on fs error). */
const writeTempInit = (prefix: string, ext: string, contents: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-si-'));
  const file = path.join(dir, `${prefix}${ext}`);
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
};

/**
 * Build the launch parameters for `shell` with shell integration wired in. The
 * snippet is loaded via the shell's own startup mechanism (no stdin echo):
 *  - **bash**: `--rcfile <tmp>` (the rc sources the user's ~/.bashrc then our snippet),
 *  - **zsh**: `ZDOTDIR=<tmpdir>` containing a `.zshrc` that sources the user's then ours,
 *  - **PowerShell**: `-NoExit -Command <snippet>` (runs at startup, keeps the session),
 *  - others (cmd/fish/unknown): returned unchanged (no decorations).
 *
 * Degrade-safe: any fs error returns the launch unchanged so the terminal still
 * opens. `tempFiles` lists files to clean up when the session exits.
 */
export const buildIntegratedLaunch = (shell: string, baseArgs?: string[]): IntegratedLaunch => {
  const family = classifyShell(shell);
  const snippet = getShellIntegrationSnippet(family);
  if (!snippet) return { shell, args: baseArgs, tempFiles: [] };

  try {
    if (family === 'bash') {
      const rc = writeTempInit('bash-init', '.sh', `[ -f ~/.bashrc ] && source ~/.bashrc\n${snippet}\n`);
      return { shell, args: ['--rcfile', rc, '-i'], tempFiles: [rc] };
    }
    if (family === 'zsh') {
      const zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-si-'));
      const userZdotdir = process.env.ZDOTDIR ?? os.homedir();
      const zshrc = path.join(zdotdir, '.zshrc');
      fs.writeFileSync(
        zshrc,
        `[ -f "${userZdotdir}/.zshrc" ] && source "${userZdotdir}/.zshrc"\n${snippet}\n`,
        'utf-8'
      );
      return { shell, args: baseArgs, env: { ZDOTDIR: zdotdir }, tempFiles: [zshrc] };
    }
    if (family === 'powershell') {
      // -NoExit keeps the session; -Command runs the snippet then drops to interactive.
      return { shell, args: ['-NoLogo', '-NoExit', '-Command', snippet], tempFiles: [] };
    }
  } catch (error) {
    console.warn('[shellIntegration] failed to wire integration; launching plain shell:', error);
  }
  return { shell, args: baseArgs, tempFiles: [] };
};
