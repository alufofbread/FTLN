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
- `/syncmembers` - refreshes the agency LIVE watchlist immediately.
- `/watchliststatus` - shows the last successful roster sync, errors and manual override counts.

### Automatic agency watchlist

The notifier syncs the Aether roster every 60 seconds when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured. The TVA report worker maintains the private `agency-live-watchlist/membership.json` feed, including TikTok's explicit departure notices. New roster members are added, and reported departures or removed/disabled roster accounts leave the automatic watchlist. This is agency roster/report synchronisation, not a TikTok membership API or an OAuth profile scope.

`/removemember` creates a persistent exclusion so the next sync does not add the creator back. `/addmember` clears that exclusion and can manually restore a creator if needed. A later agency departure clears an earlier manual pin for that creator. Manual entries unrelated to the roster are preserved. An explicit manual re-add after a departure stays until another relevant membership change or manual removal.

`/listmembers page:2` pages through the entire list. `/watchliststatus` exposes sync health without showing credentials. A failed or invalid roster response preserves the last saved list; a valid empty roster removes automatic members while keeping unrelated manual entries. No selected alert channel or agency-video setting is changed by roster sync.

Keep `watchlist-state.json` on the existing `/data` volume. It is the authoritative state; `members.json` remains a compatibility projection. On first startup the existing member file is backed up as `members.json.before-roster-sync`. Initial roster matches are adopted as automatic members so they can be removed correctly if they leave later. Run `npm test` for migration, override, restart, departure, rename, outage and private-feed checks.

Commands and autocomplete require Discord Administrator permission or a role named **Bot Controller** (case insensitive). Manage Server alone does not grant access. Commands use an application permission check so Bot Controllers need no additional server permissions. To hide commands from other members, restrict this application to Administrator and Bot Controller in Server Settings > Integrations, leaving the Support bot available to everyone. Restart the bot to sync command registration after deploying changes.

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

For production on Railway, attach a volume to this service mounted at `/data` and set `DATA_DIR=/data`. The bot stores `config.json`, `members.json` and `notification-state.json` there. It also recognizes Railway's `RAILWAY_VOLUME_MOUNT_PATH`. Deploy this updated code before using the new path. Existing files in the working directory are copied on first startup only when no destination file exists; existing volume data is never overwritten. Back up existing runtime files before replacing an older deployment, since files outside a volume may be lost on redeploy.

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

On Railway, use this service's own volume mounted at `/data`, with `DATA_DIR=/data`, so command changes survive redeploys. Keep one running instance per bot. Local runs without a data-directory setting continue to use the working directory.

## Notes

### Agency video uploads

`/setvideochannel channel:#agency-videos` sets a separate destination for new videos from **@aetheragencytt only**. The member LIVE watchlist is never used for video alerts. This feature remains inactive until a video channel and TikTok authorisation are configured.

After TikTok approves your application for Login Kit and Display API, authorise the **agency account** with `video.list`. Set `AGENCY_TIKTOK_CLIENT_KEY`, `AGENCY_TIKTOK_CLIENT_SECRET`, and `AGENCY_TIKTOK_REFRESH_TOKEN` in the deployment environment. Do not put credentials in Discord. An `AGENCY_TIKTOK_ACCESS_TOKEN` can be used for short-lived testing instead. See [TikTok Display API setup](https://developers.tiktok.com/docs/en/display-api-get-started).

The notifier checks the authorised video list at the existing check interval, validates every video URL against `@aetheragencytt`, and refuses feeds from other accounts. Its first successful check quietly records existing videos; subsequent checks announce new uploads with a link and caption. Failed API calls preserve state; failed Discord sends retry. Existing messages are recovered by a video-specific footer after an interrupted send. Give the bot Read Message History in the video destination for this recovery.

Keep `agency-video-state.json` and `agency-video-token.json` on the existing persistent volume. The token file contains credentials and must remain private. Refresh tokens rotate automatically; if TikTok revokes or expires authorisation, reconnect the agency account. Keep one running bot instance. Run `node --test src/agency-videos.test.js` to test account filtering and delivery without TikTok credentials.

TikTok does not provide a stable public LIVE API for this use case. This project uses `tiktok-live-connector`, which relies on TikTok's web data and may need updates if TikTok changes how LIVE pages work.

If anonymous TikTok checks start failing, add `TIKTOK_SESSION_ID` and `TIKTOK_TT_TARGET_IDC` from a TikTok browser session as Railway variables. Keep them private.
