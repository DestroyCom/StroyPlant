import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../api/trpc/context.js';
import { appRouter } from '../api/trpc/router.js';

// Batch 8 (docs/STROYPLANT_SPEC.md section 7.8) — the 4 tools call the exact same tRPC procedures
// the frontend uses, via appRouter.createCaller(ctx), rather than duplicating device/health/watering
// logic a second time for AI agents.
export function buildMcpServer(ctx: Context): McpServer {
  const caller = appRouter.createCaller(ctx);
  const server = new McpServer({ name: 'stroyplant', version: '1.0.0' });

  server.registerTool(
    'list_devices',
    {
      description:
        'List every claimed StroyPlant device (Parrot Pot or Xiaomi sensor) with its kind, name, latest reading, and assigned plant species.',
    },
    async () => ({ content: [{ type: 'text' as const, text: JSON.stringify(await caller.devices.list()) }] }),
  );

  server.registerTool(
    'get_plant_status',
    {
      description:
        "Get a device's current Health Engine status: overall status (ok/warning/warming_up/no_profile), trend, and per-parameter detail against its species' expected range. Same judgment shown on the StroyPlant dashboard.",
      inputSchema: { deviceId: z.string() },
    },
    async ({ deviceId }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await caller.health.deviceHealth({ deviceId })) }],
    }),
  );

  server.registerTool(
    'get_plant_history',
    {
      description: 'Get raw sensor readings for a device over a time window (defaults to the last 24 hours).',
      inputSchema: { deviceId: z.string(), hours: z.number().optional() },
    },
    async ({ deviceId, hours }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await caller.devices.history({ deviceId, hours })) }],
    }),
  );

  server.registerTool(
    'trigger_watering',
    {
      description:
        'Trigger an immediate watering on a Parrot Pot. Never fails silently (docs/STROYPLANT_SPEC.md section 7.1): an empty reservoir or unreachable device is reported as an explicit tool error, never a false success.',
      inputSchema: { deviceId: z.string() },
    },
    async ({ deviceId }) => {
      try {
        const result = await caller.devices.water({ deviceId });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Watering failed: ${message}` }], isError: true };
      }
    },
  );

  return server;
}
