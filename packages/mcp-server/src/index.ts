import { isAbsolute, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  BRIDGE_VERSION,
  BridgeError,
  MAX_WAIT_MS,
  type CancelResponse,
  type DelegateResponse,
  type FollowResponse,
  type StatusResponse,
  type WaitResponse,
} from '@dsh-codex-bridge/protocol'
import { BridgeClient } from './client.js'

function result(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function failure(error: unknown): CallToolResult {
  const bridge = error instanceof BridgeError
    ? error
    : new BridgeError('MCP_INTERNAL_ERROR', error instanceof Error ? error.message : String(error), 500)
  const value: Record<string, unknown> = {
    error: {
      code: bridge.code,
      message: bridge.message,
      ...(bridge.details === undefined ? {} : { details: bridge.details }),
    },
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  }
}

export function createMcpServer(client = new BridgeClient()): McpServer {
  const server = new McpServer({ name: 'dsh-codex-bridge', version: BRIDGE_VERSION })

  server.registerTool('dsh_delegate', {
    description: 'Delegate a task to a new session in the running DSH Desktop Host. Always pass the current Codex task working directory as cwd; its DSH Workspace is reused or registered. Returns immediately after prompt admission.',
    inputSchema: z.object({
      task: z.string().min(1).describe('Nonempty task for the DSH Host model.'),
      cwd: z.string().min(1).refine(isAbsolute, 'cwd must be absolute').describe('Required absolute working directory of the current Codex task, not the MCP process directory.'),
      model: z.string().min(1).optional().describe('Optional exact provider/model catalog selection. Omit to inherit the Host current model.'),
      reasoningEffort: z.string().min(1).optional().describe('Optional exact catalog effort, such as max. Applies to the Host current default model when model is omitted.'),
    }),
  }, async ({ task, cwd, model, reasoningEffort }) => {
    try {
      const response = await client.call<DelegateResponse>('/v1/delegate', {
        task,
        cwd: resolve(cwd),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      return result(response)
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_status', {
    description: 'Read mapped bridge status and raw DSH running/agent availability state.',
    inputSchema: z.object({ sessionId: z.string().min(1) }),
  }, async ({ sessionId }) => {
    try { return result(await client.call<StatusResponse>('/v1/status', { sessionId })) }
    catch (error) { return failure(error) }
  })

  server.registerTool('dsh_wait', {
    description: 'Wait for durable turn completion, cancellation, error, idle after a turn, or timeout. Timeout never cancels the session.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      timeoutMs: z.number().int().min(0).max(MAX_WAIT_MS).default(30_000),
      cursor: z.string().min(1).optional(),
    }),
  }, async ({ sessionId, timeoutMs, cursor }) => {
    try {
      return result(await client.call<WaitResponse>('/v1/wait', {
        sessionId,
        timeoutMs,
        ...(cursor === undefined ? {} : { cursor }),
      }, timeoutMs + 5_000))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_follow', {
    description: 'Return bounded incremental durable and transient assistant events after an opaque bridge cursor.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  }, async ({ sessionId, cursor, limit }) => {
    try {
      return result(await client.call<FollowResponse>('/v1/follow', {
        sessionId,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }))
    } catch (error) { return failure(error) }
  })

  server.registerTool('dsh_cancel', {
    description: 'Request cancellation of the active DSH turn without deleting or editing the session.',
    inputSchema: z.object({ sessionId: z.string().min(1) }),
  }, async ({ sessionId }) => {
    try { return result(await client.call<CancelResponse>('/v1/cancel', { sessionId })) }
    catch (error) { return failure(error) }
  })

  return server
}

export { BridgeClient } from './client.js'
