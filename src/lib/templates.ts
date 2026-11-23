/**
 * One-click templates: a ready docker-compose file, the settings it needs
 * (generated passwords become secrets), the service a domain points to and a
 * backup policy that fits the app (a database dump plus the data volumes).
 *
 * A template becomes an ordinary inline-compose app, so everything about it
 * can be changed afterwards like any other app.
 */
import crypto from "crypto";
import YAML from "yaml";
import type { DbEngine } from "./backup/config";

export type Generate = "password" | "hex32" | "base64-64";

export interface TemplateVar {
  key: string;
  label: string;
  /** Default value. {{URL}} and {{DOMAIN}} are filled in from the app's address. */
  default?: string;
  generate?: Generate;
  secret?: boolean;
  /** Shown in the form; otherwise the value is set without asking. */
  ask?: boolean;
  required?: boolean;
  help?: string;
}

export interface AppTemplate {
  id: string;
  name: string;
  category: "Database" | "Automation" | "Analytics" | "CMS" | "Developer" | "Storage" | "Monitoring" | "Productivity";
  description: string;
  website: string;
  compose: string;
  vars: TemplateVar[];
  /** The web interface: where a domain points, or what is published on a host port. */
  web?: { service: string; port: number };
  /** Databases: the port that can be published on the host for other apps to reach. */
  publish?: { service: string; port: number };
  backup?: { db?: { service: string; engine: DbEngine; database?: string }; volumes: string[] };
  /** Shown after the app is created. */
  notes?: string;
}

const pg = (db: string, user = db) => `  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${db}
      POSTGRES_USER: ${user}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${user} -d ${db}"]
      interval: 10s
      timeout: 5s
      retries: 10
`;
const mariadb = (db: string, user = db) => `  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: ${db}
      MARIADB_USER: ${user}
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
`;
const DB_PASSWORD: TemplateVar = { key: "DB_PASSWORD", label: "Database password", generate: "password", secret: true };
const DB_ROOT_PASSWORD: TemplateVar = { key: "DB_ROOT_PASSWORD", label: "Database root password", generate: "password", secret: true };
const ADMIN_PASSWORD: TemplateVar = { key: "ADMIN_PASSWORD", label: "Admin password", generate: "password", secret: true, ask: true, help: "Generated if left empty" };

