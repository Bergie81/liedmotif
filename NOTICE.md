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

The Liedmotif **worker** Docker image installs the Debian package `ffmpeg`
(**`7:5.1.9-0+deb12u1`**, Debian 12 "bookworm"), a shared distro build compiled
with `--enable-gpl` and licensed under the **GNU GPL version 2 or later** (see
the package's license breakdown retained in-image at
`/usr/share/doc/ffmpeg/copyright`). The image is built for `linux/amd64` and
`linux/arm64`, and both arches carry this same package version, built by Debian
from the same source.

Debian's build configuration differs per arch, so each arch has its own
reviewed flag list:

- **amd64** — `docker/ci/ffmpeg-buildconf-expected-amd64.txt`.
- **arm64** — `docker/ci/ffmpeg-buildconf-expected-arm64.txt`. The same flags
  except `--arch`, `--libdir` and `--incdir`, which name the arm64 paths, and
  no `--enable-libmfx` (Intel Media SDK exists only on x86). Neither difference
  changes the license: both are `--enable-gpl` builds of the same source.

Liedmotif invokes the `ffmpeg` binary **exclusively as a separate child
process** (bounded `execFile` calls for loudness measurement and PCM decoding —
see `apps/worker/src/audio/ffmpeg.ts`). Liedmotif does not link against FFmpeg
libraries, statically or dynamically; this is mere aggregation, and Liedmotif's
own license is unaffected.

### Corresponding source

The exact corresponding source for the pinned package version is permanently
retained by the Debian snapshot archive:

- `.dsc`:
  <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9-0%2Bdeb12u1.dsc>
- `.orig` tarball:
  <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9.orig.tar.xz>
- `.debian` tarball:
  <https://snapshot.debian.org/archive/debian-security/20260515T212054Z/pool/updates/main/f/ffmpeg/ffmpeg_5.1.9-0%2Bdeb12u1.debian.tar.xz>
- Package/version index (same artifacts, browsable):
  <https://snapshot.debian.org/package/ffmpeg/7%3A5.1.9-0%2Bdeb12u1/>

**Published images.** Each release publishes prebuilt worker images to
`ghcr.io/bergie81/liedmotif-worker`, which makes Liedmotif a distributor of this
ffmpeg build. The exact corresponding source is therefore published on this
repository's GitHub releases page, as its own prerelease per pinned version:
`ffmpeg-source-7_5.1.9-0_deb12u1` for the pin above (the tag writes `:` and `+`
as `_`). It holds the `.dsc`, the `.orig` tarball with its upstream signature,
and the `.debian` tarball, and every Liedmotif release's notes link it. The
release workflow (`.github/workflows/release.yml`) publishes it once per pin,
before it pushes any worker image, so even an image from a release that fails a
later check never goes out without its source. It fetches the files from Debian
with `apt-get source` for the version in `docker/ci/ffmpeg-pin.txt`, and apt
verifies each file against Debian's signed index. A prerelease never becomes
the repository's latest release, so the installer never mistakes it for a
Liedmotif release. A release cannot publish an image whose ffmpeg differs from
that pin: the worker smoke below runs on both arches before anything is
pushed.

**Locally built images.** A self-hoster who builds the worker image
(`docker compose up --build`) gets the binary package straight from Debian's
repositories, and Debian is the distributor of record. That install is
deliberately unpinned so self-built images keep receiving Debian's security
updates; a rebuild after a Debian point update
may therefore install a **newer revision** than the pin above — check the
actual version with `docker compose exec worker dpkg-query -W ffmpeg`, and find
its corresponding source under `https://snapshot.debian.org/package/ffmpeg/`.

The worker ffmpeg smoke (`docker/ci/ffmpeg-smoke.mjs`) asserts the installed
package version matches `docker/ci/ffmpeg-pin.txt` and that the build
configuration matches the image's arch file above. CI's `worker-image` job runs
it on amd64; the release workflow runs it on amd64 and arm64. Version drift
therefore surfaces in CI, and bumping the pin requires updating this notice's
version, source URLs and source release tag in the same change.

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
