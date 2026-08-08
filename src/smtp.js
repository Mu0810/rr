/**
 * Minimal SMTP client — enough to send one message, with no npm dependency.
 *
 * Supports implicit TLS (port 465) and STARTTLS (port 587), AUTH LOGIN and
 * AUTH PLAIN. Written against RFC 5321; deliberately small rather than general.
 *
 * Works with a Gmail app password, Zoho, Brevo, Mailgun, Amazon SES SMTP —
 * anything that speaks standard SMTP.
 */

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

class SmtpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

/**
 * Wraps a socket in a small request/response conversation.
 * SMTP replies can span multiple lines ("250-EXTENSION" … "250 LAST"), so a
 * reply is only complete when a line has a space after the status code.
 */
function conversation(socket, timeoutMs) {
  let buffer = '';
  let pending = null;

  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs);

  const fail = (err) => {
    const wrapped = err instanceof SmtpError ? err : new SmtpError(err.message, 'NETWORK');
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(wrapped);
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (!pending) return;

    const lines = buffer.split(CRLF);
    // The final reply line has a space (not a hyphen) after the status code.
    const lastComplete = lines.findIndex((l) => /^\d{3} /.test(l));
    if (lastComplete === -1) return;

    const reply = lines.slice(0, lastComplete + 1).join('\n');
    buffer = lines.slice(lastComplete + 1).join(CRLF);

    const { resolve, reject, expect } = pending;
    pending = null;

    const code = Number(reply.slice(0, 3));
    if (expect && !expect.includes(code)) {
      reject(new SmtpError(`server said: ${reply.split('\n')[0]}`, `SMTP_${code}`));
    } else {
      resolve({ code, reply });
    }
  });

  socket.on('error', fail);
  socket.on('timeout', () => {
    socket.destroy();
    fail(new SmtpError('timed out', 'TIMEOUT'));
  });

  return {
    /** Sends a command (or nothing, to read the greeting) and awaits the reply. */
    send(command, expect) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, expect };
        if (command !== null) socket.write(command + CRLF);
        // A reply may already be buffered from a previous chunk.
        if (buffer.split(CRLF).some((l) => /^\d{3} /.test(l))) socket.emit('data', '');
      });
    },
    socket,
  };
}

function connect(options) {
  return new Promise((resolve, reject) => {
    const socket = options.secure
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port });

    const onReady = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };
    const onError = (err) => {
      socket.removeListener(options.secure ? 'secureConnect' : 'connect', onReady);
      reject(new SmtpError(`cannot reach ${options.host}:${options.port} — ${err.message}`, 'CONNECT'));
    };

    socket.once(options.secure ? 'secureConnect' : 'connect', onReady);
    socket.once('error', onError);
  });
}

/** RFC 2047 encoding, so a non-ASCII subject line survives transit. */
function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Builds a MIME message. Supplying `html` produces a multipart/alternative body
 * so plain-text clients still get something readable.
 */
export function buildMessage({ from, to, replyTo, subject, text, html }) {
  const recipients = [].concat(to);
  const boundary = `----rr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const headers = [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@rocket-recruiters>`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const encode = (body) => Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

  if (!html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return headers.join(CRLF) + CRLF + CRLF + encode(text);
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(html),
    `--${boundary}--`,
  ];
  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}

/** A line beginning with "." would end the DATA block early. */
function dotStuff(message) {
  return message.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

/**
 * True for a host where traffic never leaves the machine. Plaintext SMTP to a
 * local relay is safe; plaintext to a remote host is not.
 */
export function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost', '[::1]'].includes(String(host).toLowerCase());
}

/**
 * Sends one message.
 *
 * @param {object} config  host, port, user, pass, secure, timeoutMs
 * @param {object} message from, to, replyTo, subject, text, html
 */
export async function sendMail(config, message) {
  const port = Number(config.port || 465);
  const secure = config.secure ?? port === 465;
  const timeoutMs = Number(config.timeoutMs || 15_000);
  const loopback = isLoopbackHost(config.host);

  let socket = await connect({ host: config.host, port, secure });
  let chat = conversation(socket, timeoutMs);

  try {
    await chat.send(null, [220]); // greeting
    let ehlo = await chat.send(`EHLO ${config.clientName || 'rocket-recruiters'}`, [250]);

    if (!secure) {
      if (/STARTTLS/i.test(ehlo.reply)) {
        await chat.send('STARTTLS', [220]);

        socket = await new Promise((resolve, reject) => {
          const upgraded = tls.connect({ socket, servername: config.host }, () => resolve(upgraded));
          upgraded.once('error', reject);
        });
        chat = conversation(socket, timeoutMs);
        ehlo = await chat.send(`EHLO ${config.clientName || 'rocket-recruiters'}`, [250]);
      } else if (!loopback) {
        // Neither implicit TLS nor STARTTLS, and the host is remote: this would
        // put a password and a candidate's personal data on the wire in clear.
        throw new SmtpError(
          config.user
            ? `${config.host} offers no TLS; refusing to send credentials in clear text`
            : `${config.host} offers no TLS; refusing to send candidate data unencrypted`,
          'NO_TLS',
        );
      }
    }

    if (config.user) {
      if (/AUTH[ =-].*PLAIN/i.test(ehlo.reply)) {
        const token = Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64');
        await chat.send(`AUTH PLAIN ${token}`, [235]);
      } else if (/AUTH[ =-].*LOGIN/i.test(ehlo.reply)) {
        await chat.send('AUTH LOGIN', [334]);
        await chat.send(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
        await chat.send(Buffer.from(config.pass, 'utf8').toString('base64'), [235]);
      } else {
        throw new SmtpError('server offers no supported auth method (PLAIN or LOGIN)', 'NO_AUTH');
      }
    }

    const envelopeFrom = config.envelopeFrom || config.user || message.from;
    await chat.send(`MAIL FROM:<${envelopeFrom}>`, [250]);
    for (const rcpt of [].concat(message.to)) {
      // Strip a display name: "Name <a@b.c>" -> a@b.c
      const address = /<([^>]+)>/.exec(rcpt)?.[1] || rcpt;
      await chat.send(`RCPT TO:<${address.trim()}>`, [250, 251]);
    }

    await chat.send('DATA', [354]);
    await chat.send(dotStuff(buildMessage(message)) + CRLF + '.', [250]);

    await chat.send('QUIT', [221]).catch(() => {}); // some servers just hang up
    return { ok: true };
  } finally {
    socket.destroy();
  }
}

export { SmtpError };
