RIFT RAIDERS — RENDER DEPLOY
This package is ready for a Node.js web service on Render.
Upload these files to a GitHub repository, then in Render choose New > Web Service,
connect the repository, select the free plan if offered, and deploy.
Build command: npm install
Start command: npm start
The app automatically uses Render's PORT and serves the game and WebSocket /ws
from the same https:// hostname. Open the deployed https:// URL (not the HTML file).
Create a lobby, choose a password, share the 6-character code and password.
The server is not deployed by this ZIP alone. Free services may sleep when idle.
