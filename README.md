# Aurora Live · 实时同声传译

LiveBridge —— 基于浏览器的**实时同声传译**工具：边听、边识别、边翻译，全程并行流水线。

线上地址：**https://live.ourmetaverse.cn** 

## 它能做什么

- **单向同传**：听一种语言（默认英文），实时出另一种语言（默认中文）的字幕 + 译文
- **实时流式识别**：WebSocket 逐字返回识别结果，边说边出字（对标豆包/讯飞口译）
- 句子卡片、双语分屏、段落流、纠错表、术语表、用量统计、Markdown 导出

## 架构

```
麦克风 (Web Audio + 16kHz 降采样)
   │  流式 PCM / 静音成段
   ▼
语音识别 ────→ 实时流式(WebSocket) 或 整段上传
   │  原文
   ▼
句子级流式翻译 (SSE) ────→ 译文
   ▼
语音合成 (可选) / 卡片流
```

- **源码**：`server.mjs`（零依赖 Node 服务，本地 `npm start` 即可跑）+ `public/`（前端界面）
- **云端部署**：Cloudflare Worker。`cf/live/build.py` 把 Node 源码自动编译成 `worker.js` + `assets.js`
- **登录/账户**：与独立的 `aurora-account` 服务**共用同一个 D1 数据库和 cookie**（`Domain=.ourmetaverse.cn`），
  所以登录态跨子域共享，本仓库**不实现登录**，直接用账号站注册的账号登录即可

## 目录

| 路径 | 说明 |
|---|---|
| `server.mjs` / `public/` | 业务源码（识别、翻译、前端界面），本地可直接跑 |
| `cf/live/build.py` | 源码 → Worker 的编译脚本 |
| `cf/live/worker.js` / `assets.js` | **编译产物，勿手改**（改源码后重跑 build.py 重新生成） |
| `cf/live/wrangler.toml` | 正式环境配置（`aurora-live` → live.ourmetaverse.cn） |
| `cf/live/wrangler.staging.toml` | 测试环境配置（`aurora-live-staging` → test.ourmetaverse.cn） |
| `cf/shared/session.js` | 会话校验（与账户服务共用同一份逻辑，读 D1 会话表） |
| `profiles.json` | API 密钥（**不提交**，部署为 Cloudflare Secret `PROFILES_JSON`） |

## 本地跑

```bash
npm start          # 或 MOCK=1 npm start（离线演示，不出网）
# 打开 http://localhost:8787
```

## 构建与部署

```bash
python3 cf/live/build.py                              # ① 编译源码 → worker.js + assets.js
wrangler secret put PROFILES_JSON -c cf/live/wrangler.toml < profiles.json   # ② 密钥（首次）
wrangler deploy -c cf/live/wrangler.toml              # ③ 部署正式环境
wrangler deploy -c cf/live/wrangler.staging.toml      #   部署测试环境
```

密钥只存在于服务端的 `profiles.json` / Cloudflare Secret，不进浏览器、不进 git。

## 识别引擎

- **云端实时流式**：`qwen3-asr-flash-realtime`，WebSocket 逐字返回部分结果
- **云端整段**：`qwen3-asr-flash` 主通道 + `SenseVoiceSmall`（免费）兜底
- **浏览器本地**：Chrome/Edge 自带的 Web Speech API（免费，无需密钥）
