#!/bin/bash

# Chrome Extension Package Builder
# Builds a clean zip package for Chrome Web Store submission

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get current directory and extension name
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_NAME="sidemind"

# Read version from manifest.json for versioned package name
if [ -f "$SCRIPT_DIR/manifest.json" ]; then
    VERSION=$(grep -o '"version":\s*"[^"]*"' "$SCRIPT_DIR/manifest.json" | sed 's/.*"version":\s*"\([^"]*\)".*/\1/')
    PACKAGE_NAME="${EXTENSION_NAME}-v${VERSION}.zip"
else
    print_error "manifest.json not found!"
    exit 1
fi

# Create temporary directory for packaging
TEMP_DIR=$(mktemp -d)
PACKAGE_DIR="$TEMP_DIR/$EXTENSION_NAME"

print_status "Creating package for $EXTENSION_NAME version $VERSION"
print_status "Package name: $PACKAGE_NAME"

# Clean up any existing temporary directory on exit
trap 'rm -rf "$TEMP_DIR"' EXIT

# Create package directory
mkdir -p "$PACKAGE_DIR"

# Function to copy file or directory with status
copy_item() {
    local src="$1"
    local dest="$2"

    if [ -e "$src" ]; then
        cp -r "$src" "$dest"
        print_status "Added: $(basename "$src")"
    else
        print_warning "Not found: $src"
    fi
}

# Copy essential extension files
print_status "Copying essential extension files..."

# Core files
copy_item "$SCRIPT_DIR/manifest.json" "$PACKAGE_DIR/"
copy_item "$SCRIPT_DIR/background.js" "$PACKAGE_DIR/"

# Extension directories
copy_item "$SCRIPT_DIR/sidebar" "$PACKAGE_DIR/"
copy_item "$SCRIPT_DIR/options" "$PACKAGE_DIR/"
copy_item "$SCRIPT_DIR/icons" "$PACKAGE_DIR/"
copy_item "$SCRIPT_DIR/assets" "$PACKAGE_DIR/"

# Verify required files exist
REQUIRED_FILES=("manifest.json" "background.js")
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$PACKAGE_DIR/$file" ]; then
        print_error "Required file missing: $file"
        exit 1
    fi
done

# Verify required directories exist
REQUIRED_DIRS=("sidebar" "options" "icons")
for dir in "${REQUIRED_DIRS[@]}"; do
    if [ ! -d "$PACKAGE_DIR/$dir" ]; then
        print_error "Required directory missing: $dir/"
        exit 1
    fi
done

# Create zip package in the project root
ZIP_PATH="$SCRIPT_DIR/$PACKAGE_NAME"

# Check if zip file already exists and remove it
if [ -f "$ZIP_PATH" ]; then
    print_status "Removing existing package: $PACKAGE_NAME"
    rm -f "$ZIP_PATH"
fi

cd "$TEMP_DIR"

print_status "Creating zip package..."
zip -r "$ZIP_PATH" "$EXTENSION_NAME" -x "*.DS_Store" "*.git*" "*.tmp*"

# Verify zip was created
if [ ! -f "$ZIP_PATH" ]; then
    print_error "Failed to create zip package!"
    exit 1
fi

# Get file size for verification
PACKAGE_SIZE=$(du -h "$ZIP_PATH" | cut -f1)
FILE_COUNT=$(unzip -l "$ZIP_PATH" | tail -1 | awk '{print $2}')

print_status "Package created successfully!"
print_status "Package file: $ZIP_PATH"
print_status "Package size: $PACKAGE_SIZE"
print_status "Files included: $FILE_COUNT"

# Show package contents (optional)
echo
print_status "Package contents:"
unzip -l "$ZIP_PATH" | grep -v "Archive:" | grep -v "\-\-\-\-\-" | grep -v "^  Length" | tail -n +3

