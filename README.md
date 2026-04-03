# Remotion Complete

Stop writing render scripts by hand. Generate videos programmatically, track render progress, and manage your entire Remotion workflow, all from your AI assistant.

## What it does

Remotion Complete wraps the full Remotion API as an MCP server. Trigger Lambda renders, check progress, manage S3 sites, and estimate costs, without touching the CLI or writing glue code.

## Tools

| Tool | Description |
|------|-------------|
| `render_video_lambda` | Start a video render on AWS Lambda |
| `get_render_progress` | Poll progress and get the output URL when done |
| `cancel_render` | Stop an in-progress render to avoid unnecessary costs |
| `render_video_local` | Render locally (no AWS required, good for testing) |
| `render_still_local` | Render a single frame as a PNG/JPEG |
| `list_compositions` | List all compositions in a Remotion project |
| `get_composition_info` | Get dimensions, FPS, duration, and props for a composition |
| `create_bundle` | Webpack-bundle a Remotion project locally |
| `deploy_bundle_to_lambda` | Upload a bundle to S3 for Lambda rendering |
| `create_site` | Create a new Remotion Lambda site |
| `list_sites` | List all deployed Remotion sites in your AWS account |
| `delete_site` | Remove a site from S3 |
| `estimate_render_cost` | Get a USD cost estimate before starting a render |
| `get_render_config` | List Lambda functions available in your account |
| `validate_composition` | Check a composition is valid before rendering |

## Quick Start

1. Add to your MCP client (Claude Desktop, Cursor, etc.)
2. Set environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
3. Ask your AI to render a video:

```
Render my marketing-promo composition on Lambda with the headline "Join us in April"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | AWS secret key |
| `AWS_REGION` | Yes | AWS region, e.g. `us-east-1` |
| `REMOTION_SITE_NAME` | No | Default Remotion S3 site name |

## Built with

This server is built on [mastermindshq.business](https://mastermindshq.business) infrastructure.

## License

MIT
