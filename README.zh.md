# SplitSquare Harness

[English](README.md)

> SplitSquare Harness 是由独立第三方维护的开源项目，与 DeepSeek 不存在隶属关系，且未获 DeepSeek 授权、认可或赞助。“DeepSeek”仅用于如实说明兼容性及上游来源。应用使用独立原创的黑白 SplitSquare 标识，不使用 DeepSeek 名称或 logo 作为应用身份。

这是一个可安装的 Electron 桌面端，完整复用官方 `@deepseek-ai/dsh` Web 应用。桌面端会在系统分配的随机回环端口启动 Harness，验证官方就绪信号和客户端清单后，再把完整 GUI 加载进受限窗口。

## 满血能力

- 锁定官方 `@deepseek-ai/dsh` `0.1.0-rc.6`，模型、凭据、会话、插件和 Agent 工具均由官方 Harness 管理。
- Electron 43；关闭 Node Integration，启用 Context Isolation、Renderer Sandbox 和 Web Security。
- 本机窗口支持文件选择与下载、剪贴板、通知、摄像头/麦克风、屏幕共享、全屏、定位、MIDI、WebHID、Web Serial、WebUSB 和 Web Bluetooth。
- 高风险能力只对本次启动得到的精确 `127.0.0.1:<port>` Origin 开放，并经过原生确认或设备选择；未知权限默认拒绝，授权只保存在内存中，后端换端口后不会继承。
- 桌面端负责 Harness 后端的启动、健康检查、异常展示、优雅退出和超时强制回收。
- 原生菜单可切换工作目录、重启后端、选择局域网网卡、启停远程访问和生成新配对码。

API Key 不会复制进安装包。Harness 数据仍使用它自己的 `DSH_HOME`，通常是 `%USERPROFILE%\.dsh`。

## 局域网安全访问

远程访问不会让 Harness 监听 `0.0.0.0`。官方服务仍只绑定随机的 `127.0.0.1` 端口，Electron 主进程另外提供一个固定目标的 HTTPS/WSS 网关：

```text
局域网浏览器 -- HTTPS/WSS --> 配对与来源校验网关 --> 127.0.0.1:<随机 DSH 端口>
```

安全边界包括：

- 只绑定用户选择的私有 IPv4 网卡，不实现开放代理，也不接受客户端指定上游。
- 每次生成 256-bit 一次性配对码，5 分钟失效；每个来源 IP 在 5 分钟内最多尝试 5 次。
- 配对后换取 `Secure + HttpOnly + SameSite=Strict` 会话 Cookie，最长 12 小时。
- 精确校验 Host、Origin 和 WebSocket Origin；移除客户端伪造的 Forwarded 头和网关 Cookie。
- HTTP、SSE、下载和 WebSocket 都是流式转发，不缓冲模型输出。
- Harness 崩溃、重启、切换网卡、停用网关或退出桌面端时，立即吊销会话并关闭旧连接。
- TLS 私钥与配对/会话密钥只存在于当前进程内，不写入桌面配置。

使用方法：

1. 在“远程访问”菜单中选择网卡并启用 HTTPS/WSS。
2. 桌面端会显示访问地址、一次性配对码和 TLS SHA-256 指纹。
3. 在同一局域网设备中打开该地址，核对证书指纹，然后输入配对码。
4. 需要新增设备时，选择“生成并显示新配对码”。

首次访问的是短期自签名证书，浏览器会提示不受系统信任。只有在指纹与桌面端完全一致时才继续；自签名证书本身不能防御用户忽略错误指纹后的中间人攻击。Windows 防火墙弹窗应只允许“专用网络”。

远程登录者拥有与本机 Harness 相同的文件、终端和 Agent 权限。不要在公共 Wi-Fi、端口转发、UPnP 或公网入口上开放它。

桌面设置位于 Electron 的用户数据目录 `desktop-settings.json`，只保存工作目录、启用状态、绑定 IP 和端口；不会保存配对码、Cookie 或 TLS 私钥。全新安装默认关闭远程访问。

## 开发、测试与打包

需要 Node 24、pnpm 11 和 Git。

```powershell
pnpm install
pnpm test
$env:DSH_DESKTOP_WORKSPACE='C:\path\to\workspace'
pnpm start
```

测试覆盖权限来源绕过、设置迁移、配对限流、TLS SAN、匿名拦截、Host/Origin 重写、SSE 首包、WebSocket 双向帧，以及真实官方 DSH 穿过网关的端到端启动。

生成解包应用或 Windows Squirrel 安装程序：

```powershell
pnpm package
pnpm make
```

公开版本由受保护的 `v*` 标签触发构建。发布工作流会核对包版本、运行完整测试、生成 SHA-256 校验和，并创建 GitHub 构建来源证明。Authenticode 签名通过仓库 Secret 接入，详见[发布指南](docs/releasing.md)。

默认 Windows x64 产物：

- 可直接运行：`out/SplitSquare Harness-win32-x64/SplitSquareHarness.exe`
- 安装程序：`out/make/squirrel.windows/x64/SplitSquare-Harness-Setup.exe`

## 架构边界

本项目是独立的桌面兼容壳，消费官方公开的 `dsh web` CLI，不进入 DeepSeek monorepo 的 npm 发布族。上游架构预留了未来第一方 Electron IPC carrier；迁移到零监听端口的 carrier 属于后续上游产品改造。本实现把本机回环服务作为可信上游，并在外围增加受认证的 LAN 网关。

- [远程通信架构提案](docs/architecture/remote-communication.md)

当前网关仅支持局域网。公网中继、离线投递和跨网络任务同步仍是架构提案，不属于已发布能力。

## 开源协作

- [源代码仓库](https://github.com/boxW-cloud/splitsquare-harness)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [品牌与商标边界](BRANDING.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [发布流程](docs/releasing.md)

DeepSeek Harness 目前仍是 Developer Preview。不要让两个不同的预发行版本同时使用同一个 `DSH_HOME`。
