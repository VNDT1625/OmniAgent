/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SMTP email connector for the Automation feature (`action.email.send`).
 *
 * Sends a plain-text email through any SMTP server using `nodemailer`, with an
 * optional attachment pulled from the previous step's {@link Artifact}. Like the
 * other connectors, `to`/`subject`/`body` support `{{input}}` substitution so the
 * message can quote the upstream pipeline value.
 *
 * The module exposes a dependency-injected factory ({@link createEmailSender}) so
 * tests can supply a fake transport and a fake byte reader instead of touching the
 * network or the filesystem. The default wiring builds a real `nodemailer`
 * transport and reads attachment bytes via {@link readArtifactBytes}.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as path from 'node:path';
import nodemailer from 'nodemailer';
import type { EmailNodeConfig } from '../automationTypes';
import { artifactFromInput, readArtifactBytes, substituteInput } from './artifacts';

/** A single attachment handed to the transport (in-memory bytes + filename). */
export type EmailAttachment = {
  /** File name shown to the recipient. */
  filename: string;
  /** Raw file bytes. */
  content: Buffer;
};

/** The message shape passed to {@link EmailTransport.sendMail}. */
export type EmailMessage = {
  /** Sender address. */
  from: string;
  /** Resolved, de-duplicated recipient list. */
  to: string[];
  /** Subject line. */
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional attachments. */
  attachments?: EmailAttachment[];
};

/**
 * Minimal SMTP transport contract this connector relies on. Kept intentionally
 * small (rather than importing nodemailer's full `Transporter`) so a fake can be
 * injected in tests; a real `nodemailer` transport is structurally compatible.
 */
export type EmailTransport = {
  sendMail(message: EmailMessage): Promise<{ messageId?: string }>;
};

/** Injectable collaborators; each has a production default. */
export type EmailSendDeps = {
  /** Build a transport from the node config. Defaults to a real `nodemailer` SMTP transport. */
  createTransport?: (config: EmailNodeConfig) => EmailTransport;
  /** Read attachment bytes from disk. Defaults to {@link readArtifactBytes}. */
  readBytes?: (filePath: string) => Promise<Buffer>;
};

/** Outcome of a send: the server message id (if any) and the recipient count. */
export type EmailSendResult = {
  /** Provider message id, or `null` when the transport did not report one. */
  messageId: string | null;
  /** Number of recipients the message was addressed to. */
  accepted: number;
};

/**
 * Build a real `nodemailer` SMTP transport from an {@link EmailNodeConfig}.
 * `secure` defaults to implicit TLS on port 465; auth is omitted when no
 * username is configured (open relay / local MTA).
 */
const defaultCreateTransport = (config: EmailNodeConfig): EmailTransport =>
  nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? config.port === 465,
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
  });

/** Split a comma-separated recipient string into trimmed, non-empty addresses. */
const parseRecipients = (raw: string): string[] =>
  raw
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0);

/**
 * Create an SMTP email sender. Pass `deps` to override the transport factory or
 * the attachment byte reader (e.g. in tests); omitted deps use production wiring.
 */
export const createEmailSender = (deps?: EmailSendDeps) => {
  const createTransport = deps?.createTransport ?? defaultCreateTransport;
  const readBytes = deps?.readBytes ?? readArtifactBytes;

  return {
    /**
     * Render and send the email for an `action.email.send` node.
     *
     * @param config - The node configuration (SMTP settings + templated fields).
     * @param input - The previous step's output; the source of `{{input}}` and of
     *   the artifact to attach when {@link EmailNodeConfig.attachArtifact} is set.
     * @param nodeName - Human-friendly node label used in error messages.
     * @returns The provider message id (or `null`) and the recipient count.
     * @throws If `host`, `from`, or the resolved recipient list is missing/empty.
     */
    async send(config: EmailNodeConfig, input: unknown, nodeName: string): Promise<EmailSendResult> {
      const host = config.host?.trim() ?? '';
      const from = config.from?.trim() ?? '';
      const to = parseRecipients(substituteInput(config.to ?? '', input));

      // Fail fast with an actionable message before opening any connection.
      if (host.length === 0) {
        throw new Error(`"${nodeName}" is missing an SMTP host.`);
      }
      if (from.length === 0) {
        throw new Error(`"${nodeName}" is missing a "from" address.`);
      }
      if (to.length === 0) {
        throw new Error(`"${nodeName}" has no recipients: set a "to" address.`);
      }

      const subject = substituteInput(config.subject ?? '', input);
      const text = substituteInput(config.body ?? '', input);

      // Attach the previous step's artifact when requested; silently skip if none.
      let attachments: EmailAttachment[] | undefined;
      if (config.attachArtifact) {
        const artifact = artifactFromInput(input);
        if (artifact) {
          const content = await readBytes(artifact.path);
          attachments = [{ filename: path.basename(artifact.path), content }];
        }
      }

      const message: EmailMessage = { from, to, subject, text };
      if (attachments) {
        message.attachments = attachments;
      }

      const transport = createTransport(config);
      const info = await transport.sendMail(message);

      return { messageId: info.messageId ?? null, accepted: to.length };
    },
  };
};
