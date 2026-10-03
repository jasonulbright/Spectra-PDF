#!/bin/sh
# The AppImage's start script: sharun (AppRun) runs it with the host's shell.
# quick-sharun keeps an AppRun.sh that is already in the AppDir.
# Every expansion is quoted: dash before 0.5.11 field-splits the operand of
# `export`, so a PATH holding a space would abort the start under set -e.

if [ "$APPRUN_DEBUG" = 1 ]; then
        set -x
fi

set -e

MAIN_BIN=spectrapdf
ARG0="${ARGV0:-$0}"
unset ARGV0

PATH="$APPDIR/bin:$PATH"
export ARG0 APPDIR PATH

if [ -f "$APPDIR"/AppRun.lib ]; then
        . "$APPDIR"/AppRun.lib
        for hook in "$APPDIR"/bin/*.hook; do
            [ -e "$hook" ] || continue
            . "$hook"
        done
fi

if [ -f "$APPDIR/bin/${ARG0##*/}" ]; then
        TO_LAUNCH="$APPDIR/bin/${ARG0##*/}"
elif [ -n "$1" ] && [ -f "$APPDIR/bin/$1" ]; then
        TO_LAUNCH="$APPDIR/bin/$1"
        shift
else
        TO_LAUNCH="$APPDIR/bin/$MAIN_BIN"
fi

exec "$TO_LAUNCH" "$@"
