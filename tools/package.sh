#!/bin/sh
# Builds the zip uploaded to the Chrome Web Store: exactly what the extension runs,
# nothing else. The icon source, store copy and README stay out.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/plain-translate-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json LICENSE _locales icons/*.png ./*.js ./*.css options.html -x '*.DS_Store'
echo "$out"
unzip -l "$out" | tail -1
