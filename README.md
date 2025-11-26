cat << 'EOF' > README.md
# Fairloft SerpAPI Scraper

Firebase Cloud Function that scrapes Google Shopping using SerpAPI
every 6 hours and writes results to Firestore.
cat << 'EOF' > README.md
# Fairloft SerpAPI Scraper

Firebase Cloud Function that scrapes Google Shopping using SerpAPI
every 6 hours and writes results to Firestore.

## Commands
npm install
npm run build
firebase deploy --only functions

## Secrets
Add SERPAPI_KEY to Google Cloud Secret Manager.
For local emulator testing:
echo "SERPAPI_KEY=YOUR_KEY" > functions/.secret.local
