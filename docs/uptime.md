# Uptime checks and the status page

**Operate → Uptime** checks your sites and services from the DeployNow server, the way
StatusCake or Pingdom do.

## Checks

- **HTTP(S):** requests a URL and follows redirects. It is up when the answer is 2xx or
  3xx, or one of the status codes you list (`200,204`), and, if you set one, when the
  page contains a keyword.
- **TCP:** opens a connection to `host:port`, for databases, mail servers and the like.
- **Interval:** 30 seconds to an hour. **Timeout:** 1 to 60 seconds.
- **Down after:** how many failed checks in a row count as down (2 by default), so a
  single slow answer doesn't wake anyone.
- **Certificates:** for HTTPS checks, DeployNow reads the certificate every 6 hours and
  warns once when it expires within the days you choose (14 by default). Let's Encrypt
  certificates renew 30 days ahead, so a warning usually means renewal is failing.

App domains without a check are listed under the checks, to add each in a click.

## Alerts

Notification channels (Settings → Notifications) can subscribe to:

| Event | When |
|---|---|
| `uptime.down` | the check failed the set number of times in a row |
| `uptime.up` | it answers again, with how long it was down |
| `uptime.cert` | the certificate expires soon |

Each change of state is sent once. Email through SMTP or Mailgun works for reports
to people outside the team.

## History

Every result is kept for 14 days: the chart shows response times over 1 hour to 14
days, with failures marked, plus the average and the 95th percentile. Daily totals are
kept for 90 days for the 7, 30 and 90 day uptime and the bars. Incidents record when a
check went down and came back.

## Public status page

Turn on the status page under Uptime and mark checks **Show on the status page**. It is
served at `https://<your DeployNow>/status`, without signing in, and shows each public
check's name, state, 90 days of daily bars and the incidents of the last 14 days. It
never shows the URLs or hosts being checked. The same data is at `GET /api/status`.

It is served on DeployNow's own address (or its domain, see Settings → Domain). A
separate domain just for the status page is not built in yet.

## Notes

- Checks run from the DeployNow container, so an internal address (`http://10.0.0.5`)
  works if DeployNow can reach it, and a check of a public site also tests DNS and the
  route from DeployNow's network.
- Up to 500 checks, run 10 at a time.
