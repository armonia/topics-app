#!/bin/bash
# Start Topics Electron App

cd "$(dirname "$0")"

# Check if server is running
if ! curl -s http://localhost:3333/api/topics > /dev/null 2>&1; then
    echo "⚠️  Topics server not running on port 3333"
    echo "Starting server..."
    cd ..
    nohup bun run server.ts > /tmp/topics-server.log 2>&1 &
    sleep 2
    cd electron-app
    echo "Server started"
fi

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start Electron app
echo "Starting Topics Electron App..."
echo "CDP will be available at http://127.0.0.1:19333"
npm start
