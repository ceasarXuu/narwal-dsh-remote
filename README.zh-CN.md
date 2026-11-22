<p align="center"><img src="https://ceasarxuu.github.io/narwal-dsh-remote/narwal.png" width="112" height="112" alt="Narwal 吉祥物"></p>

<h1 align="center">Narwal 的 DeepSeek Harness 插件</h1>

<p align="center">让 Narwal iPhone App 连接桌面端的 DeepSeek Harness。</p>

<p align="center">
  <a href="https://ceasarxuu.github.io/narwal-dsh-remote/zh/">主页</a> ·
  <a href="https://www.npmjs.com/package/narwal-dsh-remote">npm</a> ·
  <a href="README.md">English</a>
</p>

## 安装与配对

需要在桌面端运行 DeepSeek Harness（DSH），并在 iPhone 上安装 Narwal App。直连配对时，两台设备应接入同一 Wi-Fi。

1. 在 DSH 桌面端打开「设置 → 插件」，安装 `narwal-dsh-remote` 并重启 DSH。对于用命令行管理的 profile，可以运行：

   ```sh
   dsh plugin --profile <your-profile> add narwal-dsh-remote
   ```

2. 在桌面端打开「设置 → Narwal」，创建配对令牌。
3. 在 iPhone 的 Narwal App 中扫描二维码或粘贴配对链接。若要断开设备并让已保存的配对链接失效，在 DSH 中撤销对应令牌。

从 `0.6.0` 起，Narwal 默认自动更新桥接运行时。旧版需在 DSH 的插件设置中安装一次带有新引导壳的版本。更新通过固定的 npm 发布渠道获取。新版启动失败时恢复到可用版本，配对信息继续保存在桌面端的 Narwal 数据目录。

## 通过 Tailscale 连接

使用支持 Tailscale 的 Narwal iPhone 版本，以及下文带有 Noise 加密运行时的 DSH 插件。将两台设备接入同一个 tailnet，并允许 iPhone 访问 DSH 主机的插件 TCP 端口。默认端口为 `48317`。[Tailscale 设备连接说明](https://tailscale.com/docs/how-to/connect-to-devices)

对于用命令行管理的 DSH profile，在 `cordis.patch.yml` 中找到 `id: narwal-server` 对应的 `config`。将 `tailnetHost` 设置为桌面端的 Tailscale IPv4 地址（`100.64.0.0/10`），也可以使用能解析到该 IPv4 地址的完整 MagicDNS 名称，例如 `desktop.my-tailnet.ts.net`。重启 DSH 后生成并扫描新的加密配对二维码，让 iPhone 保存该地址。[Tailscale IPv4 地址](https://tailscale.com/docs/concepts/tailscale-ip-addresses) · [MagicDNS](https://tailscale.com/docs/features/magicdns)

iPhone 优先使用可用的 Wi-Fi 直连，离开局域网后可通过 Tailscale 连接 DSH。两条路径共用插件端口和 Narwal 加密协议。`tailnetHost` 留空即关闭此功能。填写无效地址时，DSH 会记录警告并从配对二维码中省略该地址。

## 从源码构建

在本仓库根目录运行：

```sh
npm run check
npm run pack -- /tmp
```

将生成的 `narwal-dsh-remote-<version>.tgz` 装入 DSH profile 即可试用本地构建。发布流程见 [npm 发布说明](CONTRIBUTING.md#publish-to-npm)。

### Relay 私有构建

在与目标 DSH 主机操作系统和 CPU 架构一致的机器上安装 Rust，从 Narwal 源码构建 Noise 原生扩展。然后回到本仓库，把私有包输出到单独目录。

```sh
cd /path/to/Narwal
bash packages/relay-crypto/scripts/build-node.sh
cd /path/to/narwal-dsh-remote
NARWAL_NOISE_DIR=/path/to/Narwal/packages/relay-crypto/dist/node npm run pack -- /tmp/narwal-relay-private
```

将生成的压缩包装入 DSH profile。私有包自带原生扩展和桥接运行时，通过本地压缩包分发。目标主机可以直接加载包内扩展，无需设置 `NARWAL_NOISE_DIR` 或检出 Narwal 源码。

[隐私政策](https://ceasarxuu.github.io/narwal-dsh-remote/zh/privacy.html) · [服务声明](https://ceasarxuu.github.io/narwal-dsh-remote/zh/service.html) · [MIT 许可](LICENSE)
