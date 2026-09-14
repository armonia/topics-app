# The Linux machine this repository does not have. WebKitGTK cannot be measured
# from a Mac and CI is not a place to iterate, so the probe brings its own
# machine: one container, one Xvfb, one run.
#
#   docker build -t gtkzprobe tools/gtkzprobe && docker run --rm gtkzprobe
#
# Debian bookworm is the oldest distribution carrying webkit2gtk-4.1, which is
# the ABI wry 0.55 links against (soup3). Anything newer moves the version the
# probe measures further from what a user's desktop actually ships.
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libx11-dev \
      xvfb \
      xauth \
    && rm -rf /var/lib/apt/lists/*

ENV CARGO_BUILD_JOBS=4
WORKDIR /probe
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

# Software rendering only: the container has no GPU, and WebKitGTK's DMABUF
# path fails on Xvfb instead of falling back.
ENV WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GDK_BACKEND=x11

# The sandbox needs namespaces the container does not hand out; the probe reads
# window stacking, not untrusted pages.
ENV WEBKIT_FORCE_SANDBOX=0

ENTRYPOINT ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24", "./target/release/gtkzprobe"]
CMD ["z"]
