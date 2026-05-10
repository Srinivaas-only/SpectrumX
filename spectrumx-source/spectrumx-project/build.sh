#!/bin/bash
# ============================================================
# SpectrumX Build Script
# Packages the extension into a distributable folder structure
# that Chrome can load as an unpacked extension.
# ============================================================

set -e

BUILD_DIR="dist"
SRC_DIR="src"
PUBLIC_DIR="public"

echo "⚡ Building SpectrumX..."
echo ""

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/icons"

# Copy manifest
cp "$PUBLIC_DIR/manifest.json" "$BUILD_DIR/"

# Copy icons
cp "$PUBLIC_DIR/icons/"*.png "$BUILD_DIR/icons/" 2>/dev/null || echo "⚠ No icons found, continuing..."

# ---- Background Service Worker ----
# Chrome MV3 service workers can't use ES modules in all cases,
# so we inline the required code
echo "  → Building background.js"
cp "$SRC_DIR/background/background.js" "$BUILD_DIR/background.js"
cp "$SRC_DIR/background/deepscan.js" "$BUILD_DIR/deepscan.js"

# ---- Offscreen Document (for DeepScan DOM parsing) ----
echo "  → Building offscreen document"
cp "$PUBLIC_DIR/offscreen.html" "$BUILD_DIR/offscreen.html"
cp "$SRC_DIR/background/offscreen.js" "$BUILD_DIR/offscreen.js"

# ---- Content Script ----
echo "  → Building content script"
cp "$SRC_DIR/content/content.js" "$BUILD_DIR/content.js"
cp "$SRC_DIR/content/content.css" "$BUILD_DIR/content.css"

# ---- Shared Data Module ----
# Since popup and sidepanel use ES modules, we copy the shared module
echo "  → Building shared modules"
mkdir -p "$BUILD_DIR/shared"
cp "$SRC_DIR/shared/data.js" "$BUILD_DIR/shared/data.js"

# ---- Popup (Smart Dashboard) ----
echo "  → Building popup (Smart Dashboard)"
cp "$SRC_DIR/popup/popup.html" "$BUILD_DIR/popup.html"
cp "$SRC_DIR/popup/popup.css" "$BUILD_DIR/popup.css"

# Fix import path in popup.js (adjust relative path)
sed 's|../shared/data.js|./shared/data.js|g' "$SRC_DIR/popup/popup.js" > "$BUILD_DIR/popup.js"

# ---- Side Panel (AI Chatbot) ----
echo "  → Building sidepanel (AI Chatbot)"
cp "$SRC_DIR/sidepanel/sidepanel.html" "$BUILD_DIR/sidepanel.html"
cp "$SRC_DIR/sidepanel/sidepanel.css" "$BUILD_DIR/sidepanel.css"

# Fix import path in sidepanel.js
sed 's|../shared/data.js|./shared/data.js|g' "$SRC_DIR/sidepanel/sidepanel.js" > "$BUILD_DIR/sidepanel.js"

# ---- Fix HTML paths ----
# Popup HTML: fix CSS/JS paths (they're already relative, should be fine)
# Sidepanel HTML: same

# ---- Update manifest paths ----
# The manifest references files at the root of the extension
# Our build already places them there, so paths should match

# ---- Fix background.js ----
# Remove ES module imports since service workers need special handling
# The background.js doesn't import shared/data.js, so it's fine as-is

echo ""
echo "✅ Build complete! Output: ./$BUILD_DIR/"
echo ""

# List files
echo "📁 Extension contents:"
find "$BUILD_DIR" -type f | sort | while read f; do
  size=$(wc -c < "$f" | tr -d ' ')
  echo "   $f ($size bytes)"
done

echo ""
echo "📦 To install in Chrome:"
echo "   1. Go to chrome://extensions"
echo "   2. Enable 'Developer mode' (top right)"
echo "   3. Click 'Load unpacked'"
echo "   4. Select the '$BUILD_DIR' folder"
echo ""

# Create ZIP for distribution
cd "$BUILD_DIR"
zip -r "../spectrumx-v1.0.0.zip" . -x "*.DS_Store" > /dev/null 2>&1
cd ..
ZIP_SIZE=$(wc -c < "spectrumx-v1.0.0.zip" | tr -d ' ')
echo "📦 Also created: spectrumx-v1.0.0.zip ($ZIP_SIZE bytes)"
