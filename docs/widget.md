# The embeddable chat widget

Every bot can be put on a website as a chat bubble, or shared as a stand-alone chat page. Visitors don't sign in:
they get answers from the bot's **public** documents only (documents marked "staff" are never used).

## Install

1. In the console, open the bot and go to **Embed & branding**.
2. Under **Allowed websites**, add each address the bubble may appear on, one per line, then **Save changes**:
   - `https://www.example.com`: that exact site
   - `https://*.example.com`: every subdomain of example.com
   - in self-hosted mode, `http://localhost:8080` works for local testing (SaaS mode requires `https`)
3. Copy the embed code and paste it just before `</body>` on your pages:

```html
<script src="https://<your-lumen-host>/widget.js" data-bot="pk_live_…" async></script>
```

To try the bubble before adding it to a website, click **Open test page** on the same tab: a sample page served by
Lumen with the bubble on it. It needs no allowed-website entry.

The **shareable chat page** link (`https://<your-lumen-host>/b/pk_live_…`) works without any website; it can be
turned off on the same tab.

### Options

| Attribute       | Effect                                                      |
| --------------- | ----------------------------------------------------------- |
| `data-bot`      | Required: the bot's public key                              |
| `data-position` | `bottom-right` or `bottom-left`, overriding the bot setting |
| `data-open`     | `true` opens the chat as soon as the page loads             |

## JavaScript API

```js
Lumen.open();
Lumen.close();
Lumen.toggle();
Lumen.on("open", () => {});
Lumen.on("close", () => {});
Lumen.on("message", () => {}); // a new answer arrived while the chat was closed
```

## How it is protected

- **Domains:** the chat runs in an iframe served by Lumen with a `Content-Security-Policy: frame-ancestors` header
  listing your allowed websites. Browsers refuse to show it anywhere else.
- **Visitor sessions:** each visitor gets a short-lived signed token (2 hours by default, `WIDGET_TOKEN_TTL_MIN`),
  renewed automatically. No cookies are used.
- **Limits:** per IP 30 new sessions a minute; per visitor 10 messages a minute and 200 a day; per bot 120 messages a
  minute. Conversations are limited to 20 questions, after which the visitor starts a new one.
- **Monthly cap:** optionally limit how many answers a bot gives visitors each month, to protect your model
  provider bill. When it's reached the chat says it's unavailable until next month.

## Privacy

Lumen stores each visitor conversation (questions, answers, cited document titles, 👍/👎) against a random visitor
id kept in the visitor's browser storage. No names, emails or IP addresses are stored. Conversations appear on the
bot's **Conversations** tab, labelled "widget" or "hosted".

## Troubleshooting

- **"Refused to display … in a frame"** in the browser console: the page's address isn't in **Allowed websites**.
  Check the scheme (`https` vs `http`), the `www.` prefix and the port.
- **No bubble on an HTML file opened from your computer** (`file:///…`): browsers give such files no web address, so
  the bubble can't be allowed there. Use **Open test page**, or serve the folder with a local web server, e.g.
  `python3 -m http.server 8080`, and allow `http://localhost:8080` (self-hosted installs only).
- **No bubble appears:** check the script tag's `data-bot`, that the bot's "Chat bubble on websites" switch is on,
  and that `/widget.js` loads (Network tab).
- **"This assistant is unavailable right now":** the monthly cap has been reached, or the bot has no chat model.
