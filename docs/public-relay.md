# Codex Mini 公网 Hub / Agent 方案

这个方案用于个人自用公网访问：公网服务器运行 Hub，Mac / Windows 运行 Agent。Agent 主动连接 Hub，Hub 显示在线设备并把浏览器请求转发到对应设备上的本地 Codex Mini。

## 架构

```text
手机 / 其他设备
  -> https://codex.example.com
  -> Caddy
  -> relay-hub.js
  -> 在线设备列表

点击 Mac / Windows
  -> https://mac.codex.example.com
  -> Caddy
  -> relay-hub.js
  -> relay-agent.js 长轮询取任务
  -> 本机 http://127.0.0.1:8787
  -> Codex Mini
  -> Codex Desktop
```

公网服务器不保存 Codex 登录态，也不直接运行 Codex Desktop。Codex Desktop 仍在你的 Mac / Windows 上。

## 公网服务器

启动 Hub：

```bash
cd /path/to/Codex-Mini
export HUB_HOST=127.0.0.1
export HUB_PORT=3000
export HUB_BASE_DOMAIN=codex.example.com
export HUB_COOKIE_DOMAIN=.codex.example.com
export HUB_ADMIN_TOKEN='换成管理口令'
export HUB_AGENT_SECRET='换成Agent连接密钥'
npm run relay:hub
```

Caddy 示例：

```caddyfile
codex.example.com, mac.codex.example.com, win.codex.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

访问控制台：

```text
https://codex.example.com
```

如果设置了 `HUB_ADMIN_TOKEN`，首次打开会要求输入管理口令。`HUB_COOKIE_DOMAIN=.codex.example.com` 可以让登录态同时覆盖主域名和设备子域名。

## Mac / Windows 设备

先确保这台电脑上的 Codex Mini 本地服务可用，并且 token 是固定值：

```bash
cd /path/to/Codex-Mini
export HOST=127.0.0.1
export PORT=8787
export MOBILE_TYPER_TOKEN='这台设备的本地CodexMiniToken'
npm start
```

然后启动 Agent：

```bash
cd /path/to/Codex-Mini
export RELAY_HUB_URL='https://codex.example.com'
export RELAY_AGENT_SECRET='和服务器HUB_AGENT_SECRET一致'
export RELAY_DEVICE_ID='macbook'
export RELAY_DEVICE_NAME='MacBook Pro'
export RELAY_DEVICE_SLUG='mac'
export RELAY_DEVICE_PUBLIC_HOST='mac.codex.example.com'
export LOCAL_CODEX_BASE='http://127.0.0.1:8787'
export LOCAL_CODEX_TOKEN='这台设备的本地CodexMiniToken'
npm run relay:agent
```

Windows 只需要换设备信息：

```powershell
$env:RELAY_HUB_URL="https://codex.example.com"
$env:RELAY_AGENT_SECRET="和服务器HUB_AGENT_SECRET一致"
$env:RELAY_DEVICE_ID="windows-pc"
$env:RELAY_DEVICE_NAME="Windows PC"
$env:RELAY_DEVICE_SLUG="win"
$env:RELAY_DEVICE_PUBLIC_HOST="win.codex.example.com"
$env:LOCAL_CODEX_BASE="http://127.0.0.1:8787"
$env:LOCAL_CODEX_TOKEN="这台设备的本地CodexMiniToken"
npm run relay:agent
```

## 关键配置

- `HUB_ADMIN_TOKEN`：网页登录口令，建议必须设置。
- `HUB_AGENT_SECRET` / `RELAY_AGENT_SECRET`：Agent 连接 Hub 的共享密钥，必须一致。
- `HUB_BASE_DOMAIN`：主域名，例如 `codex.example.com`。
- `HUB_COOKIE_DOMAIN`：建议设为 `.codex.example.com`，让登录 cookie 覆盖所有子域名。
- `RELAY_DEVICE_PUBLIC_HOST`：设备子域名，例如 `mac.codex.example.com`。
- `LOCAL_CODEX_TOKEN`：本机 Codex Mini 的 `MOBILE_TYPER_TOKEN`，只保存在设备端，不发给浏览器。

## 测试

本仓库提供一个集成测试，不依赖真实 Codex Desktop。测试会启动假的本地 Codex 服务、Hub 和 Agent，然后验证设备上线、网页代理、健康检查和 `/send` 转发。

```bash
npm run relay:test
```

## 当前限制

- 这是 HTTP 长轮询中继，不是 WebSocket。对当前 Codex Mini 的普通 HTTP API 足够用。
- 响应体会经过 base64 JSON 封装，不适合超大文件下载；当前附件上传体积按 Codex Mini 默认限制使用。
- Windows 端仍需要有能在本机 `127.0.0.1:8787` 提供兼容接口的 Codex Mini / Agent。
