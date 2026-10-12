#!/usr/bin/env node
// Minimal stdio MCP server (no deps) exposing one tool, "echo", to test mcp__* observation.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const send = m => process.stdout.write(JSON.stringify(m) + '\n')
rl.on('line', line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } } })
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo back the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + (m.params?.arguments?.text ?? '') }] } })
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } })
  }
})
