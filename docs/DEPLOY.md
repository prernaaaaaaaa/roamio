# Deploying Roamio (free tier, about 20 minutes)

You need: a GitHub repo with this code, a Gemini API key, and free accounts on MongoDB Atlas and Render.
Never commit `server/.env`. Secrets go into Render's dashboard only.

## 1. Gemini API key
1. Go to https://aistudio.google.com/apikey and create a key.
2. Test locally first: put it in `server/.env` as `GEMINI_API_KEY=...`, run `npm run dev:server`, and check http://localhost:8080/api/health shows `"provider":"gemini"`.
3. If plans fail with a model-not-found error, set `GEMINI_MODEL` to a model id from https://ai.google.dev/gemini-api/docs/models (the app already falls back automatically on a 404).

## 2. MongoDB Atlas (accounts and saved trips)
1. Sign up at https://www.mongodb.com/atlas, create a **free M0** cluster.
2. **Database Access** → add a user (username + password, read/write any database). Use a password without `@ : / ?` characters.
3. **Network Access** → add IP `0.0.0.0/0` (Render's free tier has no fixed IP).
4. **Connect → Drivers** → copy the string and add the database name:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/roamio?retryWrites=true&w=majority`

## 3. Render (API and website in one service)
1. Sign up at https://render.com with GitHub.
2. **New → Blueprint** → select the `roamio` repo → Render reads `render.yaml`.
3. Fill the two prompted values: `GEMINI_API_KEY` and `MONGODB_URI`. `JWT_SECRET` is generated for you.
4. **Apply**. The first build takes 5 to 8 minutes (Docker build).
5. Open `https://<your-service>.onrender.com/api/health`. Expect:
   `"provider":"gemini"`, `"store":"mongo"`.
6. Open the site root, plan a trip, sign up, save a trip, refresh: it should still be there (proves Mongo works).

### If the build or boot fails
| Symptom in Render logs | Fix |
| --- | --- |
| `JWT_SECRET must be set in production` | Environment tab → add any 32+ character random string |
| `MongoServerSelectionError` | Atlas Network Access missing `0.0.0.0/0`, or wrong password in the URI |
| `provider: mock` in `/api/health` | `GEMINI_API_KEY` not set (or has spaces) |
| `429` / many fallbacks | Free key rate limit: lower `LLM_RPM` (try 5) |
| Build error | Copy the last 30 log lines and send them to me |

## 4. Optional: React on Vercel
1. Vercel → **Add New Project** → import the repo.
2. Root directory: `client`. Environment variable: `VITE_API_URL` = your Render URL (no trailing slash).
3. Deploy, then on Render set `CLIENT_ORIGIN` = your Vercel URL and redeploy.

## 5. After it is live
1. Run the real evaluation: `cd server && npm run eval -- --n 12 --judge` (with your key in `server/.env`).
2. Paste the numbers from `server/eval/RESULTS.md` into the README **Results** table.
3. Put the live URL at the top of the README and add 2 to 3 screenshots (`docs/screenshots/`).
4. Add the GitHub repo and live URL to your resume.

## Keep it awake (optional)
Render's free tier sleeps after 15 minutes. Before an interview, open the site once. Or use a free uptime monitor (UptimeRobot) pinging `/api/health` every 10 minutes.
