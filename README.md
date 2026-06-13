# FT Notifier

FT Notifier is a Discord bot for TikTok agencies. It checks your agency members and posts in a Discord channel when one of them goes live, including:

- who is live
- the TikTok LIVE caption/title
- a direct link to join the stream

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in:

```bash
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_GUILD_ID=your_discord_server_id_here
```

`DISCORD_GUILD_ID` is optional, but recommended while setting up because guild slash commands appear immediately. Without it, Discord global slash commands can take a while to appear.

3. Start the bot:

```bash
npm start
```

4. In Discord, run:

```text
/setchannel channel:#your-live-alerts-channel
/addmember username:creator_one display_name:Creator One
```

To add everyone at once, use:

```text
/addmembers members:creator_one:Creator One, creator_two:Creator Two
```

The bot stores the selected channel in `config.json` and tracked creators in `members.json`.

## Discord Bot Setup

Create the bot in the Discord Developer Portal, then invite it to your server with:

- `bot` scope
- `applications.commands` scope
- `Send Messages`
- `Embed Links`
- `View Channels`

The bot only needs the `Guilds` intent.

## Discord Commands

- `/setchannel` - sets the channel where TikTok LIVE alerts are sent.
- `/addmember` - adds or updates one TikTok member.
- `/addmembers` - bulk adds members using a comma or newline-separated list. Use `username` or `username:Display Name`.
- `/removemember` - removes one TikTok member.
- `/listmembers` - shows the current tracked member list.
- `/checknow` - runs a LIVE check immediately.

Commands require the Discord `Manage Server` permission.

## Railway Deployment

1. Push this project to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Add these Railway variables:

```bash
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_GUILD_ID=your_discord_server_id_here
CHECK_INTERVAL_SECONDS=60
```

4. Railway will run:

```bash
npm start
```

The project asks Railway for Node 22+ through `package.json`.

For production on Railway, you will need persistence for `config.json` and `members.json` if you want command changes to survive redeploys. The quickest option is a Railway volume mounted to the app directory. A later database-backed config store would also work cleanly.

## Local Member Storage

TikTok members are stored in `members.json` and managed with `/addmember`, `/addmembers`, and `/removemember`. For local testing, you can also create `members.json` from `members.example.json`:

```json
[
  {
    "username": "creator_one",
    "displayName": "Creator One"
  }
]
```

On Railway later, keep `members.json` and `config.json` on persistent storage, such as a Railway volume mounted to the app directory, so command changes survive redeploys.

## Notes

TikTok does not provide a stable public LIVE API for this use case. This project uses `tiktok-live-connector`, which relies on TikTok's web data and may need updates if TikTok changes how LIVE pages work.

If anonymous TikTok checks start failing, add `TIKTOK_SESSION_ID` and `TIKTOK_TT_TARGET_IDC` from a TikTok browser session as Railway variables. Keep them private.
