/**
 * Update the current editable shell line from xterm input.
 *
 * This intentionally handles only deterministic local editing primitives. Shell
 * integration remains authoritative for the command that actually executed.
 */
export const applyTerminalInput = (line: string, data: string): string => {
  if (data === '\r' || data === '\n' || data === '\u0003' || data === '\u0015') return '';
  if (data === '\u007f' || data === '\b') return Array.from(line).slice(0, -1).join('');
  if (data === '\t' || data.startsWith('\u001b')) return line;

  let next = line;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) next += character;
  }
  return next;
};
