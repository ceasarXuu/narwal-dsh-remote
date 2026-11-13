# Maintaining the DSH plugin

The plugin watches `impl.js` for host logic changes. DSH's client HMR handles edits to `client.js`. Restart DSH after changing `index.js` or `cordis.patch.yml`.

## Publish to npm

Update the version in `package.json` on `main`. Run [Publish DSH plugin to npm](https://github.com/ceasarXuu/narwal-dsh-remote/actions/workflows/publish-dsh-npm.yml). The default run checks and packs the plugin. Select `publish` to send the checked archive to npm.

The package's npm Trusted Publisher uses owner `ceasarXuu`, repository `narwal-dsh-remote`, and workflow `publish-dsh-npm.yml`. Leave the environment blank and allow `npm publish`.
