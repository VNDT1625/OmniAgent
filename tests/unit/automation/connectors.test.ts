/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Automation connectors. Each suite injects fake `fetch`
 * implementations + byte readers so the connectors can be exercised without
 * touching the network or the filesystem.
 */

import { describe, expect, it, vi } from 'vitest';
import { createCloudUploader } from '@/process/automation/connectors/cloudUpload';
import { createEmailSender } from '@/process/automation/connectors/emailSend';
import { createFacebookPublisher } from '@/process/automation/connectors/facebookPost';
import { createTiktokPublisher } from '@/process/automation/connectors/tiktokPost';
import { createEditorAction } from '@/process/automation/connectors/appActions';
import { artifactFromInput, makeArtifact, substituteInput } from '@/process/automation/connectors/artifacts';

const fakeFetch = (handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch => {
  return ((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(typeof url === 'string' ? url : url.toString(), init))) as typeof fetch;
};

describe('artifacts helpers', () => {
  it('extracts an artifact from various input shapes', () => {
    const a = makeArtifact('/tmp/a.mp4', 'topic');
    expect(artifactFromInput(a)).toEqual(a);
    expect(artifactFromInput({ artifact: a })).toEqual(a);
    expect(artifactFromInput({ artifacts: [a, makeArtifact('/tmp/b.mp4')] })).toEqual(makeArtifact('/tmp/b.mp4'));
    expect(artifactFromInput('hello')).toBeNull();
  });

  it('substitutes {{input}} placeholders', () => {
    expect(substituteInput('hi {{input}}', 'world')).toBe('hi world');
    expect(substituteInput('art={{input}}', makeArtifact('/x.png', 'cat'))).toBe('art=cat');
    expect(substituteInput('n/a', null)).toBe('n/a');
  });
});

describe('cloud upload (S3)', () => {
  it('signs a public PUT and returns the public URL', async () => {
    let captured: { url: string; method?: string; auth?: string } | null = null;
    const uploader = createCloudUploader({
      readBytes: () => Promise.resolve(Buffer.from('hello-bytes')),
      fetchImpl: fakeFetch((url, init) => {
        captured = { url, method: init?.method, auth: (init?.headers as Record<string, string>)?.Authorization };
        return new Response('', { status: 200 });
      }),
    });
    const result = await uploader.upload(
      {
        provider: 's3',
        endpoint: 'https://s3.example.com',
        bucket: 'my-bucket',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'SECRETKEY',
        region: 'us-east-1',
        publicRead: true,
        sourcePath: '/tmp/clip.mp4',
      },
      null,
      'Cloud step'
    );
    expect(captured?.url).toBe('https://s3.example.com/my-bucket/clip.mp4');
    expect(captured?.method).toBe('PUT');
    expect(captured?.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    expect(result).toEqual({ url: 'https://s3.example.com/my-bucket/clip.mp4', key: 'clip.mp4', provider: 's3' });
  });

  it('throws a clear error when required fields are missing', async () => {
    const uploader = createCloudUploader({
      readBytes: () => Promise.resolve(Buffer.from('x')),
      fetchImpl: fakeFetch(() => new Response('', { status: 200 })),
    });
    await expect(uploader.upload({ provider: 's3', sourcePath: '/x.png' }, null, 'Cloud step')).rejects.toThrow(
      /endpoint/i
    );
  });

  it('uploads via WebDAV with Basic auth', async () => {
    let captured: { url: string; auth?: string } | null = null;
    const uploader = createCloudUploader({
      readBytes: () => Promise.resolve(Buffer.from('bytes')),
      fetchImpl: fakeFetch((url, init) => {
        captured = { url, auth: (init?.headers as Record<string, string>)?.Authorization };
        return new Response('', { status: 201 });
      }),
    });
    const result = await uploader.upload(
      {
        provider: 'webdav',
        baseUrl: 'https://nc.example.com/dav',
        username: 'alice',
        password: 'pw',
        sourcePath: '/tmp/photo.png',
        destination: 'shared/photo.png',
      },
      null,
      'WebDAV'
    );
    expect(captured?.url).toBe('https://nc.example.com/dav/shared/photo.png');
    expect(captured?.auth).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`);
    expect(result.provider).toBe('webdav');
  });
});

describe('email send', () => {
  it('renders templates and reports the recipient count', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<id@host>' });
    const sender = createEmailSender({
      createTransport: () => ({ sendMail }),
      readBytes: () => Promise.resolve(Buffer.from('attached')),
    });
    const result = await sender.send(
      {
        host: 'smtp.test',
        port: 587,
        from: 'me@x.com',
        to: 'a@x.com, b@y.com',
        subject: 'hi {{input}}',
        body: 'val={{input}}',
        attachArtifact: true,
      },
      makeArtifact('/tmp/clip.mp4', 'topic'),
      'Email'
    );
    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0][0] as {
      to: string[];
      subject: string;
      text: string;
      attachments?: { filename: string }[];
    };
    expect(message.to).toEqual(['a@x.com', 'b@y.com']);
    expect(message.subject).toBe('hi topic');
    expect(message.text).toBe('val=topic');
    expect(message.attachments?.[0]?.filename).toBe('clip.mp4');
    expect(result).toEqual({ messageId: '<id@host>', accepted: 2 });
  });

  it('throws a clear error when host or to is missing', async () => {
    const sender = createEmailSender({
      createTransport: () => ({ sendMail: () => Promise.resolve({}) }),
      readBytes: () => Promise.resolve(Buffer.from('x')),
    });
    await expect(
      sender.send({ host: '', port: 587, from: 'me@x.com', to: 'a@x.com', subject: 's', body: 'b' }, null, 'Email')
    ).rejects.toThrow(/host/i);
  });
});

describe('facebook publish', () => {
  it('posts a text message to /feed when no artifact is attached', async () => {
    let captured: { url: string; body?: string } | null = null;
    const publisher = createFacebookPublisher({
      readBytes: () => Promise.resolve(Buffer.from('bytes')),
      fetchImpl: fakeFetch((url, init) => {
        captured = { url, body: typeof init?.body === 'string' ? init?.body : '' };
        return new Response(JSON.stringify({ id: '123_456' }), { status: 200 });
      }),
    });
    const result = await publisher.post({ pageId: 'p1', accessToken: 'tok', message: 'hi {{input}}' }, 'world', 'FB');
    expect(captured?.url).toBe('https://graph.facebook.com/v21.0/p1/feed');
    expect(captured?.body).toContain('message=hi+world');
    expect(captured?.body).toContain('access_token=tok');
    expect(result).toEqual({ postId: '123_456', kind: 'text' });
  });

  it('uploads a photo to /photos when an image artifact is attached', async () => {
    let endpoint = '';
    const publisher = createFacebookPublisher({
      readBytes: () => Promise.resolve(Buffer.from('img-bytes')),
      fetchImpl: fakeFetch((url) => {
        endpoint = url;
        return new Response(JSON.stringify({ id: 'photo-1', post_id: 'post-1' }), { status: 200 });
      }),
    });
    const result = await publisher.post(
      { pageId: 'p1', accessToken: 'tok', message: 'cap', attachArtifact: true },
      makeArtifact('/tmp/x.png'),
      'FB'
    );
    expect(endpoint).toBe('https://graph.facebook.com/v21.0/p1/photos');
    expect(result.kind).toBe('photo');
  });

  it('surfaces graph error messages on a 4xx response', async () => {
    const publisher = createFacebookPublisher({
      readBytes: () => Promise.resolve(Buffer.from('x')),
      fetchImpl: fakeFetch(
        () => new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 400 })
      ),
    });
    await expect(publisher.post({ pageId: 'p1', accessToken: 'tok', message: 'hi' }, null, 'FB')).rejects.toThrow(
      /Invalid token/
    );
  });
});

describe('tiktok publish', () => {
  it('initialises and uploads the video in a single chunk', async () => {
    const calls: { url: string; method?: string; range?: string }[] = [];
    const publisher = createTiktokPublisher({
      readBytes: () => Promise.resolve(Buffer.from('video-bytes')),
      stat: () => Promise.resolve(11),
      fetchImpl: fakeFetch((url, init) => {
        calls.push({ url, method: init?.method, range: (init?.headers as Record<string, string>)?.['Content-Range'] });
        if (url.endsWith('/post/publish/video/init/')) {
          return new Response(
            JSON.stringify({
              data: { publish_id: 'pub-1', upload_url: 'https://upload.tiktok/abc' },
              error: { code: 'ok' },
            }),
            { status: 200 }
          );
        }
        return new Response('', { status: 200 });
      }),
    });
    const result = await publisher.post(
      { accessToken: 'tt', caption: 'hello' },
      makeArtifact('/tmp/clip.mp4'),
      'TikTok'
    );
    expect(calls[0].url).toMatch(/init/);
    expect(calls[1].url).toBe('https://upload.tiktok/abc');
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].range).toBe('bytes 0-10/11');
    expect(result).toEqual({ publishId: 'pub-1' });
  });

  it('rejects when the access token is empty', async () => {
    const publisher = createTiktokPublisher({
      fetchImpl: fakeFetch(() => new Response('')),
      readBytes: () => Promise.resolve(Buffer.from('x')),
      stat: () => Promise.resolve(1),
    });
    await expect(
      publisher.post({ accessToken: '', caption: 'x', videoPath: '/x.mp4' }, null, 'TikTok')
    ).rejects.toThrow(/access token/i);
  });
});

describe('editor app action', () => {
  it('writes content to disk and returns it as an artifact', async () => {
    const writes: { path: string; data: string }[] = [];
    const action = createEditorAction({
      fs: {
        mkdir: () => Promise.resolve(undefined),
        writeFile: (p: string, data: string) => {
          writes.push({ path: p, data });
          return Promise.resolve();
        },
        appendFile: () => Promise.resolve(),
      },
    });
    const result = await action.run(
      { path: '/tmp/out.txt', operation: 'create', content: 'hello {{input}}' },
      'world',
      'Editor'
    );
    expect(writes).toEqual([{ path: '/tmp/out.txt', data: 'hello world' }]);
    expect(result.artifact.path).toBe('/tmp/out.txt');
    expect(result.bytes).toBe('hello world'.length);
  });
});
