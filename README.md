# Pi Model Metadata Extension

English | [中文](./README.zh.md)

## Installation

```bash
pi install npm:pi-models-metadata
# Custom provider base URL and API Key
export PIMM_BASE_URL=https://openrouter.ai/api/v1
export PIMM_API_KEY=your_api_key_here
# Then launch pi
pi
```

## Optional Configuration

```bash
# Defaults to OpenAI Responses API
export PIMM_API_TYPE=openai-responses
# Use this for OpenAI Chat Completions-compatible providers
export PIMM_API_TYPE=openai-completions
export PIMM_PROVIDER_NAME=custom-provider-name
export PIMM_METADATA_DATA_URL=https://yourdomain.com/path/to/models-data.json
export PIMM_CACHE_TTL_SECONDS=3600
export PIMM_CACHE_DIR=/path/to/cache
export PIMM_SKIP_CACHE=true
```

### Config File

The extension also reads `PIMM_*` variables from
`~/.pi/agent/pi-models-metadata.env` (the pi agent directory, which
`PI_CODING_AGENT_DIR` overrides). See
[`pi-models-metadata.env.example`](./pi-models-metadata.env.example). Other keys
are ignored, and real environment variables take precedence over file values.

Project `.env` files are not read: any repository could otherwise redirect the
provider API key to another host. The extension warns when the current
directory's `.env` contains `PIMM_*` variables.

### Cache and Network

Model and metadata responses are cached locally for 1 hour by default. The
default cache directory is `$XDG_CACHE_HOME/pi-models-metadata`, or
`~/.cache/pi-models-metadata` when `XDG_CACHE_HOME` is not set. Set
`PIMM_SKIP_CACHE=true` to force fresh provider model and metadata requests at
startup while still updating the local cache after a successful request.

Requests time out after 10 seconds. When a request fails, the last cached
response is used regardless of its age. In offline mode (`pi --offline` or
`PI_OFFLINE=1`), no requests are sent and only cached responses are used.
During a session, pi refreshes the model list in the background (for example
from `/model` search); the extension sends requests only after the cache TTL
expires.

## What It Updates

- Model IDs and display names
- Context window
- Maximum output tokens
- Text/image input capability
- Reasoning support
- Input/output/cache pricing

## More Extensions

- [tab-follow-up](https://github.com/lollipopkit/pi-tab-follow-up): Use <kbd>Tab</kbd> instead of <kbd>Alt</kbd>+<kbd>Enter</kbd> to trigger follow-up input.
- [ui-finetune](https://github.com/lollipopkit/pi-ui-finetune/blob/main/README.md): UI tweaks for a cleaner look.
