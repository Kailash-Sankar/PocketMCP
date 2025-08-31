#!/bin/bash

echo "🚀 Setting up PocketMCP..."

# Check if .env already exists
if [ -f ".env" ]; then
    echo "⚠️  .env file already exists. Backing it up as .env.backup"
    cp .env .env.backup
fi

# Copy .env.sample to .env
cp .env.sample .env

echo "✅ Created .env file from .env.sample"
echo ""
echo "📝 Next steps:"
echo "1. Edit .env file to customize your configuration"
echo "2. Run 'pnpm install' to install dependencies"
echo "3. Run 'pnpm dev' to start development server"
echo "4. Run 'pnpm dev:watch' to enable file watching"
echo ""
echo "🔧 Available scripts:"
echo "  pnpm dev         - Start development server"
echo "  pnpm dev:watch   - Start with file watching enabled"
echo "  pnpm dev:verbose - Start with verbose logging"
echo "  pnpm start       - Start production server"
echo "  pnpm clean       - Clean build and database files"
