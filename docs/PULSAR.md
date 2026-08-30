# Attach SpaceTrash to Pulsar (or any MCP client)

SpaceTrash is a sibling product. Pulsar does not own it. Start the local API, then point an MCP client at the stdio bridge.

## 1. Run the API

From the SpaceTrash repo:

```bash
npm run api
```

Listens on `http://127.0.0.1:3847` only. Override with `SPACETRASH_PORT` / `SPACETRASH_HOST`.

The Electron app starts this API for you.

## 2. Add the MCP server

Cursor / Claude / other MCP hosts:

```json
{
  "mcpServers": {
    "spacetrash": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "cwd": "G:\\Projects\\SpaceTrash",
      "env": {
        "SPACETRASH_URL": "http://127.0.0.1:3847"
      }
    }
  }
}
```

From a global install of the repo you can also run `npm run mcp` in that working directory.

## 3. Tools

| Tool | What it does |
|---|---|
| `spacetrash_status` | Engine version, data dir, active scan |
| `spacetrash_list_volumes` | Drives |
| `spacetrash_start_scan` | Start a scan (no deletes) |
| `spacetrash_scan_status` | Progress |
| `spacetrash_list_findings` | Issues |
| `spacetrash_get_finding` | One issue |
| `spacetrash_preview_action` | Returns a one-time token |
| `spacetrash_apply_action` | Requires `token` + `confirm: true` |

Apply without a preview token is rejected. Archive findings are preview-only in v1.

## 4. HTTP for non-MCP agents

Same contract as the UI:

- `GET /api/status`
- `GET /api/volumes`
- `POST /api/scans` `{ "roots": ["C:\\"] }`
- `GET /api/scans/:id`
- `GET /api/scans/:id/summary`
- `GET /api/scans/:id/findings`
- `GET /api/findings/:id`
- `POST /api/findings/:id/preview`
- `POST /api/actions/apply` `{ "token": "...", "confirm": true }`

No Pulsar repo changes are required. Add the MCP server config and treat SpaceTrash like any other tool host.
