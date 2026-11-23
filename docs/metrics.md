# Container usage history and Prometheus

## What is recorded

Every minute DeployNow samples each running container on every online endpoint (socket, SSH, TLS or agent): CPU, memory (without page cache, like `docker stats`), network in and out, block device reads and writes, and the number of processes. DeployNow's own helper containers are skipped.

App containers are tracked by **app and service**, so a redeploy (which gives the container a new name) continues the same history. Other containers are tracked by name.

| Kept | For | Used by |
|---|---|---|
| One-minute samples | about 26 hours | the 1h, 6h and 24h views, and `/api/metrics` |
| Hourly rollups (average and peak CPU and memory, bytes moved) | 30 days by default | the 7d and 30d views |

With 20 hosts and 10 containers each that is about 290,000 raw rows and 144,000 hourly rows in SQLite, roughly 60 MB.

Settings (environment variables of the DeployNow container):

- `DEPLOYNOW_METRICS_RETENTION_DAYS`: how long hourly rollups are kept, 1 to 365. Default 30.
- `CONTAINER_METRICS=off`: stop sampling containers. Charts and `/api/metrics` then show what was recorded before.

## Where to see it

- **App page, Overview:** charts for CPU, memory, network and disk I/O, with averages, peaks and totals for the range (1h to 30d). Apps with several services can show one service or all of them added together. "Table" switches to the numbers.
- **Container page:** the same charts for one container.
- **Endpoint page:** every container on the machine with its average and peak CPU and memory and its traffic, busiest first.

The API behind these is in `/api/openapi.json`: `GET /api/apps/{id}/metrics`, `GET /api/endpoints/{id}/containers/{cid}/metrics` and `GET /api/endpoints/{id}/container-usage`, each with `?range=1h|6h|24h|7d|30d`.

## Prometheus and Grafana

`GET /api/metrics` returns Prometheus text format. It needs an API token (or a signed-in session) and only includes endpoints and projects the token's user can see.

1. Under **Account**, create an API token with scope **viewer** and no expiry (or rotate it as you like).
2. Add a scrape job to Prometheus:

```yaml
scrape_configs:
  - job_name: deploynow
    scheme: https
    metrics_path: /api/metrics
    scrape_interval: 60s   # samples change once a minute
    authorization:
      type: Bearer
      credentials: dn_xxxxxxxxxxxxxxxx   # or credentials_file: /etc/prometheus/deploynow-token
    static_configs:
      - targets: ["deploynow.example.com:9444"]
```

3. In Grafana, add Prometheus as a data source and import [grafana/deploynow-containers.json](grafana/deploynow-containers.json) (Dashboards, New, Import).

Grafana Cloud or any Prometheus-compatible agent (Grafana Alloy, VictoriaMetrics vmagent) works the same way: scrape `/api/metrics` with the bearer token.

### Metrics

Container metrics carry the labels `endpoint`, `container`, `app`, `project`, `environment` and `service` (the last four are empty for containers that aren't DeployNow apps).

| Metric | Type | Meaning |
|---|---|---|
| `deploynow_container_cpu_usage_seconds_total` | counter | CPU time used. `rate(...[5m]) * 100` is CPU % (100 = one core) |
| `deploynow_container_cpu_percent` | gauge | average CPU over the last minute |
| `deploynow_container_memory_usage_bytes` | gauge | memory without page cache |
| `deploynow_container_memory_limit_bytes` | gauge | memory limit (the host's memory when there is none) |
| `deploynow_container_network_receive_bytes_total` / `_transmit_bytes_total` | counter | network traffic |
| `deploynow_container_blkio_read_bytes_total` / `_write_bytes_total` | counter | block device I/O |
| `deploynow_container_pids` | gauge | processes |
| `deploynow_container_last_sample_timestamp_seconds` | gauge | when the container was last sampled |
| `deploynow_host_cpus`, `deploynow_host_load1` | gauge | per endpoint (`endpoint`, `endpoint_id`) |
| `deploynow_host_memory_total_bytes` / `_used_bytes` | gauge | host memory |
| `deploynow_host_disk_total_bytes` / `_used_bytes` | gauge | the Docker data disk |
| `deploynow_endpoint_up` | gauge | 1 when DeployNow can reach the endpoint |
| `deploynow_app_status` | gauge | 1, with the app's `status` (running, failed, stopped, …) as a label |
| `deploynow_alerts_firing` | gauge | alerts firing now, by `kind` |

A container appears while it has a sample from the last three minutes, so stopped containers drop out.

### Useful queries

```promql
# CPU % per app service
sum by (project, app, service) (rate(deploynow_container_cpu_usage_seconds_total[5m])) * 100

# Memory per app
sum by (app) (deploynow_container_memory_usage_bytes{app!=""})

# Network in, bytes per second, per endpoint
sum by (endpoint) (rate(deploynow_container_network_receive_bytes_total[5m]))

# Containers near their memory limit
deploynow_container_memory_usage_bytes / deploynow_container_memory_limit_bytes > 0.9

# Host disk use
deploynow_host_disk_used_bytes / deploynow_host_disk_total_bytes
```
