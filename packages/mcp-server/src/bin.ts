#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './index.js'

const server = createMcpServer()

try {
  await server.connect(new StdioServerTransport())
} catch (error) {
  console.error(`dsh-codex-bridge MCP failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
