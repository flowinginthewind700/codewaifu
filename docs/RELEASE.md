# Cutting a release

One pipeline, three platforms, and one human decision per platform: who has
actually opened the artifact. Linux and Windows ship from CI. The mac release
is a person on a mac, because nothing on mac has ever been run here.

## Before the tag

The four gates, on the box you are releasing from:

```bash
npm run typecheck
npx vitest run
npx electron-vite build
DISPLAY=:1 npm run test:e2e   # needs a display; leaves tests/e2e/artifacts/bench.png
```

Then bump the version in the one place it lives, commit, and tag:

```bash
npm version 0.5.0 --no-git-tag-version   # package.json + package-lock.json together
git tag v0.5.0 && git push origin v0.5.0
```

A tag with a dash (`v0.5.0-rc1`) publishes as a prerelease; the publish job
decides that from the tag name alone.

## What the tag does

`.github/workflows/release.yml` builds all three platforms in parallel
(`macos-14`, `windows-latest`, `ubuntu-22.04`). Each matrix entry first runs
`node scripts/ensure-voice-runtime.mjs <platform> <arches>`, because the neural
voice is a native optionalDependency per platform/arch: npm installs only the
binaries of the machine it runs on, and a missing one degrades every spoken
line to the OS voice without a word in the log. The mac entry asks for
`darwin arm64 x64` so the x64 zip from an arm64 runner still speaks.

Linux and Windows then get a packaged-binary smoke (`--cli help`, and
`--cli status --json` on Windows) - the only automated check that catches a
missing native dependency or a broken asar layout. Artifacts upload per
platform; the publish job attaches them to the GitHub release for the tag with
`--generate-notes`.

The deb/AppImage and the nsis/portable exe in that release are what Linux and
Windows users install from. Nothing else to do.

## The mac build, on a mac

CI's mac artifacts are unsigned (`identity: null`, no notarization) and have
never been opened by a human. Treat them as a fallback, not as the release:

```bash
npm ci
npm run dist:mac     # voice runtime for darwin arm64 + x64, then zip and dmg
```

Open the dmg, drag to /Applications, launch, and check by hand:

- she greets in the neural voice, not the OS voice (a silent Matcha load is
  exactly the failure `ensure-voice-runtime` exists to prevent);
- the menubar icon: left click summons her, right click opens the menu, and the
  bench row carries the attention count;
- the Bench opens and attaches to a running herdr, or shows the install card;
- the packaged binary answers the CLI:
  `./release/mac-arm64/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli help`.

Then attach the artifacts to the tag's release:

```bash
V=$(node -p "require('./package.json').version")
gh release upload "v$V" \
  release/CodeWaifu-"$V"-mac-*.dmg release/CodeWaifu-"$V"-mac-*.zip \
  --repo flowinginthewind700/codewaifu --clobber
```

Both globs carry the version on purpose. `release/` keeps every mac build this
box has ever made and nothing prunes it, so an unscoped `release/*.dmg` attaches
all eleven dmgs currently on this disk - 1.5 GB, ten of them versions nobody
should install - and each one looks equally official in the asset list. Count
them rather than trusting this number: `ls release/*.dmg | wc -l`.

The scoped `.zip` glob still does not pick up `.zip.blockmap`, and
`latest-mac.yml` stays out. The published mac set is the arm64 dmg plus the
arm64 and x64 zips, three files - which is what v0.4.5 and v0.4.8 carry, and
what v0.4.2, v0.4.6 and v0.4.7 do not, because no mac pass happened for those.
A release with linux and windows assets but no mac ones means this step was
never done, not that the mac build failed.

Known mac gaps at this version: no LoginItems autostart (Linux has
`install.sh --autostart`), and no CI runtime check - the manual pass above is
the only gate the mac build has.
