## Adobe IMS credentials

This extension talks to the Reactor API as a **Server-to-Server** client — no browser login.

You need two values from your project in the
[Adobe Developer Console](https://developer.adobe.com/console):

| Value | Looks like |
| --- | --- |
| Client ID | `a1b2c3d4e5f6…` |
| Client Secret | `p8e-…` |

**Sign in** stores both in VS Code's Secret Storage — they never touch your
workspace or source control.

> Already keeping them in a `.env` at the workspace root as
> `ADOBE_CLIENT_ID` / `ADOBE_CLIENT_SECRET`? The extension picks those up
> automatically, so you can skip this step.

If sign-in fails, the credential's product profile in the Developer Console
probably lacks access to a Launch company.
