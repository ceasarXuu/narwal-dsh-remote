<p align="center"><img src="https://ceasarxuu.github.io/narwal-dsh-remote/narwal.png" width="112" height="112" alt="Narwal mascot"></p>

<h1 align="center">Narwal for DeepSeek Harness</h1>

<p align="center">Connect the Narwal iPhone app to DeepSeek Harness on your desktop.</p>

<p align="center">
  <a href="https://ceasarxuu.github.io/narwal-dsh-remote/">Website</a> ·
  <a href="https://www.npmjs.com/package/narwal-dsh-remote">npm</a> ·
  <a href="https://github.com/ceasarXuu/narwal-dsh-remote/blob/main/README.zh-CN.md">简体中文</a>
</p>

## Install and pair

You’ll need DeepSeek Harness (DSH) on your desktop and the Narwal iOS app. Keep both devices on the same Wi-Fi for direct pairing.

1. In DSH Desktop, go to **Settings → Plugins**, install `narwal-dsh-remote`, and restart DSH. For a CLI-managed profile, you can instead run:

   ```sh
   dsh plugin --profile <your-profile> add narwal-dsh-remote
   ```

2. On the desktop, open **Settings → Narwal** and create a pairing token.
3. Scan the pairing QR code or paste the pairing link into Narwal on your iPhone. To disconnect a device and invalidate its saved link, revoke its token in DSH.

Version 0.6.0 introduces automatic bridge updates. Install it once from DSH's plugin settings to enable future updates. Narwal checks the stable npm release by default and restores a working bridge if the new version cannot start. Pairings are kept in the desktop's Narwal data directory.

## Build from source

Run these commands from a checkout of this repository:

```sh
npm run check
npm run pack -- /tmp
```

Install the resulting `narwal-dsh-remote-<version>.tgz` in your DSH profile to test a local build. See [publishing](https://github.com/ceasarXuu/narwal-dsh-remote/blob/main/CONTRIBUTING.md#publish-to-npm) for the release workflow.

[Privacy policy draft](https://ceasarxuu.github.io/narwal-dsh-remote/privacy.html) · [Service statement draft](https://ceasarxuu.github.io/narwal-dsh-remote/service.html) · [MIT license](https://github.com/ceasarXuu/narwal-dsh-remote/blob/main/LICENSE)
