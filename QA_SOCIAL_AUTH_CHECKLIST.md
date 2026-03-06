# Social Auth QA Checklist

Use this checklist on production after each auth-related deploy.

## Environment
- [ ] `GOOGLE_CLIENT_ID` is set in backend environment.
- [ ] `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` are set in backend environment.
- [ ] `MICROSOFT_CLIENT_ID` is set in backend environment.
- [ ] Frontend `netlify-config.js` has matching social provider IDs.

## Google
- [ ] Click `Continue with Google` opens account selector.
- [ ] Successful login returns to app and signs user in.
- [ ] Existing account signs in without duplicate user creation.
- [ ] App shows clear message if OAuth origin is misconfigured.

## Facebook
- [ ] Click `Continue with Facebook` opens Facebook auth dialog.
- [ ] Successful login returns to app and signs user in.
- [ ] Email is present in the returned profile.
- [ ] App shows clear message if app is not Live / token invalid.

## Microsoft (Auth Code + PKCE)
- [ ] Click `Continue with Microsoft` opens Microsoft auth dialog.
- [ ] Authorization code is returned to popup redirect.
- [ ] Token exchange succeeds and returns access token.
- [ ] Backend accepts token and signs user in.
- [ ] App shows clear message for Azure misconfiguration (redirect URI, client type).

## Session behavior
- [ ] After social sign-in, user stays authenticated on refresh.
- [ ] `auth_token`, `user_email`, `user_name`, `user_logged_in` are saved.
- [ ] Logout clears auth session and social-protected routes behave correctly.

## API sanity
- [ ] `GET /api/health` returns success.
- [ ] `POST /api/auth/oauth` returns success for valid provider tokens.
- [ ] `POST /api/auth/oauth` returns friendly errors for invalid tokens.
