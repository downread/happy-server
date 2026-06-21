# Publishing

This repo is generated from the monorepo by `lib/bin/publish-lib-happy-server.sh`.
Do not edit sources here directly; edit them in the monorepo and re-run the script.

## Steps

1. `npm install`
2. `npm test`
3. `npm run build`
4. `npm publish`   # scoped package, configured for public access

`npm publish` runs `prepublishOnly` (build) automatically, and the `files`
allowlist in package.json limits the tarball to dist/, index.ts, README and LICENSE.