export const TEMPLATES: AppTemplate[] = [
  // ─── Databases ──────────────────────────────────────────────────────────────
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "Database",
    description: "PostgreSQL 17 with a nightly dump.",
    website: "https://www.postgresql.org",
    compose: `services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
`,
    vars: [
      { key: "POSTGRES_DB", label: "Database", default: "app", ask: true },
      { key: "POSTGRES_USER", label: "User", default: "app", ask: true },
      { key: "POSTGRES_PASSWORD", label: "Password", generate: "password", secret: true, ask: true, help: "Generated if left empty" },
    ],
    publish: { service: "db", port: 5432 },
    backup: { db: { service: "db", engine: "postgres" }, volumes: [] },
  },
  {
    id: "mysql",
    name: "MySQL",
    category: "Database",
    description: "MySQL 8.4 LTS with a nightly dump.",
    website: "https://www.mysql.com",
    compose: `services:
  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: \${MYSQL_DATABASE}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
`,
    vars: [
      { key: "MYSQL_DATABASE", label: "Database", default: "app", ask: true },
      { key: "MYSQL_USER", label: "User", default: "app", ask: true },
      { key: "MYSQL_PASSWORD", label: "Password", generate: "password", secret: true, ask: true, help: "Generated if left empty" },
      { key: "MYSQL_ROOT_PASSWORD", label: "Root password", generate: "password", secret: true },
    ],
    publish: { service: "db", port: 3306 },
    backup: { db: { service: "db", engine: "mysql" }, volumes: [] },
  },
  {
    id: "mariadb",
    name: "MariaDB",
    category: "Database",
    description: "MariaDB 11 with a nightly dump.",
    website: "https://mariadb.org",
    compose: `services:
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: \${MARIADB_DATABASE}
      MARIADB_USER: \${MARIADB_USER}
      MARIADB_PASSWORD: \${MARIADB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}
    volumes:
      - data:/var/lib/mysql
volumes:
  data:
`,
    vars: [
      { key: "MARIADB_DATABASE", label: "Database", default: "app", ask: true },
      { key: "MARIADB_USER", label: "User", default: "app", ask: true },
      { key: "MARIADB_PASSWORD", label: "Password", generate: "password", secret: true, ask: true, help: "Generated if left empty" },
      { key: "MARIADB_ROOT_PASSWORD", label: "Root password", generate: "password", secret: true },
    ],
    publish: { service: "db", port: 3306 },
    backup: { db: { service: "db", engine: "mysql" }, volumes: [] },
  },
  {
    id: "redis",
    name: "Redis",
    category: "Database",
    description: "Redis 7 with a password and append-only persistence.",
    website: "https://redis.io",
    compose: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["sh", "-c", "exec redis-server --appendonly yes --requirepass \\"$$REDIS_PASSWORD\\""]
    environment:
      REDIS_PASSWORD: \${REDIS_PASSWORD}
    volumes:
      - data:/data
volumes:
  data:
`,
    vars: [{ key: "REDIS_PASSWORD", label: "Password", generate: "password", secret: true, ask: true, help: "Generated if left empty" }],
    publish: { service: "redis", port: 6379 },
    backup: { db: { service: "redis", engine: "redis" }, volumes: [] },
  },
  {
    id: "mongo",
    name: "MongoDB",
    category: "Database",
    description: "MongoDB 8 with a root user and a nightly dump.",
    website: "https://www.mongodb.com",
    compose: `services:
  mongo:
    image: mongo:8
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_INITDB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD}
    volumes:
      - data:/data/db
volumes:
  data:
