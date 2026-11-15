# Third-party notices

The web and worker images carry `THIRD_PARTY_NOTICES.txt` with the license text
of their npm packages and web fonts. `scripts/third-party-notices.mjs` writes it
during the image build. The sections below cover the parts that need more than
a license text.

## DejaVu Sans Bold (Poster Art lettering)

The worker bundles `apps/worker/assets/fonts/DejaVuSans-Bold.ttf` from the
DejaVu Fonts project for deterministic local Session Cover lettering. The font
is distributed under the permissive Bitstream Vera license; the required
copyright and permission notice is retained beside the font in
`apps/worker/assets/fonts/LICENSE-DejaVu.txt`.

## FFmpeg (worker image)

The **worker** image installs Debian 12's `ffmpeg` package
(**`7:5.1.9-0+deb12u1`**), licensed under the **GNU GPL version 2 or later**
(details in-image at `/usr/share/doc/ffmpeg/copyright`). Liedmotif runs it only
as a separate program and never links against it, so Liedmotif's own license is
unaffected.

**Source for published images** (`ghcr.io/bergie81/liedmotif-worker`, amd64 and
arm64): on this repository's GitHub releases page, as the prerelease
`ffmpeg-source-7_5.1.9-0_deb12u1`, and in the Debian snapshot archive:

- <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9-0%2Bdeb12u1.dsc>
- <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9.orig.tar.xz>
- <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9-0%2Bdeb12u1.debian.tar.xz>

**Self-built images** get `ffmpeg` straight from Debian, possibly a newer
revision. Check it with `docker compose exec worker dpkg-query -W ffmpeg` and
find its source under <https://snapshot.debian.org/package/ffmpeg/>.

## libvips (web and worker images)

Image processing uses the prebuilt libvips from `sharp`'s `@img/sharp-libvips-*`
packages, licensed under the **GNU LGPL version 3 or later**. It stays a separate
shared library that `sharp` loads at runtime, so it can be replaced. The
`versions.json` beside the library names the exact versions. The source is at
<https://github.com/libvips/libvips>, tagged by that version, and the build
recipe is at <https://github.com/lovell/sharp-libvips>.

## rsync (backup image)

The **backup** image installs Alpine's `rsync` package, licensed under the
**GNU GPL version 3 or later**. Liedmotif runs it as a separate program, so
Liedmotif's own license is unaffected. The source is at
<https://download.samba.org/pub/rsync/src/>, and Alpine's build recipe and patches
are at <https://gitlab.alpinelinux.org/alpine/aports/-/tree/master/main/rsync>, on
the branch of the image's Alpine release.
