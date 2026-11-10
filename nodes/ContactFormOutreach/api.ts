// The one place that talks to the public API, and the signature check for incoming events.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const BASE = 'https://api.contactformoutreach.com/v1';
// The company register lives on the same host, under its own root.
export const REGISTRY = 'https://api.contactformoutreach.com/v1/registries';
export const CREDENTIAL = 'contactFormOutreachApi';

type Caller = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

// What a person reads when a call is refused: the service's own sentence, never a status code alone.
export function problem(status: number, data: IDataObject | undefined): string {
	const error = data?.error as IDataObject | undefined;
	const said = (error?.message ?? data?.message ?? data?.reason) as string | undefined;
	if (status === 401) return 'The API key was not accepted. Make a new one in Contact Form Outreach.';
	if (status === 403) return said ?? 'This API key is not allowed to do that. It needs the read, write and webhooks permissions.';
	if (status === 402) return said ?? 'There is not enough credit for this.';
	if (status === 429) return 'Contact Form Outreach is limiting requests for this API key right now (429). Nothing more was done. Wait a minute, then run the step again.';
	if (status === 503) return 'Contact Form Outreach is busy right now (503). Nothing more was done. Try again in a minute.';
	return said ?? `Contact Form Outreach answered ${status}.`;
}

// Every write carries its own Idempotency-Key, so a repeat of the same request does the work once.
export async function call(
	ctx: Caller,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
	root: string = BASE,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${root}${path}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		headers: {
			accept: 'application/json',
			'user-agent': 'cfo-automation-connector/1.0',
			...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
		},
		...(body !== undefined ? { body } : {}),
		...(qs ? { qs } : {}),
	};
	const res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, options)) as {
		statusCode: number;
		body: IDataObject | undefined;
	};
	const data = res.body && typeof res.body === 'object' ? res.body : undefined;
	if (res.statusCode >= 400) {
		throw new NodeApiError(ctx.getNode(), (data ?? {}) as JsonObject, {
			message: problem(res.statusCode, data),
			httpCode: String(res.statusCode),
		});
	}
	// A refusal can also come back as 200 with ok:false and a reason.
	if (data && data.ok === false) {
		throw new NodeApiError(ctx.getNode(), data as JsonObject, { message: String(data.reason ?? 'refused') });
	}
	return data ?? {};
}

export function statusOf(e: unknown): number | null {
	const code = (e as { httpCode?: string | number } | null)?.httpCode;
	return code === undefined || code === null ? null : Number(code);
}

// The event, as one flat row a person can map fields from.
export function flatEvent(e: IDataObject): IDataObject {
	const d = (e.data ?? {}) as IDataObject;
	return {
		id: e.id,
		type: e.type,
		happened_at: e.timestamp,
		object: d.object ?? null,
		object_id: d.id ?? null,
		campaign_id: d.campaign_id ?? null,
		state: d.state ?? null,
		previous_state: d.previous_state ?? null,
	};
}

function header(headers: Record<string, unknown>, name: string): string | null {
	for (const [k, v] of Object.entries(headers ?? {})) {
		if (k.toLowerCase() === name) return Array.isArray(v) ? String(v[0]) : String(v);
	}
	return null;
}

// Standard Webhooks v1: HMAC-SHA256 over "id.timestamp.body" with the endpoint's secret. Five minutes of
// clock difference are allowed.
export function signedBy(
	secret: string | undefined,
	headers: Record<string, unknown>,
	body: string | null,
	nowMs = Date.now(),
): boolean {
	const id = header(headers, 'webhook-id');
	const ts = header(headers, 'webhook-timestamp');
	const sig = header(headers, 'webhook-signature');
	if (!secret || !id || !ts || !sig || typeof body !== 'string') return false;
	if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
	const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
	const want = createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest();
	return sig.split(' ').some((part) => {
		const [v, b64] = part.split(',');
		if (v !== 'v1' || !b64) return false;
		const got = Buffer.from(b64, 'base64');
		return got.length === want.length && timingSafeEqual(got, want);
	});
}
