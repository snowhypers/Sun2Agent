// A short-lived isolated Playwright browser reserved for coding checks.
const path = require('path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const registry = require('../mcp/registry');

const NAME = 'coding-browser';
let localProxy;

function loopback(host) {
  const value = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (value === 'localhost') return true;
  if (net.isIPv4(value)) return value.startsWith('127.');
  return value === '::1' || value === '::ffff:127.0.0.1';
}

function localAddresses(host, callback) {
  const cleanHost = String(host).replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost)) {
    if (!loopback(cleanHost)) return callback(null, []);
    const list = [cleanHost];
    if (cleanHost === '127.0.0.1' && !list.includes('::1')) list.push('::1');
    else if (cleanHost === '::1' && !list.includes('127.0.0.1')) list.push('127.0.0.1');
    return callback(null, list);
  }
  if (String(host).toLowerCase() !== 'localhost') return callback(null, []);
  dns.lookup(host, { all: true }, (error, records) => {
    if (error) return callback(error);
    const addresses = records.map((record) => record.address)
      .sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
    if (!addresses.includes('127.0.0.1')) addresses.push('127.0.0.1');
    if (!addresses.includes('::1')) addresses.push('::1');
    callback(null, addresses.length && addresses.every(loopback) ? addresses : []);
  });
}

// Playwright origin allowlists do not stop redirects. Keep the private browser's
// network behind this loopback-only proxy so redirects and subresources are checked too.
function createLocalOnlyProxy() {
  const proxy = http.createServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch (_) {
      try {
        target = new URL(`http://${request.headers.host || 'localhost'}${request.url}`);
      } catch (_) {
        response.writeHead(400).end('Bad proxy request');
        return;
      }
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      response.writeHead(403).end('Coding browser permits local HTTP(S) only');
      return;
    }
    localAddresses(target.hostname, (error, addresses) => {
      if (error || !addresses.length) {
        response.writeHead(403).end('Coding browser permits loopback destinations only');
        return;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('error', () => {
        if (!response.headersSent) response.writeHead(400).end();
      });
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        let attemptIdx = 0;

        function tryConnect() {
          if (attemptIdx >= addresses.length) {
            if (!response.headersSent) {
              response.writeHead(502);
              response.end('Bad Gateway');
            }
            return;
          }
          const address = addresses[attemptIdx++];
          const transport = target.protocol === 'https:' ? https : http;
          const headers = { ...request.headers, host: target.host };
          delete headers['proxy-connection'];

          const reqOptions = {
            hostname: address,
            port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
            path: `${target.pathname || '/'}${target.search || ''}`,
            method: request.method,
            headers,
            ...(target.protocol === 'https:' ? { servername: target.hostname } : {})
          };

          const upstream = transport.request(reqOptions, (result) => {
            response.writeHead(result.statusCode, result.headers);
            result.pipe(response);
          });

          upstream.on('error', (err) => {
            if (!response.headersSent && attemptIdx < addresses.length &&
                (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH')) {
              tryConnect();
            } else {
              if (!response.headersSent) response.writeHead(502);
              response.end();
            }
          });

          if (body.length > 0) upstream.end(body);
          else upstream.end();
        }

        tryConnect();
      });
    });
  });

  proxy.on('connect', (request, client, head) => {
    let target;
    try { target = new URL(`http://${request.url}`); } catch (_) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    localAddresses(target.hostname, (error, addresses) => {
      const port = Number(target.port);
      if (error || !addresses.length || !Number.isInteger(port) || port < 1 || port > 65535) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      let attemptIdx = 0;
      function tryConnect() {
        if (attemptIdx >= addresses.length) {
          client.destroy();
          return;
        }
        const address = addresses[attemptIdx++];
        const upstream = net.connect(port, address, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => {
          if (attemptIdx < addresses.length) {
            tryConnect();
          } else {
            client.destroy();
          }
        });
        client.on('error', () => upstream.destroy());
      }
      tryConnect();
    });
  });

  proxy.on('upgrade', (request, client, head) => {
    let target;
    try { target = new URL(request.url); } catch (_) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    localAddresses(target.hostname, (error, addresses) => {
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      if (error || !addresses.length || !Number.isInteger(port) || port < 1 || port > 65535) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      let attemptIdx = 0;
      function tryUpgrade() {
        if (attemptIdx >= addresses.length) {
          client.destroy();
          return;
        }
        const address = addresses[attemptIdx++];
        const upstream = net.connect(port, address, () => {
          let rawReq = `${request.method} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`;
          for (let i = 0; i < request.rawHeaders.length; i += 2) {
            const key = request.rawHeaders[i];
            const val = request.rawHeaders[i + 1];
            if (key.toLowerCase() === 'proxy-connection') continue;
            rawReq += `${key}: ${val}\r\n`;
          }
          rawReq += '\r\n';
          upstream.write(rawReq);
          if (head && head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => {
          if (attemptIdx < addresses.length) {
            tryUpgrade();
          } else {
            client.destroy();
          }
        });
        client.on('error', () => upstream.destroy());
      }
      tryUpgrade();
    });
  });
  proxy.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    proxy.once('listening', () => resolve(proxy));
    proxy.once('error', reject);
  });
}

function createServer({ headless = process.env.SUN2AGENT_SANDBOX === '1', proxyUrl } = {}) {
  const packageJson = require.resolve('@playwright/mcp/package.json');
  const args = [
    path.join(path.dirname(packageJson), 'cli.js'),
    '--browser', 'chrome',
    '--isolated',
    '--no-webmcp',
    '--timeout-navigation', '8000',
    '--timeout-action', '4000',
    '--timeout-settle', '300'
  ];
  if (proxyUrl) args.push('--proxy-server', proxyUrl);
  if (headless) args.push('--headless');
  return {
    name: NAME,
    type: 'stdio',
    command: process.execPath,
    args,
    env: {},
    builtin: true,
    connectTimeoutMs: 20000
  };
}

async function connect(connectServer) {
  if (registry.has(NAME)) {
    return { name: NAME, ok: true, tools: registry.get(NAME).tools };
  }
  try {
    localProxy = await createLocalOnlyProxy();
    const server = createServer({ proxyUrl: `http://127.0.0.1:${localProxy.address().port}` });
    const tools = await connectServer(server, undefined, { internal: true });
    return { name: NAME, ok: true, toolCount: tools.length, tools };
  } catch (error) {
    await stopProxy();
    return { name: NAME, ok: false, error: error.message };
  }
}

async function stopProxy() {
  if (!localProxy) return;
  const server = localProxy;
  localProxy = null;
  await new Promise((resolve) => server.close(resolve));
}

async function disconnect() {
  try { await registry.closeAndDelete(NAME); } finally { await stopProxy(); }
}

module.exports = {
  NAME,
  createServer,
  connect,
  isConnected: () => registry.has(NAME),
  disconnect,
  createLocalOnlyProxy,
  localAddresses
};
