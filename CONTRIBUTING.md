# Maintaining the DSH plugin

The source checkout watches `impl.js` for host logic changes. DSH's client HMR handles edits to `client.js`. Restart DSH after changing `index.js` or `cordis.patch.yml`.

## Publish to npm

Update the version in `package.json` on `main`. Run [Publish DSH plugin to npm](https://github.com/ceasarXuu/narwal-dsh-remote/actions/workflows/publish-dsh-npm.yml). The default run checks and packs the plugin. Select `publish` to send the checked archive to npm.

The package's npm Trusted Publisher uses owner `ceasarXuu`, repository `narwal-dsh-remote`, and workflow `publish-dsh-npm.yml`. Leave the environment blank and allow `npm publish`.

## Automatic bridge updates

Installed packages check the canonical `narwal-dsh-remote` npm `latest` tag by default. An update is a newer stable version whose `narwalRuntime.format` matches the installed bootstrap. Keep `narwalRuntime.files` complete whenever the host adds runtime files. The bootstrap stages verified files under the Narwal data directory and switches versions only after the new listener starts. It keeps the previous working runtime and the bundled runtime available for recovery.

The browser settings entry, Cordis patch, and bootstrap are delivered by the installed package. Compatibility changes to those entry points require shipping an updated package. The runtime updater tells npm apart from a source link by the source manifest's `private` flag. Set `autoUpdate: false` in the DSH plugin config to pause new checks.
