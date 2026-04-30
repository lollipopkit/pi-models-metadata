# Pi Model Metadata Extension

English | [中文](./README.zh.md)

## Installation

```bash
pi install https://github.com/lollipopkit/pi-models-metadata
# Custom provider base URL and API Key
export PIMM_BASE_URL=https://openrouter.ai/api/v1
export PIMM_API_KEY=your_api_key_here
# Then launch pi
pi
```

## Optional Configuration

```bash
# Defaults to openai-response API response format
export PIMM_API_TYPE=openai-completions
export PIMM_PROVIDER_NAME=custom-provider-name
export PIMM_METADATA_DATA_URL=https://yourdomain.com/path/to/models-data.json
export PIMM_CACHE_TTL_SECONDS=3600
export PIMM_CACHE_DIR=/path/to/cache
```

The extension also reads these variables from a local `.env` file. Real
environment variables take precedence over `.env` values. Model and metadata
responses are cached locally for 1 hour by default. The default cache directory
is `$XDG_CACHE_HOME/pi-models-metadata`, or `~/.cache/pi-models-metadata` when
`XDG_CACHE_HOME` is not set.

## What It Updates

- Model IDs and display names
- Context window
- Maximum output tokens
- Text/image input capability
- Reasoning support
- Input/output/cache pricing
