# Railway Deployment Guide

## ✅ Setup Complete

The backend is now configured for Railway deployment with:
- `railway.toml` - Explicit build configuration
- Updated `start` script to use correct compiled file path
- Build command: `pnpm install && pnpm run build`
- Start command: `pnpm start`

## 🚀 Deploy to Railway

### 1. Connect Your Repository

1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose this repository
5. Select the `backend` folder as the root directory

### 2. Configure Environment Variables

Add these environment variables in Railway's dashboard:

#### Required Variables

**Database:**
- `DATABASE_URL` - Your PostgreSQL connection string (Railway can provision this)

**Authentication:**
- `BETTER_AUTH_SECRET` - 32+ character random string
- `BETTER_AUTH_URL` - Your Railway backend URL (e.g., `https://your-app.railway.app`)
- `COOKIE_DOMAIN` - Leave empty/unset for cross-origin deployments (Railway + Vercel)

**Email (Resend):**
- `RESEND_API` - Your Resend API key
- `RESEND_FROM_EMAIL` - Your verified sender email

**Server:**
- `PORT` - Railway will auto-set this, or use `8080`
- `FRONTEND_URL` - Your frontend URL

**Facebook/Instagram:**
- `FACEBOOK_APP_ID` - Your Facebook app ID
- `FACEBOOK_APP_SECRET` - Your Facebook app secret
- `FACEBOOK_REDIRECT_URI` - Your Railway callback URL
- `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` - Random string for webhook verification

**AI Services:**
- `GROQ_API_KEY` - Your Groq API key
- `JINA_API_KEY` - Your Jina AI API key

**AWS S3:**
- `AWS_ACCESS_KEY_ID` - Your AWS access key
- `AWS_SECRET_ACCESS_KEY` - Your AWS secret key
- `AWS_REGION` - AWS region (e.g., `us-east-1`)
- `S3_BUCKET_NAME` - Your S3 bucket name

**Billing:**
- `AUTUMN_SECRET_KEY` - Your Autumn billing API key

**Optional (for production):**
- `USE_HTTPS` - Set to `true`
- `NODE_ENV` - Already set to `production` in railway.toml

### 3. Add PostgreSQL Database

1. In your Railway project, click "New"
2. Select "Database" → "PostgreSQL"
3. Railway will automatically set `DATABASE_URL` in your service

### 4. Deploy

1. Push your code to GitHub:
   ```bash
   git add .
   git commit -m "Configure Railway deployment"
   git push
   ```

2. Railway will automatically:
   - Detect the build configuration
   - Install dependencies with pnpm
   - Build TypeScript files
   - Start your application

### 5. Monitor Deployment

- Watch the build logs in Railway dashboard
- Check for any missing environment variables
- Verify the health check endpoint

## 🔧 Troubleshooting

### Build Fails
- Check that all environment variables are set
- Review build logs for missing dependencies
- Ensure `pnpm-lock.yaml` is committed

### App Crashes on Start
- Verify `DATABASE_URL` is set and accessible
- Check that `BETTER_AUTH_SECRET` is set
- Review runtime logs for specific errors

### Database Connection Issues
- Ensure PostgreSQL service is provisioned
- Verify `DATABASE_URL` format is correct
- Check network connectivity in Railway settings

## 📝 Post-Deployment

1. **Update Instagram Webhook URL:**
   - Go to Facebook Developer Dashboard
   - Update webhook callback URL to your Railway URL
   - Example: `https://your-app.railway.app/api/webhooks/instagram`

2. **Update OAuth Redirect URIs:**
   - Update `FACEBOOK_REDIRECT_URI` to match Railway URL
   - Update in Facebook App settings

3. **Test the deployment:**
   ```bash
   curl https://your-app.railway.app/health
   ```

## 🔄 Continuous Deployment

Railway automatically redeploys when you push to your connected branch:
```bash
git add .
git commit -m "Your changes"
git push
```

## 📊 Monitoring

- View logs: Railway Dashboard → Your Service → Logs
- Metrics: Railway Dashboard → Your Service → Metrics
- Health checks: Set up in Railway settings
