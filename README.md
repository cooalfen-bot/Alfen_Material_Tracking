# Alfen Material Tracking

Site material management for Alfen Exclusive Doors & Windows. Material is tracked against a job number (`JO0XXXXX`) through three stages, with photos at each one:

1. **Booked from factory**: driver, vehicle, date and time, material list (Excel/CSV upload or typed), loading photos.
2. **Received at site**: who received it (name, mobile, photo) or the driver when no site person is available, unloading team confirmation, problem items ticked from the booked list, photos.
3. **Verified by the fitting team**: packing check before opening, item-by-item OK / Damaged / Short, photos.

Roles: **Admin**, **Manager**, **Store in charge** (book and track), **User** (site receiver, driver, fitting team, job viewer). Users pick their job from a dropdown. Works on desktop and mobile, and installs on a phone like an app.

## How it is built

- `public/` is the web app (one HTML file, plus manifest, icons and service worker for phone install).
- `api/` holds two Vercel serverless functions. All permissions are checked on the server.
- Data (users, jobs) and photos are stored in **Upstash Redis**. Photos are compressed to about 150 KB and kept in Redis, behind login.
- Sign in is a 10-digit mobile number plus a 4 to 6 digit PIN. PINs are stored hashed (scrypt).
- `claude-artifact/` is the earlier version that runs inside claude.ai only. It is kept for reference.

## Set up on Vercel (one time, about 5 minutes)

1. Open the project on Vercel, go to the **Storage** tab, choose **Create Database**, pick **Upstash for Redis** from the Marketplace, and connect it to this project (all environments). Vercel adds the connection variables automatically (`KV_REST_API_URL` and `KV_REST_API_TOKEN`).
2. Go to **Deployments** and **Redeploy** the latest deployment so the variables are picked up.
3. Open the site. The first screen asks you to create the admin account. After that, add managers, store in charge and users from the **Team** page.
4. Optional: add an `AUTH_SECRET` environment variable (any long random text) to control the key that signs login sessions.

## Put it on every phone

Open the site address in Chrome (Android) or Safari (iPhone), then choose **Add to Home Screen** (Android also shows an Install button inside the app). Send the address and each person's mobile number and PIN.

## Test

`npm test` runs the API checks against an in-memory Redis stand-in. It needs no accounts.
