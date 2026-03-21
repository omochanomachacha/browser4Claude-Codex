import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ManagedChromeCdpBackend } from '../../src/backend/cdp.ts';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate free port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test('cdp backend connects to existing endpoint and executes list_tabs/snapshot', async () => {
  const httpPort = await getFreePort();
  const wsPort = await getFreePort();
  const wsUrl = `ws://127.0.0.1:${wsPort}`;

  const httpServer = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: wsUrl }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wsServer = new WebSocketServer({ port: wsPort });

  wsServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };

      const respond = (result: Record<string, unknown>) => {
        socket.send(JSON.stringify({ id: message.id, result }));
      };

      if (message.method === 'Target.getTargets') {
        respond({
          targetInfos: [{
            targetId: 'target-1',
            type: 'page',
            title: 'Fixture',
            url: 'https://example.test/',
          }],
        });
        return;
      }

      if (message.method === 'Browser.getWindowForTarget') {
        respond({ windowId: 99 });
        return;
      }

      if (message.method === 'Target.attachToTarget') {
        respond({ sessionId: 'session-1' });
        return;
      }

      if (message.method === 'Runtime.enable') {
        respond({});
        return;
      }

      if (message.method === 'Runtime.evaluate') {
        const expression = String(message.params?.expression ?? '');
        if (expression.includes('MAX_NODES')) {
          respond({
            result: {
              value: [
                { role: 'button', name: 'Log in', selector: '#login' },
                { role: 'textbox', name: 'Email', selector: '#email' },
              ],
            },
          });
          return;
        }

        respond({
          result: {
            value: { ok: true },
          },
        });
        return;
      }

      respond({});
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', () => resolve()));

  const backend = new ManagedChromeCdpBackend({
    browser_http_url: `http://127.0.0.1:${httpPort}`,
  });

  try {
    const tabs = await backend.execute('list_tabs', {}, 3000);
    assert.deepEqual(tabs, {
      tabs: [{
        id: 1,
        window_id: 99,
        active: false,
        title: 'Fixture',
        url: 'https://example.test/',
      }],
    });

    const snapshot = await backend.execute('snapshot', { target: 'active' }, 3000);
    assert.equal(snapshot.tab_id, 1);
    assert.equal(snapshot.window_id, 99);
    assert.deepEqual(snapshot.nodes, [
      { role: 'button', name: 'Log in', selector: '#login' },
      { role: 'textbox', name: 'Email', selector: '#email' },
    ]);
  } finally {
    await backend.dispose();
    await new Promise<void>((resolve, reject) => wsServer.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('cdp backend captures network and console events', async () => {
  const httpPort = await getFreePort();
  const wsPort = await getFreePort();
  const wsUrl = `ws://127.0.0.1:${wsPort}`;

  const httpServer = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: wsUrl }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wsServer = new WebSocketServer({ port: wsPort });

  wsServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };

      const respond = (result: Record<string, unknown>) => {
        socket.send(JSON.stringify({ id: message.id, result }));
      };

      if (message.method === 'Target.getTargets') {
        respond({
          targetInfos: [{
            targetId: 'target-1',
            type: 'page',
            title: 'Fixture',
            url: 'https://example.test/',
          }],
        });
        return;
      }

      if (message.method === 'Browser.getWindowForTarget') {
        respond({ windowId: 99 });
        return;
      }

      if (message.method === 'Target.attachToTarget') {
        respond({ sessionId: 'session-1' });
        return;
      }

      if (message.method === 'Network.enable') {
        respond({});
        setTimeout(() => {
          socket.send(JSON.stringify({
            method: 'Network.requestWillBeSent',
            sessionId: 'session-1',
            params: {
              requestId: 'req-1',
              request: { url: 'https://example.test/api', method: 'GET' },
              type: 'Fetch',
            },
          }));
          socket.send(JSON.stringify({
            method: 'Network.responseReceived',
            sessionId: 'session-1',
            params: {
              requestId: 'req-1',
              type: 'Fetch',
              response: {
                url: 'https://example.test/api',
                status: 200,
                statusText: 'OK',
                mimeType: 'application/json',
              },
            },
          }));
        }, 5);
        return;
      }

      if (message.method === 'Runtime.enable') {
        respond({});
        setTimeout(() => {
          socket.send(JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            sessionId: 'session-1',
            params: {
              type: 'log',
              args: [{ value: 'hello' }, { value: 123 }],
            },
          }));
          socket.send(JSON.stringify({
            method: 'Runtime.exceptionThrown',
            sessionId: 'session-1',
            params: {
              exceptionDetails: {
                text: 'Boom',
              },
            },
          }));
        }, 5);
        return;
      }

      if (message.method === 'Network.disable' || message.method === 'Runtime.disable') {
        respond({});
        return;
      }

      respond({});
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(httpPort, '127.0.0.1', () => resolve()));

  const backend = new ManagedChromeCdpBackend({
    browser_http_url: `http://127.0.0.1:${httpPort}`,
  });

  try {
    await backend.execute('network_start', { tab_id: 1 }, 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const networkDump = await backend.execute('network_dump', { tab_id: 1 }, 3000);
    assert.equal((networkDump.count as number) >= 1, true);
    assert.equal(
      (networkDump.requests as Array<Record<string, unknown>>).some((entry) => entry.status === 200),
      true,
    );

    await backend.execute('console_start', { tab_id: 1 }, 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const consoleDump = await backend.execute('console_dump', { tab_id: 1 }, 3000);
    assert.equal((consoleDump.count as number) >= 2, true);
    assert.equal(
      (consoleDump.messages as Array<Record<string, unknown>>).some((entry) => entry.text === 'hello 123'),
      true,
    );

    await backend.execute('network_stop', { tab_id: 1 }, 3000);
    await backend.execute('console_stop', { tab_id: 1 }, 3000);
  } finally {
    await backend.dispose();
    await new Promise<void>((resolve, reject) => wsServer.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
