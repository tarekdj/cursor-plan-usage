/**
 * Cursor plan usage — show Cursor subscription quota from pi (independent of pi-cursor-sdk).
 *
 * /cursor-usage          — plan bars, auto/API split, on-demand spend
 * /cursor-usage json     — same data as JSON (no secrets)
 * /cursor-usage source   — which credential source was used (no tokens)
 *
 * Footer: ctx.ui.setStatus() on the TUI footer row (same as other extension statuses).
 * Refreshes on session_start and agent_end (throttled). Set CURSOR_PLAN_USAGE_FOOTER=0 to disable.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	getAgentDir,
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PERIOD_USAGE_URL =
	"https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const TOKEN_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_BACKOFF_MS = 600_000;

const FOOTER_STATUS_KEY = "cursor-plan-usage";
const FOOTER_REFRESH_MS = Number(process.env.CURSOR_PLAN_USAGE_FOOTER_REFRESH_MS) || 120_000;

type FooterCache = {
	usage?: CursorPlanUsage;
	error?: string;
	at: number;
};

let footerCache: FooterCache | null = null;
let footerRefreshInFlight: Promise<void> | null = null;

type UsageBucket = {
	enabled?: boolean;
	used?: number | null;
	limit?: number | null;
	remaining?: number | null;
	totalPercentUsed?: number | null;
	autoPercentUsed?: number | null;
	apiPercentUsed?: number | null;
};

export type CursorPlanUsage = {
	billingCycleStart?: string;
	billingCycleEnd?: string;
	membershipType?: string;
	source: string;
	api: "period" | "summary";
	individualUsage?: {
		plan?: UsageBucket;
		onDemand?: UsageBucket;
	};
};

type ResolvedToken = { accessToken: string; source: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : value === null ? null : undefined;
}

function parseUsageBucket(raw: unknown): UsageBucket | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const breakdown = isRecord(raw.breakdown)
		? {
				included: finiteNumber(raw.breakdown.included),
				bonus: finiteNumber(raw.breakdown.bonus),
				total: finiteNumber(raw.breakdown.total),
			}
		: undefined;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
		used: finiteNumber(raw.used),
		limit: finiteNumber(raw.limit),
		remaining: finiteNumber(raw.remaining),
		breakdown,
		totalPercentUsed: finiteNumber(raw.totalPercentUsed),
		autoPercentUsed: finiteNumber(raw.autoPercentUsed),
		apiPercentUsed: finiteNumber(raw.apiPercentUsed),
	};
}

function billingInstant(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const n = Number(value);
	if (Number.isFinite(n)) {
		return new Date(n).toISOString();
	}
	return value;
}

function normalizeSummaryResponse(raw: unknown): CursorPlanUsage {
	if (!isRecord(raw)) {
		throw new Error("Cursor usage-summary returned an invalid response");
	}
	return {
		billingCycleStart: typeof raw.billingCycleStart === "string" ? raw.billingCycleStart : undefined,
		billingCycleEnd: typeof raw.billingCycleEnd === "string" ? raw.billingCycleEnd : undefined,
		membershipType: typeof raw.membershipType === "string" ? raw.membershipType : undefined,
		source: "pending",
		api: "summary",
		individualUsage: isRecord(raw.individualUsage)
			? {
					plan: parseUsageBucket(raw.individualUsage.plan),
					onDemand: parseUsageBucket(raw.individualUsage.onDemand),
				}
			: undefined,
	};
}

function normalizePeriodResponse(raw: unknown): CursorPlanUsage {
	if (!isRecord(raw)) {
		throw new Error("Cursor period usage returned an invalid response");
	}
	const planUsage = isRecord(raw.planUsage) ? raw.planUsage : undefined;
	const spendLimit = isRecord(raw.spendLimitUsage) ? raw.spendLimitUsage : undefined;
	const limitType = typeof spendLimit?.limitType === "string" ? spendLimit.limitType : undefined;

	let membershipType = "Pro";
	if (limitType === "team") {
		membershipType = "Team";
	} else if (typeof raw.membershipType === "string") {
		membershipType = raw.membershipType;
	}

	return {
		billingCycleStart: billingInstant(raw.billingCycleStart),
		billingCycleEnd: billingInstant(raw.billingCycleEnd),
		membershipType,
		source: "pending",
		api: "period",
		individualUsage: {
			plan: planUsage
				? {
						enabled: true,
						used: finiteNumber(planUsage.includedSpend),
						limit: finiteNumber(planUsage.limit),
						totalPercentUsed: finiteNumber(planUsage.totalPercentUsed),
						autoPercentUsed: finiteNumber(planUsage.autoPercentUsed),
						apiPercentUsed: finiteNumber(planUsage.apiPercentUsed),
					}
				: undefined,
		},
	};
}

function tokenExpiryMs(accessToken: string): number {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3 || !parts[1]) {
			return Date.now() + 3_600_000;
		}
		const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
			"utf8",
		)) as { exp?: number };
		if (typeof payload.exp === "number") {
			return payload.exp * 1000 - 300_000;
		}
	} catch {
		/* fall through */
	}
	return Date.now() + 3_600_000;
}

