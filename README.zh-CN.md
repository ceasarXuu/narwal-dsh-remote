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

## 从源码构建

在本仓库根目录运行：

```sh
npm run check
npm run pack -- /tmp
```

将生成的 `narwal-dsh-remote-<version>.tgz` 装入 DSH profile 即可试用本地构建。发布流程见 [npm 发布说明](CONTRIBUTING.md#publish-to-npm)。

[隐私政策草稿](https://ceasarxuu.github.io/narwal-dsh-remote/zh/privacy.html) · [服务声明草稿](https://ceasarxuu.github.io/narwal-dsh-remote/zh/service.html) · [MIT 许可](LICENSE)
