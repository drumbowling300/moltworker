import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /api/debug-logs - Public log retrieval for emergency troubleshooting
publicRoutes.get('/api/debug-logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const results = await Promise.all(
      processes.map(async (p) => {
        const logs = await p.getLogs();
        return {
          id: p.id,
          command: p.command,
          status: p.status,
          exitCode: p.exitCode,
          stdout: logs.stdout || '',
          stderr: logs.stderr || '',
        };
      }),
    );

    // Also try to read onboard.log directly if it exists
    let onboardLog = 'File not found';
    try {
      const onboardProc = await sandbox.startProcess('cat /root/onboard.log');
      // Wait a bit for the command to finish
      let waitAttempts = 0;
      while (onboardProc.status === 'running' && waitAttempts < 5) {
        await new Promise(r => setTimeout(r, 200));
        waitAttempts++;
      }
      const onboardLogs = await onboardProc.getLogs();
      onboardLog = onboardLogs.stdout || onboardLogs.stderr || 'Empty';
    } catch (err) {
      onboardLog = `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Log to console so it can be seen via wrangler tail
    console.log('[DEBUG] Process list:', JSON.stringify(results, null, 2));
    console.log('[DEBUG] Onboard log:', onboardLog);

    return c.json({ processes: results, onboardLog });
  } catch (err) {
    console.error('[DEBUG] Error fetching logs:', err);
    return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
