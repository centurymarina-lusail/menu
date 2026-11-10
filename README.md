# Century Marina Hotel · digital menu

A QR-code menu for the hotel's three restaurants, with a private page for the
hotel to manage it. Everything is plain HTML, CSS and JavaScript: no build step.

| Address | What it is |
| --- | --- |
| `/` | The guest menu. This is the address behind the QR code. |
| `/admin/` | The menu manager. Username and password required. |

## What is in this folder

```
index.html            guest menu (hotel page, restaurant pages, section pages)
assets/menu.css       the four looks: hotel, 24 North, The 4 Regions, Knife
assets/menu.js        draws the menu from data/menu.json
assets/logos/         hotel and restaurant logos (SVG)
assets/fonts/         web fonts, hosted with the site
data/menu.json        every restaurant, section, product and price
images/               product photos uploaded from the menu manager
admin/                the menu manager
admin/auth.json       created by the first-time setup (encrypted, see below)
```

## Putting it online with GitHub Pages

1. Create a **public** repository and upload everything in this folder to it.
2. Repository **Settings → Pages → Build and deployment**: choose
   *Deploy from a branch*, branch `main`, folder `/ (root)`, then Save.
   After a minute the menu is live at `https://OWNER.github.io/REPOSITORY/`.
3. Create the access key the menu manager uses to save changes:
   GitHub **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
   - Repository access: *Only select repositories* → this repository.
   - Permissions → Repository permissions → **Contents: Read and write**.
   - Pick an expiry date and note it: when the key expires, the menu manager
     stops saving until a new key is set (step 4 again, at `/admin/?setup`).
4. Open `https://OWNER.github.io/REPOSITORY/admin/`. The first visit shows
   **First-time setup**: paste the key, choose the username and password the
   hotel will use, and press *Create the login*.
5. In the menu manager press **QR code** to download the code for printing.

## How the login works

GitHub Pages has no server, so there is nothing that can check a password in
the usual way. Instead, the setup step encrypts the access key with the
username and password (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM) and
saves the result in `admin/auth.json`. Logging in decrypts the key in the
browser; a wrong password simply fails to decrypt.

- Guests can only read the menu. Saving needs the key, and GitHub itself
  refuses any change without it.
- `admin/auth.json` is public like the rest of the site, so the password is
  the only protection: use a long one (the form requires 10 characters).
- To change the password: account menu → *Change password*.
- To lock everyone out immediately: delete the token on GitHub.

## Using the menu manager

Restaurant → section → **Add product**: photo, title, description, price,
then **Publish**. Open any product to change its price, text or photo, to
mark it *not available today*, or to delete it. Sections can be added,
renamed and deleted from the restaurant page. Changes reach the guest menu
about a minute after publishing (the time GitHub Pages takes to refresh).

## Moving to the hotel's own server later

The guest menu works on any web server as it is: copy the folder.
The menu manager saves through GitHub, so on another server it needs a small
save script on that server in place of `GitHub` in `admin/admin.js`
(read a file, write a file, delete a file, behind a server-side login).