`,
    vars: [
      { key: "MONGO_INITDB_ROOT_USERNAME", label: "Root user", default: "root", ask: true },
      { key: "MONGO_INITDB_ROOT_PASSWORD", label: "Root password", generate: "password", secret: true, ask: true, help: "Generated if left empty" },
    ],
    publish: { service: "mongo", port: 27017 },
    backup: { db: { service: "mongo", engine: "mongo" }, volumes: [] },
  },

  // ─── Automation ─────────────────────────────────────────────────────────────
  {
    id: "n8n",
    name: "n8n",
    category: "Automation",
    description: "Workflow automation with PostgreSQL.",
    website: "https://n8n.io",
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: db
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD: \${DB_PASSWORD}
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      N8N_HOST: \${DOMAIN}
      N8N_PROTOCOL: https
      WEBHOOK_URL: \${PUBLIC_URL}/
      GENERIC_TIMEZONE: \${TZ}
      N8N_RUNNERS_ENABLED: "true"
    volumes:
      - data:/home/node/.n8n
    depends_on:
      db:
        condition: service_healthy
${pg("n8n")}volumes:
  data:
  db:
`,
    vars: [
      { key: "DOMAIN", label: "Domain", default: "{{DOMAIN}}" },
      { key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" },
      { key: "TZ", label: "Time zone", default: "Europe/Sofia", ask: true },
      DB_PASSWORD,
      { key: "N8N_ENCRYPTION_KEY", label: "Encryption key", generate: "hex32", secret: true, help: "Encrypts saved credentials. Keep it with your backups." },
    ],
    web: { service: "n8n", port: 5678 },
    backup: { db: { service: "db", engine: "postgres", database: "n8n" }, volumes: ["data"] },
    notes: "Open the domain to create the owner account.",
  },

  // ─── CMS ────────────────────────────────────────────────────────────────────
  {
    id: "wordpress",
    name: "WordPress",
    category: "CMS",
    description: "WordPress with MariaDB.",
    website: "https://wordpress.org",
    compose: `services:
  wordpress:
    image: wordpress:6-apache
    restart: unless-stopped
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - html:/var/www/html
    depends_on:
      db:
        condition: service_healthy
${mariadb("wordpress")}volumes:
  html:
  db:
`,
    vars: [DB_PASSWORD, DB_ROOT_PASSWORD],
    web: { service: "wordpress", port: 80 },
    backup: { db: { service: "db", engine: "mysql", database: "wordpress" }, volumes: ["html"] },
    notes: "Open the domain to finish the WordPress install.",
  },
  {
    id: "ghost",
    name: "Ghost",
    category: "CMS",
    description: "Ghost publishing platform with MySQL.",
    website: "https://ghost.org",
    compose: `services:
  ghost:
    image: ghost:6-alpine
    restart: unless-stopped
    environment:
      url: \${PUBLIC_URL}
      database__client: mysql
      database__connection__host: db
      database__connection__user: ghost
      database__connection__password: \${DB_PASSWORD}
      database__connection__database: ghost
    volumes:
      - content:/var/lib/ghost/content
    depends_on:
      db:
        condition: service_healthy
  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD: \${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p\\"$$MYSQL_ROOT_PASSWORD\\" --silent"]
      interval: 10s
      timeout: 5s
      retries: 20
volumes:
  content:
  db:
`,
    vars: [{ key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" }, DB_PASSWORD, DB_ROOT_PASSWORD],
    web: { service: "ghost", port: 2368 },
    backup: { db: { service: "db", engine: "mysql", database: "ghost" }, volumes: ["content"] },
    notes: "Open /ghost on the domain to create the admin account.",
  },
  {
    id: "directus",
    name: "Directus",
    category: "CMS",
    description: "Headless CMS and data API on PostgreSQL.",
    website: "https://directus.io",
    compose: `services:
  directus:
    image: directus/directus:11
    restart: unless-stopped
    environment:
      SECRET: \${SECRET}
      PUBLIC_URL: \${PUBLIC_URL}
      DB_CLIENT: pg
      DB_HOST: db
      DB_PORT: "5432"
      DB_DATABASE: directus
      DB_USER: directus
      DB_PASSWORD: \${DB_PASSWORD}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - uploads:/directus/uploads
      - extensions:/directus/extensions
    depends_on:
      db:
        condition: service_healthy
${pg("directus")}volumes:
  uploads:
  extensions:
  db:
`,
    vars: [
      { key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" },
      { key: "ADMIN_EMAIL", label: "Admin email", default: "admin@example.com", ask: true, required: true },
      ADMIN_PASSWORD,
      { key: "SECRET", label: "Secret", generate: "hex32", secret: true },
      DB_PASSWORD,
    ],
    web: { service: "directus", port: 8055 },
    backup: { db: { service: "db", engine: "postgres", database: "directus" }, volumes: ["uploads", "extensions"] },
  },

  // ─── Analytics ──────────────────────────────────────────────────────────────
  {
    id: "plausible",
    name: "Plausible Analytics",
    category: "Analytics",
    description: "Privacy-friendly web analytics (Community Edition) with PostgreSQL and ClickHouse.",
    website: "https://plausible.io",
    compose: `services:
  plausible:
    image: ghcr.io/plausible/community-edition:v2.1
    restart: unless-stopped
    command: sh -c "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run"
    environment:
      BASE_URL: \${PUBLIC_URL}
      SECRET_KEY_BASE: \${SECRET_KEY_BASE}
      DATABASE_URL: postgres://plausible:\${DB_PASSWORD}@db:5432/plausible
      CLICKHOUSE_DATABASE_URL: http://events:8123/plausible_events
      DISABLE_REGISTRATION: invite_only
    volumes:
      - data:/var/lib/plausible
    depends_on:
      db:
        condition: service_healthy
      events:
        condition: service_healthy
${pg("plausible")}  events:
    image: clickhouse/clickhouse-server:24.12-alpine
    restart: unless-stopped
    environment:
      CLICKHOUSE_SKIP_USER_SETUP: "1"
    volumes:
      - events:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 -O - http://127.0.0.1:8123/ping || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 20
volumes:
  data:
  db:
  events:
`,
    vars: [
      { key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" },
      { key: "SECRET_KEY_BASE", label: "Secret key", generate: "base64-64", secret: true },
      DB_PASSWORD,
    ],
    web: { service: "plausible", port: 8000 },
    backup: { db: { service: "db", engine: "postgres", database: "plausible" }, volumes: ["events"] },
    notes: "Open the domain to register the first account; later sign-ups need an invite.",
  },
  {
    id: "umami",
    name: "Umami",
    category: "Analytics",
    description: "Simple, privacy-focused web analytics with PostgreSQL.",
    website: "https://umami.is",
    compose: `services:
  umami:
    image: ghcr.io/umami-software/umami:postgresql-latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://umami:\${DB_PASSWORD}@db:5432/umami
      APP_SECRET: \${APP_SECRET}
    depends_on:
      db:
        condition: service_healthy
${pg("umami")}volumes:
  db:
`,
    vars: [{ key: "APP_SECRET", label: "App secret", generate: "hex32", secret: true }, DB_PASSWORD],
    web: { service: "umami", port: 3000 },
    backup: { db: { service: "db", engine: "postgres", database: "umami" }, volumes: [] },
    notes: "Sign in with admin / umami and change the password right away.",
  },
  {
    id: "metabase",
    name: "Metabase",
    category: "Analytics",
    description: "Business intelligence dashboards, with its settings in PostgreSQL.",
    website: "https://www.metabase.com",
    compose: `services:
  metabase:
    image: metabase/metabase:latest
    restart: unless-stopped
    environment:
      MB_DB_TYPE: postgres
      MB_DB_HOST: db
      MB_DB_PORT: "5432"
      MB_DB_DBNAME: metabase
      MB_DB_USER: metabase
      MB_DB_PASS: \${DB_PASSWORD}
      MB_SITE_URL: \${PUBLIC_URL}
    depends_on:
      db:
        condition: service_healthy
${pg("metabase")}volumes:
  db:
`,
    vars: [{ key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" }, DB_PASSWORD],
    web: { service: "metabase", port: 3000 },
    backup: { db: { service: "db", engine: "postgres", database: "metabase" }, volumes: [] },
  },
  {
    id: "grafana",
    name: "Grafana",
    category: "Monitoring",
    description: "Dashboards for metrics and logs. Point it at DeployNow's /api/metrics.",
    website: "https://grafana.com",
    compose: `services:
  grafana:
    image: grafana/grafana-oss:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      GF_SERVER_ROOT_URL: \${PUBLIC_URL}
    volumes:
      - data:/var/lib/grafana
volumes:
  data:
`,
    vars: [{ key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" }, ADMIN_PASSWORD],
    web: { service: "grafana", port: 3000 },
    backup: { volumes: ["data"] },
    notes: "Sign in as admin with the admin password from the app's settings.",
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Monitoring",
    description: "Self-hosted status pages and uptime checks.",
    website: "https://uptime.kuma.pet",
    compose: `services:
  kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - data:/app/data
volumes:
  data:
`,
    vars: [],
    web: { service: "kuma", port: 3001 },
    backup: { volumes: ["data"] },
    notes: "Open the domain to create the admin account.",
  },

  // ─── Developer ──────────────────────────────────────────────────────────────
  {
    id: "gitea",
    name: "Gitea",
    category: "Developer",
    description: "Lightweight Git hosting with PostgreSQL.",
    website: "https://about.gitea.com",
    compose: `services:
  gitea:
    image: gitea/gitea:1
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: db:5432
      GITEA__database__NAME: gitea
      GITEA__database__USER: gitea
      GITEA__database__PASSWD: \${DB_PASSWORD}
      GITEA__server__ROOT_URL: \${PUBLIC_URL}/
      GITEA__server__DOMAIN: \${DOMAIN}
    volumes:
      - data:/data
    depends_on:
      db:
        condition: service_healthy
${pg("gitea")}volumes:
  data:
  db:
`,
    vars: [{ key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" }, { key: "DOMAIN", label: "Domain", default: "{{DOMAIN}}" }, DB_PASSWORD],
    web: { service: "gitea", port: 3000 },
    backup: { db: { service: "db", engine: "postgres", database: "gitea" }, volumes: ["data"] },
    notes: "Open the domain to finish the install; the first account becomes the admin.",
  },
  {
    id: "adminer",
    name: "Adminer",
    category: "Developer",
    description: "Database manager in one page, for PostgreSQL, MySQL and more.",
    website: "https://www.adminer.org",
    compose: `services:
  adminer:
    image: adminer:latest
    restart: unless-stopped
`,
    vars: [],
    web: { service: "adminer", port: 8080 },
    notes: "Adminer can reach databases published on a host port. Protect the domain with basic auth.",
  },
  {
    id: "pgadmin",
    name: "pgAdmin",
    category: "Developer",
    description: "The PostgreSQL admin tool.",
    website: "https://www.pgadmin.org",
    compose: `services:
  pgadmin:
    image: dpage/pgadmin4:latest
    restart: unless-stopped
    environment:
      PGADMIN_DEFAULT_EMAIL: \${ADMIN_EMAIL}
      PGADMIN_DEFAULT_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - data:/var/lib/pgadmin
volumes:
  data:
`,
    vars: [{ key: "ADMIN_EMAIL", label: "Admin email", default: "admin@example.com", ask: true, required: true }, ADMIN_PASSWORD],
    web: { service: "pgadmin", port: 80 },
    backup: { volumes: ["data"] },
  },
  {
    id: "mailpit",
    name: "Mailpit",
    category: "Developer",
    description: "Catches outgoing email from test apps (SMTP on 1025) and shows it in a web inbox.",
    website: "https://mailpit.axllent.org",
    compose: `services:
  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
`,
    vars: [],
    web: { service: "mailpit", port: 8025 },
    publish: { service: "mailpit", port: 1025 },
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    category: "Developer",
    description: "Message broker with the management UI.",
    website: "https://www.rabbitmq.com",
    compose: `services:
  rabbitmq:
    image: rabbitmq:4-management
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: \${RABBITMQ_DEFAULT_USER}
      RABBITMQ_DEFAULT_PASS: \${RABBITMQ_DEFAULT_PASS}
    volumes:
      - data:/var/lib/rabbitmq
volumes:
  data:
`,
    vars: [
      { key: "RABBITMQ_DEFAULT_USER", label: "User", default: "admin", ask: true },
      { key: "RABBITMQ_DEFAULT_PASS", label: "Password", generate: "password", secret: true, ask: true, help: "Generated if left empty" },
    ],
    web: { service: "rabbitmq", port: 15672 },
    publish: { service: "rabbitmq", port: 5672 },
    backup: { volumes: ["data"] },
  },
  {
    id: "meilisearch",
    name: "Meilisearch",
    category: "Developer",
    description: "Fast search API with a master key.",
    website: "https://www.meilisearch.com",
    compose: `services:
  meilisearch:
    image: getmeili/meilisearch:v1.11
    restart: unless-stopped
    environment:
      MEILI_ENV: production
      MEILI_MASTER_KEY: \${MEILI_MASTER_KEY}
    volumes:
      - data:/meili_data
volumes:
  data:
`,
    vars: [{ key: "MEILI_MASTER_KEY", label: "Master key", generate: "hex32", secret: true }],
    web: { service: "meilisearch", port: 7700 },
    backup: { volumes: ["data"] },
  },

  // ─── Productivity / storage ─────────────────────────────────────────────────
  {
    id: "nocodb",
    name: "NocoDB",
    category: "Productivity",
    description: "Spreadsheet-style database app (an Airtable alternative) on PostgreSQL.",
    website: "https://nocodb.com",
    compose: `services:
  nocodb:
    image: nocodb/nocodb:latest
    restart: unless-stopped
    environment:
      NC_DB: pg://db:5432?u=nocodb&p=\${DB_PASSWORD}&d=nocodb
      NC_AUTH_JWT_SECRET: \${JWT_SECRET}
      NC_PUBLIC_URL: \${PUBLIC_URL}
    volumes:
      - data:/usr/app/data
    depends_on:
      db:
        condition: service_healthy
${pg("nocodb")}volumes:
  data:
  db:
`,
    vars: [{ key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" }, { key: "JWT_SECRET", label: "JWT secret", generate: "hex32", secret: true }, DB_PASSWORD],
    web: { service: "nocodb", port: 8080 },
    backup: { db: { service: "db", engine: "postgres", database: "nocodb" }, volumes: ["data"] },
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    category: "Productivity",
    description: "Password manager compatible with the Bitwarden apps.",
    website: "https://github.com/dani-garcia/vaultwarden",
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:latest
    restart: unless-stopped
    environment:
      DOMAIN: \${PUBLIC_URL}
      SIGNUPS_ALLOWED: \${SIGNUPS_ALLOWED}
    volumes:
      - data:/data
volumes:
  data:
`,
    vars: [
      { key: "PUBLIC_URL", label: "Public URL", default: "{{URL}}" },
      { key: "SIGNUPS_ALLOWED", label: "Allow sign-ups", default: "true", ask: true, help: "Set to false after creating your accounts" },
    ],
    web: { service: "vaultwarden", port: 80 },
    backup: { volumes: ["data"] },
    notes: "Bitwarden apps need HTTPS: add the domain with HTTPS on.",
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    category: "Storage",
    description: "Files, calendar and contacts, with MariaDB and Redis.",
    website: "https://nextcloud.com",
    compose: `services:
  nextcloud:
    image: nextcloud:apache
    restart: unless-stopped
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: \${DB_PASSWORD}
      REDIS_HOST: redis
      NEXTCLOUD_ADMIN_USER: admin
      NEXTCLOUD_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: \${DOMAIN}
      OVERWRITEPROTOCOL: https
    volumes:
      - html:/var/www/html
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
${mariadb("nextcloud")}  redis:
    image: redis:7-alpine
    restart: unless-stopped
volumes:
  html:
  db:
`,
    vars: [{ key: "DOMAIN", label: "Domain", default: "{{DOMAIN}}" }, ADMIN_PASSWORD, DB_PASSWORD, DB_ROOT_PASSWORD],
    web: { service: "nextcloud", port: 80 },
    backup: { db: { service: "db", engine: "mysql", database: "nextcloud" }, volumes: ["html"] },
    notes: "Sign in as admin. The first start takes a minute while Nextcloud installs.",
  },
];

export class TemplateError extends Error {}

export function findTemplate(id: string): AppTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** What the browser needs to show the catalogue and the form. */
export function templateForClient(t: AppTemplate) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    description: t.description,
    website: t.website,
    web: t.web ?? null,
    publish: t.publish ?? null,
    backup: !!t.backup && (!!t.backup.db || t.backup.volumes.length > 0),
    notes: t.notes ?? "",
    vars: t.vars.filter((v) => v.ask).map((v) => ({ key: v.key, label: v.label, default: v.default ?? "", secret: !!v.secret, generated: !!v.generate, required: !!v.required, help: v.help ?? "" })),
    compose: t.compose,
  };
}

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateValue(kind: Generate): string {
  if (kind === "hex32") return crypto.randomBytes(32).toString("hex");
  if (kind === "base64-64") return crypto.randomBytes(64).toString("base64");
  // Letters and digits only, so the value is safe in URLs, YAML and shells
  const bytes = crypto.randomBytes(64);
  let out = "";
  for (let i = 0; out.length < 32 && i < bytes.length; i++) if (bytes[i] < 248) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

export interface InstantiateOptions {
  slug: string;
  /** A domain routed through the edge proxy to the web service. */
  domain?: string;
  https?: boolean;
  /** Publish the web (or database) port on this host port instead. */
  hostPort?: number | null;
  /** The endpoint's address, for the URL when there is no domain. */
  serverHost?: string;
  values?: Record<string, unknown>;
}

export interface Instantiated {
  composeInline: string;
  env: { key: string; kind: "plain" | "secret"; value: string }[];
  domain: { host: string; containerPort: number; service: string; https: boolean } | null;
  backupSources: ({ type: "db"; engine: DbEngine; container: string; database?: string } | { type: "volume"; name: string })[];
  backupMode: "dump" | "live";
}

/** Turn a template and the form's answers into an inline compose app. */
export function instantiate(t: AppTemplate, opts: InstantiateOptions): Instantiated {
  const values = opts.values ?? {};
  const domain = opts.domain?.trim().toLowerCase() || "";
  if (domain && !t.web) throw new TemplateError(`${t.name} has no web interface to point a domain at`);
  const target = t.web ?? t.publish;
  const hostPort = opts.hostPort ?? null;
  if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)) throw new TemplateError("The host port must be between 1 and 65535");
  if (hostPort !== null && !target) throw new TemplateError(`${t.name} has no port to publish`);
  const scheme = opts.https === false ? "http" : "https";
  const host = domain || opts.serverHost || "localhost";
  const url = domain ? `${scheme}://${domain}` : `http://${host}${hostPort ? `:${hostPort}` : ""}`;

  const env: Instantiated["env"] = [];
  for (const v of t.vars) {
    const given = v.ask && values[v.key] !== undefined && values[v.key] !== null ? String(values[v.key]).trim() : "";
    if (given.length > 4096) throw new TemplateError(`${v.label} is too long`);
    if (given && /[\r\n]/.test(given)) throw new TemplateError(`${v.label} must be one line`);
    let value = given || (v.default ?? "").replace(/\{\{URL\}\}/g, url).replace(/\{\{DOMAIN\}\}/g, host);
    if (!value && v.generate) value = generateValue(v.generate);
    if (!value && v.required) throw new TemplateError(`Enter ${v.label.toLowerCase()}`);
    env.push({ key: v.key, kind: v.secret ? "secret" : "plain", value });
  }

  let composeInline = t.compose;
  if (hostPort !== null && target) {
    const doc = YAML.parseDocument(t.compose);
    doc.setIn(["services", target.service, "ports"], doc.createNode([`${hostPort}:${target.port}`]));
    composeInline = doc.toString({ lineWidth: 0 });
  }

  const backupSources: Instantiated["backupSources"] = [];
  if (t.backup?.db) {
    // Compose names containers <project>-<service>-1, and the project is the app's slug
    backupSources.push({ type: "db", engine: t.backup.db.engine, container: `${opts.slug}-${t.backup.db.service}-1`, ...(t.backup.db.database ? { database: t.backup.db.database } : {}) });
  }
  for (const vol of t.backup?.volumes ?? []) backupSources.push({ type: "volume", name: `${opts.slug}_${vol}` });

  return {
    composeInline,
    env,
    domain: domain && t.web ? { host: domain, containerPort: t.web.port, service: t.web.service, https: opts.https !== false } : null,
    backupSources,
    backupMode: t.backup?.db ? "dump" : "live",
  };
}
