# codex.qianlanzz.xyz 公网 Relay 部署记录

本文记录当前服务器上的 Codex Relay Hub 部署状态，以及 Mac / Windows 设备接入方式。

## 公网入口

控制台地址：

```text
https://codex.qianlanzz.xyz
```

设备接入后会显示在控制台。点击设备后走单域名路径模式：

```text
https://codex.qianlanzz.xyz/device/<device-id>/
```

示例：

```text
https://codex.qianlanzz.xyz/device/macbook/
https://codex.qianlanzz.xyz/device/windows-pc/
```

## 当前服务器部署

Hub 服务：

```text
systemd service: codex-relay-hub.service
listen: 127.0.0.1:3100
workdir: /root/work/Codex-Mini
entry: /root/work/Codex-Mini/relay-hub.js
env: /etc/codex-relay-hub.env
```

Caddy 已将域名反代到 Hub：

```caddyfile
codex.qianlanzz.xyz {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3100
}
```

部署验证已通过：

```text
https://codex.qianlanzz.xyz -> 200 text/html
临时假设备 /device/server-test/codex/health 转发测试通过
```

## 管理命令

查看 Hub 状态：

```bash
systemctl status codex-relay-hub.service --no-pager --lines=30
```

重启 Hub：

```bash
systemctl restart codex-relay-hub.service
```

查看 Hub 日志：

```bash
journalctl -u codex-relay-hub.service -f
```

检查 Caddy 配置：

```bash
caddy validate --config /etc/caddy/Caddyfile
```

重载 Caddy：

```bash
caddy reload --config /etc/caddy/Caddyfile
```

查看监听端口：

```bash
ss -ltnp | rg ':3100|:80|:443'
```

## 密钥位置

密钥没有写入仓库文档，保存在服务器：

```text
/etc/codex-relay-hub.env
```

查看方式：

```bash
sed -n '1,120p' /etc/codex-relay-hub.env
```

其中：

```text
HUB_ADMIN_TOKEN   控制台登录口令
HUB_AGENT_SECRET  Mac / Windows Agent 连接 Hub 的共享密钥
```

## Mac 设备接入

在 Mac 上先启动本地 Codex Mini。建议使用固定 token：

```bash
cd /path/to/Codex-Mini
export HOST=127.0.0.1
export PORT=8787
export MOBILE_TYPER_TOKEN='换成这台Mac的本地CodexMiniToken'
npm start
```

然后启动 Agent：

```bash
cd /path/to/Codex-Mini
export RELAY_HUB_URL='https://codex.qianlanzz.xyz'
export RELAY_AGENT_SECRET='填服务器 /etc/codex-relay-hub.env 里的 HUB_AGENT_SECRET'
export RELAY_DEVICE_ID='macbook'
export RELAY_DEVICE_NAME='MacBook Pro'
export RELAY_DEVICE_SLUG='macbook'
export LOCAL_CODEX_BASE='http://127.0.0.1:8787'
export LOCAL_CODEX_TOKEN='和上面的 MOBILE_TYPER_TOKEN 一致'
npm run relay:agent
```

接入成功后，控制台会出现 `MacBook Pro`，入口类似：

```text
https://codex.qianlanzz.xyz/device/macbook/
```

## Windows 设备接入

先确保 Windows 上的 Codex Mini 本地服务监听在：

```text
http://127.0.0.1:8787
```

PowerShell 启动 Agent：

```powershell
cd C:\path\to\Codex-Mini
$env:RELAY_HUB_URL="https://codex.qianlanzz.xyz"
$env:RELAY_AGENT_SECRET="填服务器 /etc/codex-relay-hub.env 里的 HUB_AGENT_SECRET"
$env:RELAY_DEVICE_ID="windows-pc"
$env:RELAY_DEVICE_NAME="Windows PC"
$env:RELAY_DEVICE_SLUG="windows-pc"
$env:LOCAL_CODEX_BASE="http://127.0.0.1:8787"
$env:LOCAL_CODEX_TOKEN="Windows 本地 Codex Mini token"
npm run relay:agent
```

接入成功后，控制台会出现 `Windows PC`，入口类似：

```text
https://codex.qianlanzz.xyz/device/windows-pc/
```

## 验证设备转发

设备上线后，在服务器上可以验证设备列表：

```bash
set -a
. /etc/codex-relay-hub.env
set +a

curl -sS "http://127.0.0.1:3100/hub/devices" \
  -H "x-codex-relay-admin: $HUB_ADMIN_TOKEN"
```

也可以在浏览器打开：

```text
https://codex.qianlanzz.xyz
```

输入 `HUB_ADMIN_TOKEN` 后查看在线设备。

## 当前代码提交

公网 Relay 相关提交：

```text
bc9dcb9 Add public relay hub and agent
5e665f3 Support single-domain relay device paths
```

当前部署依赖第二个提交中的单域名路径模式。
