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
# 默认使用 openai-response 格式的API响应
export PIMM_API_TYPE=openai-completions
export PIMM_PROVIDER_NAME=custom-provider-name
export PIMM_METADATA_DATA_URL=https://yourdomain.com/path/to/models-data.json
export PIMM_CACHE_TTL_SECONDS=3600
export PIMM_CACHE_DIR=/path/to/cache
```

扩展也会读取当前目录下的 `.env` 文件。真实环境变量优先级高于 `.env`。
模型列表和 metadata 默认本地缓存 1 小时。默认缓存目录是
`$XDG_CACHE_HOME/pi-models-metadata`；未设置 `XDG_CACHE_HOME` 时使用
`~/.cache/pi-models-metadata`。

## 更新内容

- 模型 ID 和显示名称
- Context window
- 最大输出 token 数
- 文本/图片输入能力
- Reasoning 支持
- 输入/输出/cache 价格
