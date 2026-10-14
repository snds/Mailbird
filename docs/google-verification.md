# Google sign-in and verification

Gmail, Google Calendar, and Google Contacts sign in with OAuth (see [ADR-0013](decisions/0013-google.md)). Google requires every app that does this to be registered, and an app that reads Gmail to be verified before the public can use it. This page covers both:

- **Using your own OAuth client.** Works today, for you and up to 100 test users.
- **The verification checklist.** Needed before the app ships with a built-in client for everyone.

Google renames these console screens often. The steps say what each screen is for, so you can find it even if the label changes.

## Use your own OAuth client

1. **Create a project** in the [Google Cloud console](https://console.cloud.google.com/).
2. **Enable these APIs** (APIs & Services → Library):
   - Gmail API
   - CalDAV API
   - Google Contacts CardDAV API
3. **Set up the consent screen** (Google Auth Platform):
   - **User type:** External.
   - **Branding:** your app name and support email.
   - **Data access:** add these scopes:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/carddav`
     - `openid`, `email`, `profile`
   - **Audience:** leave the app in **Testing** and add your Google address as a test user.
4. **Create the client** (Clients → Create client):
   - **Application type:** **Desktop app**.
   - **Copy** the client ID and client secret.
5. **Add it to the app:** Accounts → **Gmail** → paste both → **Save client** → **Continue in browser**.

What to expect while the app is in Testing:

- **A warning page.** Google shows "Google hasn't verified this app". Choose **Continue** (it may be under **Advanced**) only for a copy of the app you built or trust.
- **Weekly sign-in.** Google expires refresh tokens for Testing apps after 7 days. The account then shows **Sign in again**; one click reconnects it, and no mail is lost.
- **Test users only.** Only the test users you listed can sign in.

### Bake a client into a build

To ship a build with a client, set these at compile time:

```sh
MAILBIRD_GOOGLE_CLIENT_ID=… MAILBIRD_GOOGLE_CLIENT_SECRET=… pnpm tauri build
```

A client someone adds in the app always takes precedence over the built-in one.

## Why these scopes

| Scope | Google's class | What the app does with it |
|---|---|---|
| `gmail.modify` | **Restricted** | Reads mail, and sets read, starred, and archived labels. It also sends mail through the Gmail API, so no SMTP password is needed. It **cannot** delete mail permanently, which the narrower scope rules out. |
| `calendar` | Sensitive | Reads and writes your calendars over CalDAV, including invitations and reminders. |
| `carddav` | Sensitive | Reads and writes your contacts over CardDAV. |
| `openid email profile` | Non-sensitive | Your name and address for the account list. |

`gmail.readonly` + `gmail.send` would be narrower, but they can't archive or mark mail read, which the app needs.

## Verification checklist (before a public release)

Verification of a restricted scope is Google's longest review. Plan for weeks, not days.

- [ ] **A verified domain.** The homepage and privacy policy must be on it (Search Console verification).
- [ ] **A homepage** that describes the app and links to the privacy policy.
- [ ] **A privacy policy** that names the Google data used, says where it's stored (on the device only), and includes Google's [Limited Use](https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes) statement.
- [ ] **Scope justifications:** one paragraph per scope, matching the table above.
- [ ] **A demo video** (unlisted on YouTube). It should show:
  - the consent screen with the client ID visible;
  - each scope in use (archive, read, send, a calendar edit, a contact edit);
  - account removal revoking access.
- [ ] **Brand review:** the app's name and logo can't suggest it's Google's. This depends on the rename in [ADR-0006](decisions/0006-product-name.md).
- [ ] **Security assessment:**
  - Restricted scopes normally require an annual third-party assessment (CASA).
  - Apps whose restricted data never leaves the user's device can qualify for an exemption. The desktop and mobile apps are built that way: mail goes from Google straight to the device, and no server of ours sees it.
  - Ask for the exemption during verification and confirm the current rule then.
  - A hosted web gateway would not qualify ([ADR-0004](decisions/0004-protocols.md)).
- [ ] **Publish** the consent screen (Audience → Publish app) only after approval.

## What the app already does for verification

- **Sign-in happens in the system browser** (RFC 8252), never in an embedded webview. It uses PKCE and a loopback redirect on `127.0.0.1`.
- **Tokens live in the OS keychain.** Mail stays in the local database. Nothing goes to a server of ours.
- **Removing an account revokes its tokens** with Google before deleting them.
- **The sign-in screen lists, in plain words, what Google will ask for.**
