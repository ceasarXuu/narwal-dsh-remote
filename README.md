# Narwal Server — DSH 插件

本地 Narwal Server:让 **Narwal iOS App** 通过局域网(或之后的 Tailscale/relay)连接运行其上的 DeepSeek Harness 实例。

## 安装

```bash
# 已发布版本(推荐):在 $DSH_HOME 外的任意目录执行
dsh plugin --profile <your-profile> add narwal-dsh-remote

# 开发版：在仓库根目录打包后安装
npm run check
npm run pack -- /tmp
dsh plugin --profile <your-profile> add /tmp/narwal-dsh-remote-<version>.tgz
```

装载要点(开发过阶段验证):

- 装完在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 下确认有 `narwal-dsh-remote`
- **desktop profile 由 DSH Electron 自管** —— 通过 DSH 的「设置 → 插件」面板安装/重启;命令行 pnpm 对它无效
- 正确生效后,本进程内日志可见 `narwal bridge listening on <port>` 文案

## 设置面板(DSH web UI → 设置 → Narwal)

- **服务端口** `48317`(桌面端自启时若与 lab/另一实例冲突可换 `48318`)
- **局域网地址** `可空自动探测`:手机写入扫码/粘贴的 payload 的 host 字段;127.0.0.1 手机连不通。
- **广播名称**
- **配对令牌**:每台设备一枚,点[创建令牌]即生成;某一枚 **吊销** 后所有使用它的设备即时断开(code 4003)
- **设备表**:`sessionId/label` + 实时流数 + 接入时代,含「断开」按钮
- **QR**:每行「Copy」复制完整 `narwal://pair?...`,同时生成 SVG 二维码

## 终端管理(admin 路由)

- `GET /tokens?token=`
- `POST /tokens { action:'create' | 'revoke', … }?token=`
- `POST /devices { sessionId }?token=`(踢线)
- `GET /stats` 与 `/relay-status`(面板在用)
- `/qr.svg?token=<secret>` QR 图
- token 疲劳:auth 沿每条请求(query `token`)鉴权

## 承接的 DSH 内核事实(已在 asar 源码定档)

- unary `invoke({namespace, method, args, peer})`,stream `stream(...)` 二通道
- relay:同 ticket 双端(`/ws/host` / `/ws/phone`),帧级透传;收款/额度由 relay 管理面处理
- 每设备一个 in-process `Peer`(owner 本义),`session/*` 用 `internal/access` 全面放行

## npm 发布

在 `main` 更新 `package.json` 的版本后，手动运行 [Publish DSH plugin to npm](https://github.com/ceasarXuu/narwal-dsh-remote/actions/workflows/publish-dsh-npm.yml)。默认只检查并打包。勾选 `publish` 后，工作流通过 npm Trusted Publishing 发布同一个安装包。

npm 的 GitHub Actions Trusted Publisher 使用 `ceasarXuu/narwal-dsh-remote` 和 `publish-dsh-npm.yml`，允许直接执行 `npm publish`，环境名留空。
