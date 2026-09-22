# Pi Model Metadata Extension

[English](./README.md) | 中文

## 安装

```bash
pi install npm:pi-models-metadata
# 自定义 provider base URL 和 API Key
export PIMM_BASE_URL=https://openrouter.ai/api/v1
export PIMM_API_KEY=your_api_key_here
# 然后启动 pi
pi
```

## 可选配置

```bash
# 默认使用 OpenAI Responses API
export PIMM_API_TYPE=openai-responses
# OpenAI Chat Completions 兼容 provider 使用这个
export PIMM_API_TYPE=openai-completions
export PIMM_PROVIDER_NAME=custom-provider-name
export PIMM_METADATA_DATA_URL=https://yourdomain.com/path/to/models-data.json
export PIMM_CACHE_TTL_SECONDS=3600
export PIMM_CACHE_DIR=/path/to/cache
export PIMM_SKIP_CACHE=true
```

### 配置文件

扩展也会从 `~/.pi/agent/pi-models-metadata.env` 读取 `PIMM_*` 变量（位于 pi agent
目录，可通过 `PI_CODING_AGENT_DIR` 修改），格式见
[`pi-models-metadata.env.example`](./pi-models-metadata.env.example)。其他 key
会被忽略，真实环境变量优先级高于文件中的值。

扩展不读取项目目录下的 `.env`，否则任意仓库都可以把 provider API key 转发到其他主机。
当前目录的 `.env` 中包含 `PIMM_*` 变量时，扩展会输出 warning。

### 缓存与网络

模型列表和 metadata 默认本地缓存 1 小时。默认缓存目录是
`$XDG_CACHE_HOME/pi-models-metadata`；未设置 `XDG_CACHE_HOME` 时使用
`~/.cache/pi-models-metadata`。设置 `PIMM_SKIP_CACHE=true` 可以在启动时强制重新请求
provider 模型列表和 metadata；请求成功后仍会更新本地缓存。

请求超时时间为 10 秒。请求失败时使用最近一次的缓存，不限缓存时间。offline 模式
（`pi --offline` 或 `PI_OFFLINE=1`）下不发送请求，只使用缓存。session 期间 pi 会在后台刷新
模型列表（例如 `/model` 搜索时），缓存 TTL 过期后扩展才会重新发送请求。

## 更新内容

- 模型 ID 和显示名称
- Context window
- 最大输出 token 数
- 文本/图片输入能力
- Reasoning 支持
- 输入/输出/cache 价格

## 更多插件

- [tab-follow-up](https://github.com/lollipopkit/pi-tab-follow-up/blob/main/README.zh.md): 使用 <kbd>Tab</kbd> 而不是 <kbd>Alt</kbd>+<kbd>Enter</kbd> 来触发跟进输入。
- [ui-finetune](https://github.com/lollipopkit/pi-ui-finetune/blob/main/README.zh.md): 微调UI, 显示简洁
