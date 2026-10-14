# Microsoft sign-in setup

Outlook.com, Hotmail, and Microsoft 365 accounts sign in with OAuth, and mail, calendars, and contacts go through Microsoft Graph (see [ADR-0014](decisions/0014-microsoft.md)). Microsoft requires every app that does this to be registered. This page covers:

- **Registering your own app.** Works today, for personal and work or school accounts.
- **Publishing for everyone.** What a public release needs.

Microsoft renames these screens often. The steps say what each one is for, so you can find it if the label changes.

## Register your own app

1. **Open App registrations** in the [Microsoft Entra admin center](https://entra.microsoft.com/) → Applications → App registrations → **New registration**.
   - A free personal Microsoft account works. Microsoft creates a directory for you on first visit.
2. **Name:** anything, for example "Mailbird (personal)".
3. **Supported account types:** **Accounts in any organizational directory and personal Microsoft accounts**.
4. **Redirect URI:**
   - **Platform:** Public client/native (mobile & desktop).
   - **URI:** `http://localhost`. Microsoft ignores the port for `localhost`, and the app picks a free port each time.
5. **Register**, then copy the **Application (client) ID** from the Overview page.
6. **Authentication → Advanced settings:** turn on **Allow public client flows**.
   - There's no client secret to make. An installed app can't keep one, and PKCE protects the sign-in instead.
7. **API permissions → Add a permission → Microsoft Graph → Delegated:**
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `Calendars.ReadWrite`
   - `Contacts.ReadWrite`
   - `offline_access`, `openid`, `email`, `profile` (usually already there as `User.Read`'s companions)
8. **Add it to the app:** Accounts → **Outlook / Microsoft 365** → paste the ID → **Save app registration** → **Continue in browser**.

What to expect:

- **A consent page** listing the permissions above. Personal accounts approve it themselves.
- **Work or school accounts** may need an administrator to approve the app first ("Need admin approval"). That's the organization's policy, not an error in the app.
- **Your account picker.** The app asks Microsoft to let you choose the account, so a browser signed in to several doesn't pick one silently.
- **Sign-ins last.** Microsoft refresh tokens are renewed on each use. An account that sits unused for about 90 days, or whose password changes, shows **Sign in again**.

### Bake a registration into a build

```sh
MAILBIRD_MICROSOFT_CLIENT_ID=… pnpm tauri build
```

A registration someone adds in the app always takes precedence over the built-in one.

## Removing an account

Microsoft has no way for an app to revoke its own sign-in. Removing the account deletes its tokens from this device. To revoke access everywhere:

- **Personal accounts:** [account.live.com/consent/Manage](https://account.live.com/consent/Manage).
- **Work or school accounts:** [myapps.microsoft.com](https://myapps.microsoft.com) → the app → **Revoke**.

## Why these permissions

| Permission | What the app does with it |
|---|---|
| `Mail.ReadWrite` | Reads mail, and sets read, flagged, and archived (a move to the Archive folder). It never deletes mail. |
| `Mail.Send` | Sends the message the app built, as MIME, so Outlook files the Sent copy itself. |
| `Calendars.ReadWrite` | Reads and writes your calendars, one-off edits to recurring events, and replies to invitations. |
| `Contacts.ReadWrite` | Reads and writes your contacts. |
| `offline_access openid email profile` | Keeps you signed in, and shows your name and address in the account list. |

## Publishing for everyone

Unlike Google's restricted Gmail scopes, these permissions need no security assessment. A public release needs:

- [ ] **One registration for the app**, baked into release builds.
- [ ] **Publisher verification:** a Microsoft Partner Network account tied to a verified domain. Without it, the consent page says "unverified".
- [ ] **A homepage and privacy policy** linked from the registration's Branding page. They depend on the rename in [ADR-0006](decisions/0006-product-name.md).
- [ ] **Optional, for organizations:** Microsoft 365 app certification. Some admins require it before approving an app.
