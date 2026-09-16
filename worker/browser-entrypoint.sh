#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
PROFILE_DIR="${LINKEDIN_PROFILE_DIR:-/data/linkedin-profile}"

Xvfb "$DISPLAY" -screen 0 1440x1000x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

sleep 1

websockify --web=/usr/share/novnc 7900 localhost:5900 >/tmp/novnc.log 2>&1 &

# Chromium leaves these singleton files behind when a container is stopped abruptly.
# The browser service owns this persistent profile, so remove only stale lock files
# immediately before starting the single Chromium process.
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonSocket"

exec npx tsx worker/linkedin-browser.ts