function tokenValid(accessToken: string | undefined): accessToken is string {
	if (!accessToken) {
		return false;
	}
	try {
		return Date.now() < tokenExpiryMs(accessToken);
	} catch {
		return false;
	}
}

function allowSystemCredentials(): boolean {
	const raw = process.env.CURSOR_PLAN_USAGE_ALLOW_SYSTEM_CREDENTIALS?.trim().toLowerCase();
	if (!raw) {
		return true;
	}
	return !["0", "false", "off", "no", "deny"].includes(raw);
}

function sessionTokenFromEnv(): string | undefined {
	return (
		process.env.CURSOR_USAGE_SESSION_TOKEN?.trim() ||
		process.env.CURSOR_PLAN_USAGE_SESSION_TOKEN?.trim() ||
		undefined
	);
}

function refreshFailuresPath(): string {
	return join(getAgentDir(), "cursor-plan-usage-refresh-failures.json");
}

function refreshBlocked(refreshToken: string): boolean {
	try {
		const raw = JSON.parse(readFileSync(refreshFailuresPath(), "utf8")) as Record<string, number>;
		const key = createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
		const until = raw[key];
		if (typeof until !== "number") {
			return false;
		}
		if (Date.now() >= until) {
			delete raw[key];
			writeFileSync(refreshFailuresPath(), JSON.stringify(raw), { mode: 0o600 });
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

function markRefreshFailure(refreshToken: string): void {
	try {
		const path = refreshFailuresPath();
		let raw: Record<string, number> = {};
		try {
			raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
		} catch {
			raw = {};
		}
		const key = createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
		raw[key] = Date.now() + REFRESH_BACKOFF_MS;
		writeFileSync(path, JSON.stringify(raw), { mode: 0o600 });
	} catch {
		/* ignore */
	}
}

async function refreshAccessToken(refreshToken: string): Promise<string | undefined> {
	if (refreshBlocked(refreshToken)) {
		return undefined;
	}
	try {
		const res = await fetch(TOKEN_REFRESH_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${refreshToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			markRefreshFailure(refreshToken);
			return undefined;
		}
		const body = (await res.json()) as { accessToken?: string };
		if (typeof body.accessToken !== "string" || !body.accessToken) {
			markRefreshFailure(refreshToken);
			return undefined;
		}
		return body.accessToken;
	} catch {
		markRefreshFailure(refreshToken);
		return undefined;
	}
}

async function readPiOAuthToken(): Promise<ResolvedToken | undefined> {
	const stored = readStoredCredential("cursor");
	if (!stored || stored.type !== "oauth") {
		return undefined;
	}
	if (tokenValid(stored.access)) {
		return { accessToken: stored.access, source: "pi_oauth" };
	}
	if (stored.refresh) {
		const access = await refreshAccessToken(stored.refresh);
		if (access) {
			return { accessToken: access, source: "pi_oauth_refresh" };
		}
	}
	if (stored.access) {
		return { accessToken: stored.access, source: "pi_oauth_stale" };
	}
	return undefined;
}

function readCursorCliAuth(): { accessToken?: string; refreshToken?: string } {
	if (!allowSystemCredentials()) {
		return {};
	}
	const path = join(homedir(), ".config", "cursor", "auth.json");
	if (!existsSync(path)) {
		return {};
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) {
			return {};
		}
		return {
			accessToken: typeof raw.accessToken === "string" ? raw.accessToken.trim() : undefined,
			refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken.trim() : undefined,
		};
	} catch {
		return {};
	}
}

async function readKeychainTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
	if (platform() !== "darwin" || !allowSystemCredentials()) {
		return {};
	}
	const [access, refresh] = await Promise.allSettled([
		execFileAsync("security", ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], {
			encoding: "utf8",
			timeout: 2_000,
		}),
		execFileAsync("security", ["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"], {
			encoding: "utf8",
			timeout: 2_000,
		}),
	]);
	return {
		accessToken: access.status === "fulfilled" ? access.value.stdout.trim() || undefined : undefined,
		refreshToken: refresh.status === "fulfilled" ? refresh.value.stdout.trim() || undefined : undefined,
	};
}

type SqliteDb = {
	prepare: (sql: string) => { get: () => { value?: unknown } | undefined };
	close: () => void;
};

async function readIdeTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
	if (!allowSystemCredentials()) {
		return {};
	}
	let DatabaseSync: new (path: string, opts: { readOnly: boolean }) => SqliteDb;
	try {
		const mod = (await import("sqlite")) as { DatabaseSync: typeof DatabaseSync };
		DatabaseSync = mod.DatabaseSync;
	} catch {
		return {};
	}

	const paths: string[] = [];
	const home = homedir();
	if (platform() === "darwin") {
		paths.push(join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
	} else if (platform() === "win32" && process.env.APPDATA) {
		paths.push(join(process.env.APPDATA, "Cursor/User/globalStorage/state.vscdb"));
	} else {
		paths.push(join(home, ".config/Cursor/User/globalStorage/state.vscdb"));
	}

	const fallback: { accessToken?: string; refreshToken?: string } = {};
	for (const dbPath of paths) {
		if (!existsSync(dbPath)) {
			continue;
		}
		try {
			const db = new DatabaseSync(dbPath, { readOnly: true });
			try {
				const accessRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
				const refreshRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'").get();
				const accessToken =
					typeof accessRow?.value === "string" ? accessRow.value.trim() : undefined;
				const refreshToken =
					typeof refreshRow?.value === "string" ? refreshRow.value.trim() : undefined;
				if (tokenValid(accessToken)) {
					return { accessToken, refreshToken };
				}
				if (!fallback.refreshToken && refreshToken) {
					fallback.refreshToken = refreshToken;
				}
				if (!fallback.accessToken && accessToken) {
					fallback.accessToken = accessToken;
				}
			} finally {
				db.close();
			}
		} catch {
			/* try next path */
		}
	}
	return fallback;
}

export async function resolveCursorAccessToken(): Promise<ResolvedToken | undefined> {
	const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim();
	if (fromEnv && tokenValid(fromEnv)) {
		return { accessToken: fromEnv, source: "env" };
	}

	const piOAuth = await readPiOAuthToken();
	if (piOAuth) {
		return piOAuth;
	}

	if (!allowSystemCredentials()) {
		return undefined;
	}

	const [keychain, ide, cli] = await Promise.all([readKeychainTokens(), readIdeTokens(), readCursorCliAuth()]);

	if (tokenValid(keychain.accessToken)) {
		return { accessToken: keychain.accessToken, source: "cli_keychain" };
	}
	if (tokenValid(ide.accessToken)) {
		return { accessToken: ide.accessToken, source: "ide_vscdb" };
	}
	if (tokenValid(cli.accessToken)) {
		return { accessToken: cli.accessToken, source: "cursor_cli_auth" };
	}

	for (const [refreshToken, source] of [
		[keychain.refreshToken, "cli_keychain_refresh"],
		[ide.refreshToken, "ide_vscdb_refresh"],
		[cli.refreshToken, "cursor_cli_refresh"],
	] as const) {
		if (!refreshToken) {
			continue;
		}
		const access = await refreshAccessToken(refreshToken);
		if (access) {
			return { accessToken: access, source };
		}
	}

	if (fromEnv) {
		return { accessToken: fromEnv, source: "env_stale" };
	}
	return undefined;
}

async function fetchPeriodUsage(accessToken: string): Promise<CursorPlanUsage> {
	const res = await fetch(PERIOD_USAGE_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: "{}",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Cursor period usage HTTP ${res.status}`);
	}
	return normalizePeriodResponse(await res.json());
}

async function fetchSummaryUsage(sessionToken: string): Promise<CursorPlanUsage> {
	const res = await fetch(USAGE_SUMMARY_URL, {
		headers: { Cookie: `WorkosCursorSessionToken=${sessionToken}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Cursor usage-summary HTTP ${res.status}`);
	}
	return normalizeSummaryResponse(await res.json());
}

export async function fetchCursorPlanUsage(): Promise<CursorPlanUsage> {
	const token = await resolveCursorAccessToken();
	if (token) {
		try {
			const usage = await fetchPeriodUsage(token.accessToken);
			usage.source = token.source;
			return usage;
		} catch (err) {
			const session = sessionTokenFromEnv();
			if (session) {
				const usage = await fetchSummaryUsage(session);
				usage.source = `${token.source}+session_fallback`;
				return usage;
			}
			throw err;
		}
	}

	const session = sessionTokenFromEnv();
	if (session) {
		const usage = await fetchSummaryUsage(session);
		usage.source = "session_cookie";
		return usage;
	}

	throw new Error(
		"Not logged in to Cursor for usage. Use Cursor OAuth in pi (/login), sign in with Cursor CLI (~/.config/cursor/auth.json), use Cursor IDE, set CURSOR_ACCESS_TOKEN, or set CURSOR_USAGE_SESSION_TOKEN.",
	);
}

function progressBar(percent: number, width = 20): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatPercent(percent: number | null | undefined): string {
	return percent == null ? "0% used" : `${Math.round(percent)}% used`;
}

function formatCents(cents: number | null | undefined): string {
	return cents == null ? "unlimited" : `$${(cents / 100).toFixed(2)}`;
}

function formatReset(billingCycleEnd: string | undefined): string {
	if (!billingCycleEnd) {
		return "";
	}
	const date = new Date(billingCycleEnd);
	if (Number.isNaN(date.valueOf())) {
		return "";
	}
	return `Resets ${date.getDate()} ${date.toLocaleString("en-US", { month: "short" })}`;
}

function formatResetShort(billingCycleEnd: string | undefined): string | undefined {
	if (!billingCycleEnd) {
		return undefined;
	}
	const date = new Date(billingCycleEnd);
	if (Number.isNaN(date.valueOf())) {
		return undefined;
	}
	return `resets ${date.toLocaleString("en-US", { month: "short" })} ${date.getDate()}`;
}

function footerDisabled(): boolean {
	const raw = process.env.CURSOR_PLAN_USAGE_FOOTER?.trim().toLowerCase();
	return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

function formatPlanPercent(theme: ExtensionContext["ui"]["theme"], percent: number): string {
	const display = `${Math.round(percent)}%`;
	if (percent > 90) {
		return theme.fg("error", display);
	}
	if (percent > 70) {
		return theme.fg("warning", display);
	}
	return display;
}

export function formatCursorPlanUsageFooter(
	usage: CursorPlanUsage,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const plan = usage.individualUsage?.plan;
	const onDemand = usage.individualUsage?.onDemand;
	const parts: string[] = [theme.fg("dim", "Cursor"), `plan ${formatPlanPercent(theme, plan?.totalPercentUsed ?? 0)}`];

	const detail: string[] = [];
	if (plan?.autoPercentUsed != null) {
		detail.push(`auto ${Math.round(plan.autoPercentUsed)}%`);
	}
	if (plan?.apiPercentUsed != null) {
		detail.push(`api ${Math.round(plan.apiPercentUsed)}%`);
	}
	if (detail.length) {
		parts.push(theme.fg("dim", `(${detail.join(" · ")})`));
	}

	parts.push(theme.fg("dim", capitalizePlan(usage.membershipType)));

	const reset = formatResetShort(usage.billingCycleEnd);
	if (reset) {
		parts.push(theme.fg("dim", reset));
	}

	if (onDemand?.enabled && (onDemand.used ?? 0) > 0) {
		parts.push(theme.fg("warning", `on-demand ${formatCents(onDemand.used)}`));
	}

	return parts.join(" ");
}

function publishFooterStatus(ctx: ExtensionContext, cache: FooterCache): void {
	if (!ctx.hasUI || footerDisabled()) {
		return;
	}
	if (cache.usage) {
		ctx.ui.setStatus(FOOTER_STATUS_KEY, formatCursorPlanUsageFooter(cache.usage, ctx.ui.theme));
		return;
	}
	if (cache.error) {
		ctx.ui.setStatus(FOOTER_STATUS_KEY, ctx.ui.theme.fg("dim", "Cursor plan — unavailable"));
	}
}

async function refreshFooterStatus(ctx: ExtensionContext, opts?: { force?: boolean }): Promise<CursorPlanUsage | undefined> {
	if (footerDisabled() || !ctx.hasUI) {
		return footerCache?.usage;
	}

	const now = Date.now();
	if (!opts?.force && footerCache && now - footerCache.at < FOOTER_REFRESH_MS) {
		publishFooterStatus(ctx, footerCache);
		return footerCache.usage;
	}

	if (footerRefreshInFlight) {
		await footerRefreshInFlight;
		return footerCache?.usage;
	}

	footerRefreshInFlight = (async () => {
		ctx.ui.setStatus(FOOTER_STATUS_KEY, ctx.ui.theme.fg("dim", "Cursor plan …"));
		try {
			const usage = await fetchCursorPlanUsage();
			footerCache = { usage, at: Date.now() };
			publishFooterStatus(ctx, footerCache);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			footerCache = { error: message, at: Date.now() };
			publishFooterStatus(ctx, footerCache);
		}
	})().finally(() => {
		footerRefreshInFlight = null;
	});

	await footerRefreshInFlight;
	return footerCache?.usage;
}

function rememberUsageForFooter(ctx: ExtensionContext, usage: CursorPlanUsage): void {
	footerCache = { usage, at: Date.now() };
	publishFooterStatus(ctx, footerCache);
}

function capitalizePlan(name: string | undefined): string {
	if (!name) {
		return "Pro";
	}
	return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatCursorPlanUsage(usage: CursorPlanUsage): string {
	const plan = usage.individualUsage?.plan;
	const onDemand = usage.individualUsage?.onDemand;
	const reset = formatReset(usage.billingCycleEnd);
	const title = `Usage • ${capitalizePlan(usage.membershipType)}`;
	const width = 60;
	const header = reset ? `${title}${reset.padStart(Math.max(1, width - title.length))}` : title;

	const lines = [header, "Monthly plan and on-demand usage", "", "Category        Current          Usage"];

	const total = plan?.totalPercentUsed ?? 0;
	lines.push(`Included        ${formatPercent(total).padEnd(16)}${progressBar(total)}`);
	if (plan?.autoPercentUsed != null) {
		lines.push(`  Auto          ${formatPercent(plan.autoPercentUsed).padEnd(16)}${progressBar(plan.autoPercentUsed)}`);
	}
	if (plan?.apiPercentUsed != null) {
		lines.push(`  API           ${formatPercent(plan.apiPercentUsed).padEnd(16)}${progressBar(plan.apiPercentUsed)}`);
	}

	const onDemandActive = !!(onDemand?.enabled && (onDemand.used ?? 0) > 0);
	lines.push(`On-Demand       ${onDemandActive ? formatCents(onDemand?.used) : "Disabled"}`);
	lines.push("-".repeat(width));
	lines.push(onDemandActive ? `On-demand spend: ${formatCents(onDemand?.used)}` : "On-demand usage is off");
	lines.push("");
	lines.push(`View in dashboard: https://cursor.com/dashboard?tab=usage`);
	lines.push(`(via ${usage.api} API, auth: ${usage.source})`);
	return lines.join("\n");
}

function emit(ctx: ExtensionContext, text: string, level: "info" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
		return;
	}
	if (level === "error") {
		console.error(text);
		return;
	}
	console.log(text);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cursor-usage", {
		description: "Show Cursor subscription plan usage (quota bars, on-demand spend)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "source") {
				const token = await resolveCursorAccessToken();
				if (token) {
					emit(ctx, `Cursor usage auth: ${token.source} (access token present)`, "info");
					return;
				}
				if (sessionTokenFromEnv()) {
					emit(ctx, "Cursor usage auth: session_cookie (CURSOR_USAGE_SESSION_TOKEN)", "info");
					return;
				}
				emit(
					ctx,
					"No Cursor usage credentials found. See the cursor-plan-usage README (Authentication section).",
					"error",
				);
				return;
			}

			try {
				const usage = await fetchCursorPlanUsage();
				rememberUsageForFooter(ctx, usage);
				if (arg === "json") {
					emit(ctx, JSON.stringify(usage, null, 2), "info");
					return;
				}
				emit(ctx, formatCursorPlanUsage(usage), "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				emit(ctx, `Cursor usage unavailable: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshFooterStatus(ctx, { force: true });
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refreshFooterStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
		}
		footerCache = null;
		footerRefreshInFlight = null;
	});
}
