declare module '@xterm/headless/lib-headless/xterm-headless.js';
declare module 'diff';

declare module 'mammoth/mammoth.browser' {
  type ExtractInput = { arrayBuffer: ArrayBuffer } | { buffer: Buffer };
  type ExtractResult = { value: string; messages: unknown[] };
  const mammoth: {
    extractRawText(input: ExtractInput): Promise<ExtractResult>;
    convertToHtml(input: ExtractInput): Promise<ExtractResult>;
  };
  export default mammoth;
}

declare module 'word-extractor' {
  class WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(): string;
  }
  export default class WordExtractor {
    constructor();
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}

declare module 'cookie' {
  export type CookieParseOptions = {
    decode?: (value: string) => string;
  };

  export function parse(cookieHeader: string, options?: CookieParseOptions): Record<string, string>;
}
